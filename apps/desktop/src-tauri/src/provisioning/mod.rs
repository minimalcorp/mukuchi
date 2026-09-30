//! 初回セットアップ (provisioning): runtime → model → verify (docs/architecture.md「同梱物と初回セットアップ」)。
//!
//! - 進捗は `provisioning-progress` で約4Hz (段階の変化は即時)
//! - 一時停止: 実行中の段階を中断する。model は途中のファイルを残し、再開時に HTTP Range で続きから取る。
//!   runtime は uv を止め、再開時にやり直す (uv のキャッシュで続きから進む)。verify はやり直す
//! - 失敗: `ProvisioningStatus.error` に表示用の文言を入れる。再試行 (start) は一時停止からの再開と同じ
//! - 完了した段階は `provisioned.json` に版と時刻を記録し、版が変わった段階 (とそれ以降の verify) だけやり直す

pub mod hf;
pub mod runtime;
#[cfg(test)]
mod test_server;
#[cfg(test)]
mod tests;

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Context};
use serde::{Deserialize, Serialize};
use tokio::sync::watch;

use crate::asr::{AsrClient, HttpAsrClient};
use crate::asr_process::{AsrProcess, LaunchSpec};
use crate::paths::DataPaths;
use hf::{Cache, Downloader, HfModel};

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

/// 進捗の送信間隔 (約4Hz)
const EMIT_INTERVAL: Duration = Duration::from_millis(250);
/// 残り時間の見積もりに使う直近の期間
const RATE_WINDOW: Duration = Duration::from_secs(10);

// ---- 型 (docs/architecture.md「型」ProvisioningStatus) ----------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Stage {
    Idle,
    Runtime,
    Model,
    Verify,
    Done,
    Paused,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ItemId {
    Runtime,
    Model,
    Verify,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ItemState {
    Pending,
    Active,
    Done,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: ItemId,
    pub state: ItemState,
    pub bytes_done: u64,
    /// 大きさが分からない段階 (runtime・verify) は null
    pub bytes_total: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvisioningStatus {
    pub stage: Stage,
    pub items: Vec<Item>,
    /// 全体。大きさの分かる項目 (model) の合計
    pub bytes_done: u64,
    pub bytes_total: Option<u64>,
    pub eta_seconds: Option<u64>,
    pub error: Option<String>,
}

impl ProvisioningStatus {
    fn new(done: [bool; 3]) -> Self {
        let items = [ItemId::Runtime, ItemId::Model, ItemId::Verify]
            .into_iter()
            .zip(done)
            .map(|(id, d)| Item {
                id,
                state: if d {
                    ItemState::Done
                } else {
                    ItemState::Pending
                },
                bytes_done: 0,
                bytes_total: None,
            })
            .collect();
        Self {
            stage: if done.iter().all(|d| *d) {
                Stage::Done
            } else {
                Stage::Idle
            },
            items,
            bytes_done: 0,
            bytes_total: None,
            eta_seconds: None,
            error: None,
        }
    }

    fn item(&mut self, id: ItemId) -> &mut Item {
        let i = id as usize;
        &mut self.items[i]
    }

    fn recompute_total(&mut self) {
        self.bytes_done = self.items.iter().map(|i| i.bytes_done).sum();
        let totals: Vec<u64> = self.items.iter().filter_map(|i| i.bytes_total).collect();
        self.bytes_total = (!totals.is_empty()).then(|| totals.iter().sum());
    }
}

// ---- 段階の失敗・中断 --------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum StepError {
    #[error("一時停止")]
    Paused,
    /// `message` は表示用 (日本語)。`source` はログ用の詳細
    #[error("{message}")]
    Failed {
        message: String,
        #[source]
        source: anyhow::Error,
    },
}

pub fn failed(message: impl Into<String>, source: impl Into<anyhow::Error>) -> StepError {
    StepError::Failed {
        message: message.into(),
        source: source.into(),
    }
}

/// 一時停止の合図
#[derive(Clone)]
pub struct Cancel(watch::Receiver<bool>);

impl Cancel {
    pub fn pair() -> (watch::Sender<bool>, Self) {
        let (tx, rx) = watch::channel(false);
        (tx, Self(rx))
    }

    pub fn is_cancelled(&self) -> bool {
        *self.0.borrow()
    }

    /// 一時停止が求められるまで待つ
    pub async fn cancelled(&self) {
        let mut rx = self.0.clone();
        let closed = rx.wait_for(|c| *c).await.is_err();
        if closed {
            // 送り手がなくなった (中断されることはない)
            std::future::pending::<()>().await;
        }
    }

    pub fn receiver(&self) -> watch::Receiver<bool> {
        self.0.clone()
    }
}

// ---- 段階の実装 (テストで差し替える) ---------------------------------------

pub trait RuntimeStep: Send + Sync {
    /// 同梱物から求めた版。求められない (開発で同梱物がない等) 場合は None
    fn version(&self) -> Option<String>;
    /// 導入先が残っているか (記録だけあって消されていないか)
    fn is_present(&self) -> bool;
    fn install(&self, cancel: Cancel) -> BoxFuture<Result<(), StepError>>;
}

pub trait VerifyStep: Send + Sync {
    fn verify(&self, cancel: Cancel) -> BoxFuture<Result<(), StepError>>;
}

/// verify: 本番と同じ起動方法で ASR サーバーを起動し、/health と検証用音声の /transcribe を確かめる。
/// 成功したサーバーはそのまま使い続ける (読み込みをやり直さないため)。失敗したら止める
pub struct ServerVerify {
    pub asr: Arc<AsrProcess>,
    pub spec: LaunchSpec,
    pub wav: PathBuf,
}

impl VerifyStep for ServerVerify {
    fn verify(&self, cancel: Cancel) -> BoxFuture<Result<(), StepError>> {
        let asr = self.asr.clone();
        let spec = self.spec.clone();
        let wav_path = self.wav.clone();
        Box::pin(async move {
            let result = verify_server(&asr, spec, &wav_path, &cancel).await;
            if result.is_err() {
                asr.stop().await;
            }
            result
        })
    }
}

async fn verify_server(
    asr: &Arc<AsrProcess>,
    spec: LaunchSpec,
    wav_path: &std::path::Path,
    cancel: &Cancel,
) -> Result<(), StepError> {
    const ERROR: &str = "文字起こしの動作確認に失敗しました。再試行してください";
    let wav = std::fs::read(wav_path).map_err(|e| {
        failed(
            "検証用の音声が見つかりません。アプリを入れ直してください",
            anyhow!(e).context(wav_path.display().to_string()),
        )
    })?;
    // 検証中の異常終了は起動し直さず失敗にする (完了後に自動再起動を有効にする)
    asr.start(spec, false).await;
    let url = match asr.wait_ready(cancel.receiver()).await {
        Ok(u) => u,
        Err(_) if cancel.is_cancelled() => return Err(StepError::Paused),
        Err(e) => return Err(failed(ERROR, e)),
    };
    let client = HttpAsrClient::new(url).map_err(|e| failed(ERROR, e))?;
    let t = tokio::select! {
        r = client.transcribe(wav, None) => r.map_err(|e| failed(ERROR, e))?,
        _ = cancel.cancelled() => return Err(StepError::Paused),
    };
    if t.text.trim().is_empty() {
        return Err(failed(ERROR, anyhow!("検証用音声の認識結果が空")));
    }
    log::info!("動作確認: 認識 {}文字", t.text.chars().count());
    Ok(())
}

// ---- provisioned.json ------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provisioned {
    #[serde(default)]
    pub runtime: Option<StepRecord>,
    #[serde(default)]
    pub model: Option<StepRecord>,
    /// 動作確認したときの runtime/model の版
    #[serde(default)]
    pub verify: Option<VerifyRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepRecord {
    pub version: String,
    /// UNIX 時刻 (秒)
    pub completed_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyRecord {
    pub runtime: String,
    pub model: String,
    pub completed_at: u64,
}

impl Provisioned {
    pub fn load(path: &std::path::Path) -> Self {
        match std::fs::read(path) {
            Ok(b) => serde_json::from_slice(&b).unwrap_or_else(|e| {
                log::warn!("provisioned.json が読めないため未導入とみなす: {e}");
                Self::default()
            }),
            Err(_) => Self::default(),
        }
    }

    fn save(&self, path: &std::path::Path) -> anyhow::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self)?)?;
        std::fs::rename(&tmp, path).context("provisioned.json を保存できません")
    }

    fn is_empty(&self) -> bool {
        self.runtime.is_none() && self.model.is_none() && self.verify.is_none()
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// やり直す段階
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Plan {
    pub runtime: bool,
    pub model: bool,
    pub verify: bool,
}

impl Plan {
    pub fn is_empty(&self) -> bool {
        !self.runtime && !self.model && !self.verify
    }
}

/// 記録と現在の版から、やり直す段階を決める。
/// `runtime_version` が None (同梱物がなく版が分からない。開発時) なら、記録があれば済みとみなす
pub fn plan(
    rec: &Provisioned,
    runtime_version: Option<&str>,
    runtime_present: bool,
    model_version: &str,
    model_present: bool,
) -> Plan {
    let runtime_ok = runtime_present
        && rec
            .runtime
            .as_ref()
            .is_some_and(|r| runtime_version.is_none_or(|v| r.version == v));
    let model_ok = model_present
        && rec
            .model
            .as_ref()
            .is_some_and(|m| m.version == model_version);
    let verify_ok = runtime_ok
        && model_ok
        && rec.verify.as_ref().is_some_and(|v| {
            rec.runtime.as_ref().is_some_and(|r| r.version == v.runtime) && v.model == model_version
        });
    Plan {
        runtime: !runtime_ok,
        model: !model_ok,
        verify: !verify_ok,
    }
}

// ---- 進捗 ------------------------------------------------------------------

type Emit = Arc<dyn Fn(&ProvisioningStatus) + Send + Sync>;

struct Shared {
    status: Mutex<ProvisioningStatus>,
    dirty: AtomicBool,
    emit: Emit,
    rate: Mutex<RateMeter>,
}

impl Shared {
    /// 段階の変化など。すぐ送る
    fn update_now(&self, f: impl FnOnce(&mut ProvisioningStatus)) {
        let s = {
            let mut g = lock(&self.status);
            f(&mut g);
            g.recompute_total();
            g.clone()
        };
        self.dirty.store(false, Ordering::SeqCst);
        (self.emit)(&s);
    }

    /// バイト数の増減。次の定期送信で送る
    fn add_bytes(&self, id: ItemId, delta: i64) {
        let mut g = lock(&self.status);
        let it = g.item(id);
        it.bytes_done = it.bytes_done.saturating_add_signed(delta);
        if let Some(t) = it.bytes_total {
            it.bytes_done = it.bytes_done.min(t);
        }
        g.recompute_total();
        self.dirty.store(true, Ordering::SeqCst);
    }

    /// 定期送信: 残り時間を見積もり、変化があれば送る
    fn tick(&self) {
        let s = {
            let mut g = lock(&self.status);
            let eta = {
                let mut r = lock(&self.rate);
                r.push(Instant::now(), g.bytes_done);
                match (g.stage, g.bytes_total) {
                    (Stage::Model, Some(total)) => r.eta(total.saturating_sub(g.bytes_done)),
                    _ => None,
                }
            };
            if eta != g.eta_seconds {
                g.eta_seconds = eta;
                self.dirty.store(true, Ordering::SeqCst);
            }
            if !self.dirty.swap(false, Ordering::SeqCst) {
                return;
            }
            g.clone()
        };
        (self.emit)(&s);
    }
}

/// 直近の転送速度
#[derive(Default)]
struct RateMeter {
    samples: std::collections::VecDeque<(Instant, u64)>,
}

impl RateMeter {
    fn push(&mut self, t: Instant, bytes: u64) {
        // 最初からやり直した等でバイト数が減ったら測り直す
        if self.samples.back().is_some_and(|(_, b)| *b > bytes) {
            self.samples.clear();
        }
        self.samples.push_back((t, bytes));
        while self
            .samples
            .front()
            .is_some_and(|(s, _)| t.duration_since(*s) > RATE_WINDOW)
        {
            self.samples.pop_front();
        }
    }

    fn reset(&mut self) {
        self.samples.clear();
    }

    fn eta(&self, remaining: u64) -> Option<u64> {
        let (t0, b0) = self.samples.front()?;
        let (t1, b1) = self.samples.back()?;
        let secs = t1.duration_since(*t0).as_secs_f64();
        // 見積もりが安定するまで (2秒) は出さない
        if secs < 2.0 || b1 <= b0 {
            return None;
        }
        let rate = (b1 - b0) as f64 / secs;
        Some((remaining as f64 / rate).ceil() as u64)
    }
}

// ---- 本体 -------------------------------------------------------------------

struct Running {
    cancel: watch::Sender<bool>,
    finished: watch::Receiver<bool>,
}

/// 終了時 (完了・一時停止・失敗) に最後の段階を渡す
type FinishHook = Arc<dyn Fn(Stage) + Send + Sync>;

pub struct Provisioner {
    paths: DataPaths,
    model: HfModel,
    http: reqwest::Client,
    runtime: Arc<dyn RuntimeStep>,
    verify: Arc<dyn VerifyStep>,
    shared: Arc<Shared>,
    running: Mutex<Option<Running>>,
    done: AtomicBool,
    /// 削除 (アンインストール・実行環境とモデルのみ削除) の実行中。この間 start は何もしない
    suspended: AtomicBool,
    on_finish: Mutex<Option<FinishHook>>,
}

/// 削除の実行中を表す。落とすと解除する
pub struct Suspended {
    owner: Arc<Provisioner>,
}

impl Drop for Suspended {
    fn drop(&mut self) {
        self.owner.suspended.store(false, Ordering::SeqCst);
    }
}

impl Provisioner {
    pub fn new(
        paths: DataPaths,
        model: HfModel,
        runtime: Arc<dyn RuntimeStep>,
        verify: Arc<dyn VerifyStep>,
        emit: impl Fn(&ProvisioningStatus) + Send + Sync + 'static,
    ) -> anyhow::Result<Arc<Self>> {
        let rec = Provisioned::load(&paths.provisioned());
        let p = plan(
            &rec,
            runtime.version().as_deref(),
            runtime.is_present(),
            &model.version(),
            model_present(&paths, &model),
        );
        let status = ProvisioningStatus::new([!p.runtime, !p.model, !p.verify]);
        Ok(Arc::new(Self {
            http: hf::http_client()?,
            paths,
            model,
            runtime,
            verify,
            shared: Arc::new(Shared {
                status: Mutex::new(status),
                dirty: AtomicBool::new(false),
                emit: Arc::new(emit),
                rate: Mutex::new(RateMeter::default()),
            }),
            running: Mutex::new(None),
            done: AtomicBool::new(p.is_empty()),
            suspended: AtomicBool::new(false),
            on_finish: Mutex::new(None),
        }))
    }

    /// 実行の終了時 (完了 `Done`・一時停止 `Paused`・失敗 `Error`) に呼ぶ
    pub fn on_finish(&self, f: impl Fn(Stage) + Send + Sync + 'static) {
        *lock(&self.on_finish) = Some(Arc::new(f));
    }

    pub fn status(&self) -> ProvisioningStatus {
        lock(&self.shared.status).clone()
    }

    /// 導入済み (全段階が現在の版で完了) か
    pub fn is_done(&self) -> bool {
        self.done.load(Ordering::SeqCst)
    }

    /// 以前に一部でも導入したことがあるか (アプリの更新で版が変わった場合に自動でやり直す判定用)。
    /// 「実行環境とモデルのみ削除」の後は記録ごと消すため false になる
    pub fn has_record(&self) -> bool {
        !Provisioned::load(&self.paths.provisioned()).is_empty()
    }

    /// 開始・再開 (失敗後の再試行も同じ)。実行中・完了済みなら何もしない
    pub fn start(self: &Arc<Self>) {
        let mut running = lock(&self.running);
        if self.is_suspended() {
            log::info!("削除の実行中のためセットアップを開始しない");
            return;
        }
        if running.as_ref().is_some_and(|r| !*r.finished.borrow()) || self.is_done() {
            return;
        }
        let (cancel_tx, cancel) = Cancel::pair();
        let (fin_tx, fin_rx) = watch::channel(false);
        *running = Some(Running {
            cancel: cancel_tx,
            finished: fin_rx,
        });
        drop(running);
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            let ticker = {
                let shared = this.shared.clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        tokio::time::sleep(EMIT_INTERVAL).await;
                        shared.tick();
                    }
                })
            };
            this.run(cancel).await;
            ticker.abort();
            let _ = fin_tx.send(true);
        });
    }

    /// 削除の前に呼ぶ: 以後の start を止め、未導入扱いにしてから実行中のものを止める。
    /// 既に別の削除が実行中ならエラー
    pub async fn suspend(self: &Arc<Self>) -> anyhow::Result<Suspended> {
        {
            // start と同じロックの中で立てる (確認と開始の間に割り込まれないように)
            let _running = lock(&self.running);
            if self.suspended.swap(true, Ordering::SeqCst) {
                anyhow::bail!("削除を実行中です");
            }
            // 削除の途中で「導入済み」とみなされないように
            self.done.store(false, Ordering::SeqCst);
        }
        let guard = Suspended {
            owner: self.clone(),
        };
        self.pause().await;
        Ok(guard)
    }

    pub fn is_suspended(&self) -> bool {
        self.suspended.load(Ordering::SeqCst)
    }

    /// アプリの終了時: 実行中のもの (uv・ダウンロード・動作確認) を止め、終わるまで最大 `timeout` 待つ。
    /// async ランタイムの外 (イベントループ) から呼ぶため同期で待つ
    pub fn shutdown_blocking(&self, timeout: Duration) {
        let fin = {
            let running = lock(&self.running);
            let Some(r) = running.as_ref() else {
                return;
            };
            let _ = r.cancel.send(true);
            r.finished.clone()
        };
        let deadline = Instant::now() + timeout;
        while !*fin.borrow() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        if !*fin.borrow() {
            log::warn!("セットアップの停止を待ちきれずに終了する");
        }
    }

    /// 一時停止。実行中の段階が止まるまで待つ
    pub async fn pause(&self) {
        let fin = {
            let running = lock(&self.running);
            let Some(r) = running.as_ref() else {
                return;
            };
            let _ = r.cancel.send(true);
            r.finished.clone()
        };
        let mut fin = fin;
        crate::asr_process::until_true(&mut fin).await;
    }

    /// 実行環境とモデルを削除した後: 未導入に戻す
    pub fn reset(&self) {
        self.done.store(false, Ordering::SeqCst);
        lock(&self.shared.rate).reset();
        self.shared
            .update_now(|s| *s = ProvisioningStatus::new([false, false, false]));
    }

    async fn run(self: &Arc<Self>, cancel: Cancel) {
        let sh = &self.shared;
        lock(&sh.rate).reset();
        let result = match self.run_steps(&cancel).await {
            // 終わる直前に削除が始まった: 完了扱いにしない (削除後に未導入に戻す)
            Ok(()) if self.is_suspended() => Err(StepError::Paused),
            r => r,
        };
        let stage = match result {
            Ok(()) => {
                self.done.store(true, Ordering::SeqCst);
                sh.update_now(|s| {
                    s.stage = Stage::Done;
                    s.eta_seconds = None;
                    s.error = None;
                });
                log::info!("セットアップ完了");
                Stage::Done
            }
            Err(StepError::Paused) => {
                log::info!("セットアップを一時停止");
                sh.update_now(|s| {
                    s.stage = Stage::Paused;
                    s.eta_seconds = None;
                });
                Stage::Paused
            }
            Err(StepError::Failed { message, source }) => {
                log::error!("セットアップに失敗: {message}: {source:#}");
                sh.update_now(|s| {
                    s.stage = Stage::Error;
                    s.eta_seconds = None;
                    s.error = Some(message);
                });
                Stage::Error
            }
        };
        let hook = lock(&self.on_finish).clone();
        if let Some(h) = hook {
            h(stage);
        }
    }

    async fn run_steps(self: &Arc<Self>, cancel: &Cancel) -> Result<(), StepError> {
        let sh = &self.shared;
        let path = self.paths.provisioned();
        let mut rec = Provisioned::load(&path);
        let runtime_version = self.runtime.version();
        let model_version = self.model.version();
        let p = plan(
            &rec,
            runtime_version.as_deref(),
            self.runtime.is_present(),
            &model_version,
            model_present(&self.paths, &self.model),
        );
        log::info!("セットアップ開始: {p:?}");
        sh.update_now(|s| {
            s.error = None;
            for (id, redo) in [
                (ItemId::Runtime, p.runtime),
                (ItemId::Model, p.model),
                (ItemId::Verify, p.verify),
            ] {
                let it = s.item(id);
                it.state = if redo {
                    ItemState::Pending
                } else {
                    ItemState::Done
                };
            }
        });

        // 取得するモデルの一覧を先に求め、全体の大きさを最初から出す
        let files = if p.model {
            let files = hf::list_files(&self.http, &self.model, cancel).await?;
            let total: u64 = files.iter().map(|f| f.size).sum();
            let cache = Cache::new(&self.model, &self.paths.models());
            let on_disk = cache.bytes_on_disk(&files);
            sh.update_now(|s| {
                let it = s.item(ItemId::Model);
                it.bytes_total = Some(total);
                it.bytes_done = on_disk;
            });
            Some(files)
        } else {
            None
        };

        if p.runtime {
            self.begin(ItemId::Runtime, Stage::Runtime);
            // 版の違う記録を先に消す (途中で止まった時に古い版のまま済み扱いにしない)
            rec.runtime = None;
            rec.verify = None;
            rec.save(&path).map_err(|e| failed(SAVE_ERROR, e))?;
            self.runtime.install(cancel.clone()).await?;
            let version = match &runtime_version {
                Some(v) => v.clone(),
                None => self.runtime.version().unwrap_or_else(|| "unknown".into()),
            };
            rec.runtime = Some(StepRecord {
                version,
                completed_at: now_secs(),
            });
            rec.save(&path).map_err(|e| failed(SAVE_ERROR, e))?;
            self.finish(ItemId::Runtime);
        }

        if let Some(files) = files {
            self.begin(ItemId::Model, Stage::Model);
            rec.model = None;
            rec.verify = None;
            rec.save(&path).map_err(|e| failed(SAVE_ERROR, e))?;
            let cache = Cache::new(&self.model, &self.paths.models());
            let shared = sh.clone();
            let progress = move |delta: i64| shared.add_bytes(ItemId::Model, delta);
            Downloader {
                http: &self.http,
                model: &self.model,
                cache: &cache,
                cancel,
                progress: &progress,
            }
            .download_all(&files)
            .await?;
            if !cache.snapshot_complete(&files) {
                return Err(failed(
                    "モデルを保存できません",
                    anyhow!("スナップショットが揃っていない"),
                ));
            }
            rec.model = Some(StepRecord {
                version: model_version.clone(),
                completed_at: now_secs(),
            });
            rec.save(&path).map_err(|e| failed(SAVE_ERROR, e))?;
            self.finish(ItemId::Model);
        }

        if p.verify {
            self.begin(ItemId::Verify, Stage::Verify);
            self.verify.verify(cancel.clone()).await?;
            rec.verify = Some(VerifyRecord {
                runtime: rec
                    .runtime
                    .as_ref()
                    .map(|r| r.version.clone())
                    .unwrap_or_default(),
                model: model_version,
                completed_at: now_secs(),
            });
            rec.save(&path).map_err(|e| failed(SAVE_ERROR, e))?;
            self.finish(ItemId::Verify);
        }
        Ok(())
    }

    fn begin(&self, id: ItemId, stage: Stage) {
        log::info!("セットアップ: {id:?} を開始");
        self.shared.update_now(|s| {
            s.stage = stage;
            s.item(id).state = ItemState::Active;
        });
    }

    fn finish(&self, id: ItemId) {
        self.shared.update_now(|s| {
            let it = s.item(id);
            it.state = ItemState::Done;
            if let Some(t) = it.bytes_total {
                it.bytes_done = t;
            }
        });
    }
}

const SAVE_ERROR: &str = "セットアップの状態を保存できません";

fn model_present(paths: &DataPaths, model: &HfModel) -> bool {
    model
        .snapshot_dir(&paths.models())
        .join("config.json")
        .is_file()
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}
#[cfg(test)]
mod it;
