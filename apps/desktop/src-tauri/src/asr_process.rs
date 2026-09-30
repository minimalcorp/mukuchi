//! 本番の ASR サーバーのプロセス管理 (docs/architecture.md「本番の ASR サーバー起動」)。
//!
//! `<データ>/venv/bin/python -m mukuchi_asr --port <空きポート> --model <スナップショット> --exit-on-stdin-eof`
//! を stdin をパイプにして起動する。アプリが異常終了してもパイプが閉じてサーバーが終わる (孤児にならない)。
//! /health が応答するまでを読み込み中とし、異常終了時は3回まで自動で起動し直す。

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use tokio::sync::watch;

use crate::asr::HttpAsrClient;

/// 異常終了時に自動で起動し直す回数
const MAX_RESTARTS: u32 = 3;
/// この時間以上動き続けた後の異常終了は、連続した失敗として数えない
const STABLE_AFTER: Duration = Duration::from_secs(10 * 60);
/// 読み込み (起動から /health の応答まで) の上限。初回はコンパイル等で遅い
const LOAD_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// 停止の依頼 (stdin を閉じる) から強制終了までの猶予
const STOP_GRACE: Duration = Duration::from_secs(3);
/// ログがこの大きさを超えたら1世代だけ残して新しくする
const LOG_ROTATE_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchSpec {
    pub python: PathBuf,
    /// `--model` (スナップショットのディレクトリ)
    pub model_dir: PathBuf,
    /// HF_HOME
    pub hf_home: PathBuf,
    /// 作業ディレクトリ (venv。PYTHONSAFEPATH と合わせ、データディレクトリ直下のファイルを import しないため)
    pub cwd: PathBuf,
    pub log_file: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AsrEvent {
    /// 起動した (読み込み中)
    Starting,
    /// /health が応答した。値はベース URL
    Ready(String),
    /// 異常終了した。`will_restart` なら自動で起動し直す
    Crashed { will_restart: bool, detail: String },
    /// 依頼により停止した
    Stopped,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum State {
    Idle,
    Starting,
    Ready(String),
    Failed(String),
}

type Listener = Arc<dyn Fn(AsrEvent) + Send + Sync>;

struct Current {
    generation: u64,
    stop: watch::Sender<bool>,
    finished: watch::Receiver<bool>,
}

pub struct AsrProcess {
    current: Mutex<Option<Current>>,
    generation: Mutex<u64>,
    state: watch::Sender<(u64, State)>,
    auto_restart: AtomicBool,
    listener: Mutex<Option<Listener>>,
}

impl Default for AsrProcess {
    fn default() -> Self {
        Self::new()
    }
}

impl AsrProcess {
    pub fn new() -> Self {
        Self {
            current: Mutex::new(None),
            generation: Mutex::new(0),
            state: watch::channel((0, State::Idle)).0,
            auto_restart: AtomicBool::new(true),
            listener: Mutex::new(None),
        }
    }

    pub fn subscribe(&self, f: impl Fn(AsrEvent) + Send + Sync + 'static) {
        *lock(&self.listener) = Some(Arc::new(f));
    }

    fn notify(&self, ev: AsrEvent) {
        let l = lock(&self.listener).clone();
        if let Some(l) = l {
            l(ev);
        }
    }

    pub fn set_auto_restart(&self, on: bool) {
        self.auto_restart.store(on, Ordering::SeqCst);
    }

    pub fn is_running(&self) -> bool {
        lock(&self.current)
            .as_ref()
            .is_some_and(|c| !*c.finished.borrow())
    }

    /// 起動する。動いているものがあれば止めてから起動し直す (restart_asr)。
    pub async fn start(self: &Arc<Self>, spec: LaunchSpec, auto_restart: bool) {
        self.stop_quietly().await;
        self.set_auto_restart(auto_restart);
        let generation = {
            let mut g = lock(&self.generation);
            *g += 1;
            *g
        };
        let (stop_tx, stop_rx) = watch::channel(false);
        let (fin_tx, fin_rx) = watch::channel(false);
        *lock(&self.current) = Some(Current {
            generation,
            stop: stop_tx,
            finished: fin_rx,
        });
        self.state.send_replace((generation, State::Starting));
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            this.supervise(generation, spec, stop_rx).await;
            let _ = fin_tx.send(true);
        });
    }

    /// 起動中のサーバーの準備完了 (/health の応答) を待ち、ベース URL を返す。
    /// 起動に失敗した・止められた場合はエラー。`cancel` が true になったら待つのをやめる
    pub async fn wait_ready(&self, mut cancel: watch::Receiver<bool>) -> Result<String> {
        let mut rx = self.state.subscribe();
        let generation = rx.borrow().0;
        loop {
            {
                let (g, s) = &*rx.borrow_and_update();
                if *g != generation {
                    anyhow::bail!("文字起こしサーバーが別の起動に置き換わりました");
                }
                match s {
                    State::Ready(url) => return Ok(url.clone()),
                    State::Failed(detail) => anyhow::bail!("{detail}"),
                    State::Idle => anyhow::bail!("文字起こしサーバーが停止しました"),
                    State::Starting => {}
                }
            }
            tokio::select! {
                r = rx.changed() => r.context("状態を受け取れません")?,
                _ = until_true(&mut cancel) => anyhow::bail!("中断しました"),
            }
        }
    }

    /// 止める (終了を待つ)。`Stopped` を通知する
    pub async fn stop(&self) {
        if self.stop_quietly().await {
            self.notify(AsrEvent::Stopped);
        }
    }

    /// 止める。動いていたかを返す
    async fn stop_quietly(&self) -> bool {
        let current = lock(&self.current).take();
        let Some(c) = current else {
            return false;
        };
        let _ = c.stop.send(true);
        let mut fin = c.finished;
        let _ = tokio::time::timeout(STOP_GRACE * 2, until_true(&mut fin)).await;
        self.state.send_replace((c.generation, State::Idle));
        true
    }

    /// アプリの終了時。async ランタイムの外 (イベントループ) から呼ぶため同期で待つ。
    /// ここで止めきれなくても、アプリの終了で stdin が閉じてサーバーは終わる
    pub fn shutdown_blocking(&self) {
        let current = lock(&self.current).take();
        let Some(c) = current else {
            return;
        };
        let _ = c.stop.send(true);
        let deadline = Instant::now() + STOP_GRACE + Duration::from_millis(500);
        while !*c.finished.borrow() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    async fn supervise(&self, generation: u64, spec: LaunchSpec, mut stop: watch::Receiver<bool>) {
        let mut crashes = 0u32;
        loop {
            self.state.send_replace((generation, State::Starting));
            self.notify(AsrEvent::Starting);
            let started = Instant::now();
            match self.run_once(generation, &spec, &mut stop).await {
                Exit::Stopped => return,
                Exit::Crashed { detail, ready_for } => {
                    log::error!("文字起こしサーバーが異常終了: {detail}");
                    if ready_for.is_some_and(|d| d >= STABLE_AFTER) {
                        crashes = 0;
                    }
                    crashes += 1;
                    let will_restart =
                        self.auto_restart.load(Ordering::SeqCst) && crashes <= MAX_RESTARTS;
                    self.notify(AsrEvent::Crashed {
                        will_restart,
                        detail: detail.clone(),
                    });
                    if !will_restart {
                        self.state.send_replace((generation, State::Failed(detail)));
                        return;
                    }
                    log::info!(
                        "文字起こしサーバーを起動し直す ({crashes}/{MAX_RESTARTS}回目、前回 {}秒)",
                        started.elapsed().as_secs()
                    );
                    tokio::select! {
                        _ = tokio::time::sleep(Duration::from_secs(1)) => {}
                        _ = until_true(&mut stop) => return,
                    }
                }
            }
        }
    }

    async fn run_once(
        &self,
        generation: u64,
        spec: &LaunchSpec,
        stop: &mut watch::Receiver<bool>,
    ) -> Exit {
        let (mut child, url) = match spawn(spec) {
            Ok(c) => c,
            Err(e) => {
                return Exit::Crashed {
                    detail: format!("{e:#}"),
                    ready_for: None,
                }
            }
        };
        // stdin はここで持ち続ける。閉じるとサーバーが終了する (--exit-on-stdin-eof)
        let stdin = child.stdin.take();
        let client = match HttpAsrClient::new(url.clone()) {
            Ok(c) => c,
            Err(e) => {
                let _ = child.kill().await;
                return Exit::Crashed {
                    detail: format!("{e:#}"),
                    ready_for: None,
                };
            }
        };
        let started = Instant::now();
        let mut ready_at: Option<Instant> = None;
        loop {
            tokio::select! {
                status = child.wait() => {
                    let detail = match status {
                        Ok(s) => format!("終了しました ({s})"),
                        Err(e) => format!("終了を確認できません: {e}"),
                    };
                    return Exit::Crashed { detail, ready_for: ready_at.map(|t| t.elapsed()) };
                }
                _ = until_true(stop) => {
                    drop(stdin);
                    if tokio::time::timeout(STOP_GRACE, child.wait()).await.is_err() {
                        log::warn!("文字起こしサーバーが終了しないため強制終了する");
                        let _ = child.kill().await;
                    }
                    log::info!("文字起こしサーバーを停止");
                    return Exit::Stopped;
                }
                ok = async {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    client.health().await.is_ok()
                }, if ready_at.is_none() => {
                    if ok {
                        log::info!("文字起こしサーバー準備完了 ({}秒)", started.elapsed().as_secs());
                        ready_at = Some(Instant::now());
                        self.state.send_replace((generation, State::Ready(url.clone())));
                        self.notify(AsrEvent::Ready(url.clone()));
                    } else if started.elapsed() > LOAD_TIMEOUT {
                        let _ = child.kill().await;
                        return Exit::Crashed {
                            detail: "モデルの読み込みが終わりません".into(),
                            ready_for: None,
                        };
                    }
                }
            }
        }
    }
}

enum Exit {
    Stopped,
    Crashed {
        detail: String,
        ready_for: Option<Duration>,
    },
}

fn spawn(spec: &LaunchSpec) -> Result<(tokio::process::Child, String)> {
    if !spec.python.exists() {
        anyhow::bail!("実行環境がありません: {}", spec.python.display());
    }
    let port = free_port()?;
    let log = open_log(&spec.log_file)?;
    let log_err = log.try_clone()?;
    let mut cmd = tokio::process::Command::new(&spec.python);
    cmd.arg("-m")
        .arg("mukuchi_asr")
        .arg("--port")
        .arg(port.to_string())
        .arg("--model")
        .arg(&spec.model_dir)
        .arg("--exit-on-stdin-eof")
        .current_dir(&spec.cwd)
        // 環境変数は引き継がず必要なものだけ渡す (利用者・開発環境の PYTHONPATH・DYLD_*・HF_* 等を持ち込まない)
        .env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .env("PYTHONNOUSERSITE", "1")
        // -m で cwd を sys.path に入れない (パッケージは venv に入っている)
        .env("PYTHONSAFEPATH", "1")
        .env("HF_HOME", &spec.hf_home)
        .env("HF_HUB_OFFLINE", "1")
        .env("HF_HUB_DISABLE_TELEMETRY", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err))
        .kill_on_drop(true);
    for (key, value) in std::env::vars_os() {
        if pass_env(&key) {
            cmd.env(key, value);
        }
    }
    let child = cmd
        .spawn()
        .with_context(|| format!("起動できません: {}", spec.python.display()))?;
    log::info!("文字起こしサーバーを起動: pid={:?} port={port}", child.id());
    Ok((child, format!("http://127.0.0.1:{port}")))
}

/// ASR サーバーに引き継ぐ環境変数。サーバーはオフライン (HF_HUB_OFFLINE) でループバックだけを使うためプロキシは渡さない
fn pass_env(key: &std::ffi::OsStr) -> bool {
    let Some(k) = key.to_str() else {
        return false;
    };
    matches!(k, "HOME" | "USER" | "LOGNAME" | "TMPDIR" | "LANG") || k.starts_with("LC_")
}

/// 空いているポート。OS に選ばせてすぐ閉じる (サーバーが同じポートを取るまでに他に取られた場合は
/// サーバーが起動に失敗し、自動の起動し直しで別のポートを選ぶ)
pub fn free_port() -> Result<u16> {
    let l = std::net::TcpListener::bind(("127.0.0.1", 0)).context("空きポートを取得できません")?;
    Ok(l.local_addr()?.port())
}

/// 追記用にログを開く。`LOG_ROTATE_BYTES` を超えていたら `.1` に1世代だけ残して新しくする
pub(crate) fn open_log(path: &std::path::Path) -> Result<std::fs::File> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    if std::fs::metadata(path).is_ok_and(|m| m.len() > LOG_ROTATE_BYTES) {
        let mut old = path.as_os_str().to_owned();
        old.push(".1");
        let _ = std::fs::rename(path, old);
    }
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| anyhow!(e).context(format!("ログを開けません: {}", path.display())))
}

/// watch の値が true になるまで待つ (送り手がなくなったら戻る)。
/// `wait_for` の戻り値 (読み取りロック) を await をまたいで持たないよう、ここで捨てる
pub async fn until_true(rx: &mut watch::Receiver<bool>) {
    let _ = rx.wait_for(|v| *v).await;
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// python の代わりに sh スクリプトで「起動してすぐ落ちる」サーバーを作る
    fn spec(dir: &std::path::Path, script: &str) -> LaunchSpec {
        let py = dir.join("python");
        std::fs::write(&py, format!("#!/bin/sh\n{script}\n")).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&py, std::fs::Permissions::from_mode(0o755)).unwrap();
        LaunchSpec {
            python: py,
            model_dir: dir.into(),
            hf_home: dir.into(),
            cwd: dir.into(),
            log_file: dir.join("logs/asr-server.log"),
        }
    }

    #[test]
    fn crashes_restart_up_to_limit() {
        tauri::async_runtime::block_on(async {
            let tmp = tempfile::tempdir().unwrap();
            let p = Arc::new(AsrProcess::new());
            let events = Arc::new(Mutex::new(Vec::new()));
            let ev = events.clone();
            p.subscribe(move |e| ev.lock().unwrap().push(e));
            p.start(spec(tmp.path(), "echo boom; exit 3"), true).await;
            let (_tx, rx) = watch::channel(false);
            let err = tokio::time::timeout(Duration::from_secs(20), p.wait_ready(rx))
                .await
                .unwrap()
                .unwrap_err();
            assert!(format!("{err:#}").contains("終了"), "{err:#}");
            let ev = events.lock().unwrap().clone();
            let crashes: Vec<bool> = ev
                .iter()
                .filter_map(|e| match e {
                    AsrEvent::Crashed { will_restart, .. } => Some(*will_restart),
                    _ => None,
                })
                .collect();
            assert_eq!(crashes, vec![true, true, true, false]);
            assert_eq!(ev.iter().filter(|e| **e == AsrEvent::Starting).count(), 4);
            // 出力はログへ
            let log = std::fs::read_to_string(tmp.path().join("logs/asr-server.log")).unwrap();
            assert_eq!(log.matches("boom").count(), 4);
        });
    }

    #[test]
    fn stop_closes_stdin_and_does_not_restart() {
        tauri::async_runtime::block_on(async {
            let tmp = tempfile::tempdir().unwrap();
            let p = Arc::new(AsrProcess::new());
            let events = Arc::new(Mutex::new(Vec::new()));
            let ev = events.clone();
            p.subscribe(move |e| ev.lock().unwrap().push(e));
            // stdin が閉じるまで終わらない (--exit-on-stdin-eof の代わり)
            p.start(spec(tmp.path(), "cat >/dev/null; echo eof"), true)
                .await;
            tokio::time::sleep(Duration::from_millis(300)).await;
            assert!(p.is_running());
            let t = Instant::now();
            p.stop().await;
            assert!(t.elapsed() < STOP_GRACE, "stdin を閉じて終わるはず");
            assert!(!p.is_running());
            let ev = events.lock().unwrap().clone();
            assert_eq!(ev, vec![AsrEvent::Starting, AsrEvent::Stopped]);
            let log = std::fs::read_to_string(tmp.path().join("logs/asr-server.log")).unwrap();
            assert!(log.contains("eof"));
        });
    }

    #[test]
    fn environment_is_allowlisted() {
        assert!(pass_env(std::ffi::OsStr::new("HOME")));
        assert!(pass_env(std::ffi::OsStr::new("LC_ALL")));
        assert!(!pass_env(std::ffi::OsStr::new("PYTHONPATH")));
        assert!(!pass_env(std::ffi::OsStr::new("DYLD_INSERT_LIBRARIES")));
        assert!(!pass_env(std::ffi::OsStr::new("HF_ENDPOINT")));
        tauri::async_runtime::block_on(async {
            let tmp = tempfile::tempdir().unwrap();
            let p = Arc::new(AsrProcess::new());
            p.start(spec(tmp.path(), "env; pwd; exit 1"), false).await;
            let (_tx, rx) = watch::channel(false);
            assert!(p.wait_ready(rx).await.is_err());
            let log = std::fs::read_to_string(tmp.path().join("logs/asr-server.log")).unwrap();
            let keys: Vec<&str> = log
                .lines()
                .filter_map(|l| l.split_once('=').map(|(k, _)| k))
                .collect();
            for k in &keys {
                assert!(
                    pass_env(std::ffi::OsStr::new(k))
                        || [
                            "PATH",
                            "PYTHONNOUSERSITE",
                            "PYTHONSAFEPATH",
                            "HF_HOME",
                            "HF_HUB_OFFLINE",
                            "HF_HUB_DISABLE_TELEMETRY",
                            // sh 自身が設定するもの
                            "PWD",
                            "SHLVL",
                            "OLDPWD",
                            "_",
                        ]
                        .contains(k),
                    "{k}"
                );
            }
            assert!(log.contains("PYTHONSAFEPATH=1"));
        });
    }

    #[test]
    fn no_restart_when_disabled() {
        tauri::async_runtime::block_on(async {
            let tmp = tempfile::tempdir().unwrap();
            let p = Arc::new(AsrProcess::new());
            p.start(spec(tmp.path(), "exit 1"), false).await;
            let (_tx, rx) = watch::channel(false);
            assert!(p.wait_ready(rx).await.is_err());
            let log = std::fs::read_to_string(tmp.path().join("logs/asr-server.log"));
            assert!(log.is_ok());
        });
    }
}
