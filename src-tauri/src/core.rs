//! アプリ全体の結線。設定・状態・録音・ASR・入力キューを持ち、Tauri の event を発行する。

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

use crate::asr::{self, AsrClient, HttpAsrClient, Transcript};
use crate::asr_process::{AsrEvent, AsrProcess, LaunchSpec};
use crate::audio::{self, Source};
use crate::insert::{InsertConfig, InsertQueue, Job, UtteranceResult};
use crate::macos::{self, MicAuthorization};
use crate::paths::{DataPaths, Resources};
use crate::pipeline::{self, PipelineSink, Running, StartError};
use crate::provisioning::hf::HfModel;
use crate::provisioning::runtime::UvRuntime;
use crate::provisioning::{Provisioner, ServerVerify, Stage};
use crate::settings::{Settings, SettingsStore};
use crate::state::{AppError, ErrorCode, StateManager, DONE_DISPLAY};
use crate::storage::{self, DevScope, UninstallContext};
use crate::vad::VadParams;

pub mod events {
    pub const STATUS_CHANGED: &str = "status-changed";
    pub const AUDIO_LEVEL: &str = "audio-level";
    pub const UTTERANCE_STARTED: &str = "utterance-started";
    pub const UTTERANCE_PARTIAL: &str = "utterance-partial";
    pub const UTTERANCE_RESULT: &str = "utterance-result";
    pub const SETTINGS_CHANGED: &str = "settings-changed";
    pub const PERMISSIONS_CHANGED: &str = "permissions-changed";
    pub const INPUT_DEVICES_CHANGED: &str = "input-devices-changed";
    pub const PROVISIONING_PROGRESS: &str = "provisioning-progress";
}

/// 未バンドルの開発実行 (tauri dev) で WebKit がキャッシュ等に使う名前 (実行ファイル名)
const DEV_PRODUCT_NAME: &str = "mukuchi";

/// 開発用: 設定するとマイクの代わりにこの WAV を入力にする (デバッグビルドのみ)
pub const ENV_DEV_AUDIO_FILE: &str = "MUKUCHI_DEV_AUDIO_FILE";
/// 開発用: `1` なら ASR の準備完了後に自動で音声入力をONにする (デバッグビルドのみ)
pub const ENV_DEV_AUTO_LISTEN: &str = "MUKUCHI_DEV_AUTO_LISTEN";
/// 開発用: `1` なら途中表示を送らない (確定までの遅延への影響を比べるため。デバッグビルドのみ)
pub const ENV_DEV_NO_PARTIAL: &str = "MUKUCHI_DEV_NO_PARTIAL";

/// 開発用: 設定するとそのアプリ (bundle id) が前面にある時だけ入力する。
/// 自動テストで利用者のアプリに入力しないため (デバッグビルドのみ)
pub const ENV_DEV_TARGET_BUNDLE: &str = "MUKUCHI_DEV_TARGET_BUNDLE";

/// ON の間に ASR サーバーの死活を確かめる間隔
const HEALTH_INTERVAL: Duration = Duration::from_secs(5);
/// この回数続けて /health に失敗したら停止とみなす (推論中の一時的な遅れで誤判定しない)
const HEALTH_FAILURES_TO_STOP: u32 = 2;

pub fn dev_flag(name: &str) -> bool {
    cfg!(debug_assertions) && std::env::var(name).as_deref() == Ok("1")
}

fn dev_target_bundle() -> Option<String> {
    if !cfg!(debug_assertions) {
        return None;
    }
    std::env::var(ENV_DEV_TARGET_BUNDLE)
        .ok()
        .filter(|s| !s.is_empty())
}

#[derive(Clone, Serialize)]
struct AudioLevel {
    level: f32,
    threshold: f32,
    speech: bool,
}

#[derive(Clone, Serialize)]
struct UtteranceStarted {
    id: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Utterance {
    pub id: u64,
    pub text: String,
    pub stable_length: usize,
}

/// 途中表示1回の推論時間の見積もり (音声の長さに比例 + 固定分)。
///
/// 途中表示を取り消しても ASR サーバーは推論を最後まで続ける (直列実行のため、次の確定はその後になる)。
/// そこで「今話し終わったとしても、話し終わりの判定 (無音 silenceMs) までに終わる」見込みの時だけ送る
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PartialCost {
    /// 音声1秒あたりの推論時間 (ms)。実測の指数移動平均
    ms_per_sec: f64,
}

impl PartialCost {
    /// HTTP・WAV デコード等の固定分 (ms)
    const BASE_MS: f64 = 150.0;
    /// 実測前の仮の値。開発機 (M系) の実測: 12.8秒の確定が約 810ms → 約 60ms/秒
    const INITIAL_MS_PER_SEC: f64 = 60.0;

    pub fn estimate_ms(&self, secs: f64) -> f64 {
        Self::BASE_MS + self.ms_per_sec * secs
    }

    /// 実測を取り込む。`elapsed_ms` はサーバーの処理時間 (`elapsed_ms`)。往復時間を使うと、
    /// 取り消した途中表示 (応答を待たない) を学習できず、HTTP の揺らぎも混ざるため
    pub fn observe(&mut self, secs: f64, elapsed_ms: f64) {
        let per_sec = (elapsed_ms - Self::BASE_MS).max(0.0) / secs.max(0.5);
        self.ms_per_sec = self.ms_per_sec * 0.7 + per_sec * 0.3;
    }

    /// 今送った途中表示が、話し終わりの判定までに終わる見込みか
    pub fn fits(&self, secs: f64, silence_ms: u32) -> bool {
        self.estimate_ms(secs) <= silence_ms as f64
    }
}

impl Default for PartialCost {
    fn default() -> Self {
        Self {
            ms_per_sec: Self::INITIAL_MS_PER_SEC,
        }
    }
}

/// 途中表示の状態
#[derive(Default)]
struct PartialState {
    /// 処理中の途中表示の要求 (発話 id)。同時に1つまで
    in_flight: Option<u64>,
    /// この id 以下の発話は確定処理に入ったか破棄された (遅れて届いた途中表示を出さない)
    closed_upto: u64,
    /// 直前の途中表示 (stableLength の計算用)
    prev: Option<(u64, String)>,
    cost: PartialCost,
}

/// 録音中のセッション。`generation` は開始ごとに変わり、古いセッションからの通知 (切断等) を見分ける
struct Capture {
    generation: u64,
    running: Running,
}

pub struct Core {
    app: AppHandle,
    pub settings: SettingsStore,
    pub state: StateManager,
    paths: DataPaths,
    log_dir: PathBuf,
    /// 開発時の接続先 (MUKUCHI_ASR_URL)。あれば ASR サーバーを自分では起動しない
    dev_asr_url: Option<String>,
    asr_process: Arc<AsrProcess>,
    pub provisioning: Arc<Provisioner>,
    asr: RwLock<Option<Arc<HttpAsrClient>>>,
    insert: Mutex<Option<InsertQueue>>,
    running: Mutex<Option<Capture>>,
    capture_generation: AtomicU64,
    next_id: AtomicU64,
    partial: Mutex<PartialState>,
    /// 応答待ちの確定リクエストの数。0 でない間は途中表示を送らない (ASR は直列のため確定を遅らせる)
    finals_in_flight: AtomicUsize,
    /// 録音の開始・停止を直列にする (マイク許可ダイアログ待ちの間に再度押された場合、
    /// マイク切り替えの停止→開始の間に他の操作が割り込む場合など)
    toggle_lock: tokio::sync::Mutex<()>,
}

impl Core {
    pub fn new(
        app: AppHandle,
        paths: DataPaths,
        log_dir: PathBuf,
        resources: Resources,
    ) -> Result<Arc<Self>> {
        let asr_process = Arc::new(AsrProcess::new());
        let model = HfModel::distributed();
        let emit_app = app.clone();
        let provisioning = Provisioner::new(
            paths.clone(),
            model.clone(),
            Arc::new(UvRuntime {
                paths: paths.clone(),
                resources: resources.clone(),
                log_file: log_dir.join("provisioning.log"),
            }),
            Arc::new(ServerVerify {
                asr: asr_process.clone(),
                spec: launch_spec(&paths, &log_dir, &model),
                wav: resources.verify_wav.clone(),
            }),
            move |s| {
                let _ = emit_app.emit(events::PROVISIONING_PROGRESS, s);
            },
        )?;
        let core = Arc::new(Self {
            app,
            settings: SettingsStore::load(paths.settings()),
            state: StateManager::new(),
            dev_asr_url: asr::resolve_endpoint(),
            paths,
            log_dir,
            asr_process,
            provisioning,
            asr: RwLock::new(None),
            insert: Mutex::new(None),
            running: Mutex::new(None),
            capture_generation: AtomicU64::new(0),
            next_id: AtomicU64::new(0),
            partial: Mutex::new(PartialState::default()),
            finals_in_flight: AtomicUsize::new(0),
            toggle_lock: tokio::sync::Mutex::new(()),
        });
        let app = core.app.clone();
        core.state.subscribe(move |status| {
            let _ = app.emit(events::STATUS_CHANGED, status);
        });
        let weak = Arc::downgrade(&core);
        core.asr_process.subscribe(move |ev| {
            if let Some(c) = weak.upgrade() {
                c.on_asr_event(ev);
            }
        });
        let weak = Arc::downgrade(&core);
        core.provisioning.on_finish(move |stage| {
            if let Some(c) = weak.upgrade() {
                c.on_provisioning_finished(stage);
            }
        });
        Ok(core)
    }

    pub fn app(&self) -> &AppHandle {
        &self.app
    }

    /// 入力キューと ASR 接続を開始する。
    pub fn start(self: &Arc<Self>) -> Result<()> {
        let weak_cfg = Arc::downgrade(self);
        let weak_res = Arc::downgrade(self);
        let app = self.app.clone();
        let inserter = macos::MacInserter::new(move || resolve_v_keycode(&app));
        let queue = InsertQueue::spawn(
            Arc::new(inserter),
            move || {
                weak_cfg
                    .upgrade()
                    .map(|c| {
                        let s = c.settings.get();
                        InsertConfig {
                            voice_commands_enabled: s.voice_commands_enabled,
                            voice_commands: s.voice_commands,
                            excluded_apps: s.excluded_apps,
                            only_bundle_id: dev_target_bundle(),
                        }
                    })
                    .unwrap_or_default()
            },
            move |result| {
                if let Some(c) = weak_res.upgrade() {
                    c.on_utterance_result(result);
                }
            },
        )?;
        *lock(&self.insert) = Some(queue);

        let core = self.clone();
        tauri::async_runtime::spawn(async move { core.connect_asr().await });
        self.clone().spawn_health_monitor();
        Ok(())
    }

    /// 本番の ASR サーバー (自分で起動するもの) を使うか。開発で MUKUCHI_ASR_URL を指定した時は false
    fn managed_asr(&self) -> bool {
        self.dev_asr_url.is_none()
    }

    fn launch_spec(&self) -> LaunchSpec {
        launch_spec(&self.paths, &self.log_dir, &HfModel::distributed())
    }

    fn asr_client(&self) -> Option<Arc<HttpAsrClient>> {
        self.asr.read().unwrap_or_else(|p| p.into_inner()).clone()
    }

    async fn connect_asr(self: Arc<Self>) {
        let Some(url) = self.dev_asr_url.clone() else {
            self.start_managed_asr().await;
            return;
        };
        let client = match HttpAsrClient::new(url) {
            Ok(c) => Arc::new(c),
            Err(e) => {
                self.state
                    .set_error(AppError::asr_stopped(format!("{e:#}")));
                return;
            }
        };
        log::info!("ASRサーバーに接続: {}", client.base_url());
        // モデル読み込み完了まで /health は応答しない。応答するまで待ち続ける
        let mut attempt = 0u32;
        loop {
            match client.health().await {
                Ok(model) => {
                    log::info!("ASRサーバー準備完了: model={model}");
                    break;
                }
                Err(e) => {
                    attempt += 1;
                    if attempt % 10 == 1 {
                        log::info!("ASRサーバーを待っています: {e:#}");
                    }
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
            }
        }
        *self.asr.write().unwrap_or_else(|p| p.into_inner()) = Some(client);
        self.state.set_asr_ready(true);
        self.auto_listen().await;
    }

    async fn auto_listen(self: &Arc<Self>) {
        if dev_flag(ENV_DEV_AUTO_LISTEN) {
            log::info!("{ENV_DEV_AUTO_LISTEN}=1 のため音声入力をONにする");
            if let Err(e) = self.set_listening(true).await {
                log::error!("自動ONに失敗: {e:#}");
            }
        }
    }

    /// 本番: 導入済みならサーバーを起動する。
    /// 以前に導入済みでアプリの更新により版が変わった場合は、変わった段階だけ自動でやり直す (読み込み中の表示のまま)
    async fn start_managed_asr(self: &Arc<Self>) {
        if self.provisioning.is_done() {
            self.asr_process.start(self.launch_spec(), true).await;
        } else if self.settings.get().setup_completed && self.provisioning.has_record() {
            log::info!("実行環境またはモデルの版が変わったため導入し直す");
            self.provisioning.start();
        } else {
            log::info!("実行環境とモデルが未導入");
            self.state.set_error(AppError::runtime_missing());
        }
    }

    fn set_asr_client(&self, client: Option<Arc<HttpAsrClient>>) {
        *self.asr.write().unwrap_or_else(|p| p.into_inner()) = client;
    }

    /// ASR のエラー (未導入・停止) を解除する。他のエラー (権限等) は残す
    fn clear_asr_error(&self) {
        if matches!(
            self.state.error().map(|e| e.code),
            Some(ErrorCode::RuntimeMissing | ErrorCode::AsrStopped)
        ) {
            self.state.clear_error();
        }
    }

    /// サーバーが使えなくなった (起動し直し中)。ON なら録音を止める
    fn asr_unavailable(self: &Arc<Self>) {
        self.set_asr_client(None);
        self.state.set_asr_ready(false);
        if self.state.is_listening() {
            let core = self.clone();
            tauri::async_runtime::spawn(async move {
                let _ = core.set_listening(false).await;
            });
        }
    }

    fn on_asr_event(self: &Arc<Self>, ev: AsrEvent) {
        // 開発で外部のサーバーに接続している間は、verify で起動したサーバーを使わない
        if !self.managed_asr() {
            return;
        }
        match ev {
            AsrEvent::Starting => {
                self.asr_unavailable();
                self.clear_asr_error();
            }
            AsrEvent::Ready(url) => match HttpAsrClient::new(url) {
                Ok(c) => {
                    log::info!("ASRサーバーに接続: {}", c.base_url());
                    self.set_asr_client(Some(Arc::new(c)));
                    self.clear_asr_error();
                    if self.provisioning.is_done() {
                        self.asr_became_ready();
                    } else {
                        // セットアップの動作確認中: /transcribe の確認が済むまで使える状態にしない
                        // (on_provisioning_finished で使える状態にする)
                        log::info!("動作確認が済むまで準備完了にしない");
                    }
                }
                Err(e) => self
                    .state
                    .set_error(AppError::asr_stopped(format!("{e:#}"))),
            },
            AsrEvent::Crashed {
                will_restart: true, ..
            } => self.asr_unavailable(),
            AsrEvent::Crashed {
                will_restart: false,
                detail,
            } => {
                self.set_asr_client(None);
                if self.provisioning.is_done() {
                    self.fail_later(AppError::asr_stopped(detail), None);
                } else {
                    // セットアップの動作確認での失敗 (セットアップ画面に表示される)
                    self.state.set_error(AppError::runtime_missing());
                }
            }
            AsrEvent::Stopped => {
                self.asr_unavailable();
                if !self.provisioning.is_done() {
                    self.state.set_error(AppError::runtime_missing());
                }
            }
        }
    }

    fn asr_became_ready(self: &Arc<Self>) {
        self.state.set_asr_ready(true);
        let core = self.clone();
        tauri::async_runtime::spawn(async move { core.auto_listen().await });
    }

    fn on_provisioning_finished(self: &Arc<Self>, stage: Stage) {
        if self.provisioning.is_suspended() {
            // 削除の実行中 (削除する側がサーバーを止め、未導入に戻す)
            return;
        }
        match stage {
            Stage::Done if self.managed_asr() => {
                // 動作確認で起動したサーバーをそのまま使う。以後は異常終了時に起動し直す
                self.asr_process.set_auto_restart(true);
                if self.asr_process.is_running() {
                    if self.asr_client().is_some() {
                        self.asr_became_ready();
                    }
                } else {
                    let core = self.clone();
                    tauri::async_runtime::spawn(async move {
                        core.asr_process.start(core.launch_spec(), true).await;
                    });
                }
            }
            Stage::Done => {
                // 開発で外部のサーバーを使っている: 動作確認のサーバーは止める (メモリを二重に使わない)
                let core = self.clone();
                tauri::async_runtime::spawn(async move { core.asr_process.stop().await });
            }
            _ if self.managed_asr() && !self.state.is_asr_ready() => {
                self.state.set_error(AppError::runtime_missing());
            }
            _ => {}
        }
    }

    /// 開発ビルドが本番のバンドルIDで動いていないか (storage::destructive_ops_allowed)
    fn destructive_ops_allowed(&self) -> bool {
        let id = &self.app.config().identifier;
        let ok = storage::destructive_ops_allowed(cfg!(debug_assertions), id);
        if !ok {
            log::warn!("開発ビルドが dev でないバンドルID ({id}) で動いているため、削除を行わない");
        }
        ok
    }

    /// 実行環境とモデルのみ削除 (設定・ログは残す)。以後は未導入 (runtime_missing)
    pub async fn delete_runtime_and_model(self: &Arc<Self>) -> Result<()> {
        if !self.destructive_ops_allowed() {
            return Err(anyhow!(
                "開発ビルドを本番のバンドルIDで実行しているため削除しません"
            ));
        }
        if self.managed_asr() {
            self.set_listening(false).await?;
        }
        // 削除が終わるまでセットアップ・サーバーの起動をさせない (落とすと解除)
        let _suspended = self.provisioning.suspend().await?;
        self.asr_process.stop().await;
        let paths = self.paths.clone();
        let result =
            tauri::async_runtime::spawn_blocking(move || storage::delete_runtime_and_model(&paths))
                .await
                .map_err(|e| anyhow!("削除処理が異常終了しました: {e}"));
        // 失敗しても (途中まで消えている・サーバーは止めた) 未導入に戻す。記録は最初に消すため、
        // 再セットアップでは残っているものを確かめ直す
        self.provisioning.reset();
        if self.managed_asr() {
            self.state.set_error(AppError::runtime_missing());
        }
        result?.map_err(|e| {
            log::error!("実行環境とモデルを削除できません: {e:#}");
            anyhow!("実行環境とモデルを削除できません")
        })?;
        log::info!("実行環境とモデルを削除した");
        Ok(())
    }

    pub fn storage_usage(&self) -> storage::StorageUsage {
        storage::usage(&self.paths, &self.log_dir)
    }

    fn uninstall_context(&self) -> Result<(PathBuf, String, Option<PathBuf>)> {
        let home = tauri::Manager::path(&self.app)
            .home_dir()
            .context("ホームディレクトリが分かりません")?;
        let id = self.app.config().identifier.clone();
        Ok((home, id, storage::current_app_bundle()))
    }

    fn with_uninstall_context<T>(&self, f: impl FnOnce(&UninstallContext) -> T) -> Result<T> {
        let (home, id, bundle) = self.uninstall_context()?;
        let target_dir = storage::build_target_dir();
        let ctx = UninstallContext {
            home: &home,
            bundle_id: &id,
            data_dir: self.paths.root(),
            log_dir: &self.log_dir,
            app_bundle: bundle,
            dev: cfg!(debug_assertions).then(|| DevScope {
                product_name: DEV_PRODUCT_NAME,
                target_dir: target_dir.as_deref(),
            }),
        };
        Ok(f(&ctx))
    }

    pub fn uninstall_targets(&self) -> Result<Vec<storage::UninstallTarget>> {
        self.with_uninstall_context(|ctx| storage::uninstall_plan(ctx).targets())
    }

    /// 完全にアンインストールする。本体をゴミ箱に入れたらアプリを終了する。
    /// 開発ビルドで MUKUCHI_DEV_UNINSTALL_DRY_RUN=1 なら何も変えずにログに出す
    pub async fn uninstall(self: &Arc<Self>) -> Result<()> {
        // 開発ビルドが本番のバンドルIDで動いている時は、指定がなくても dry-run にする
        let dry_run =
            dev_flag(storage::ENV_DEV_UNINSTALL_DRY_RUN) || !self.destructive_ops_allowed();
        // 何も消す前に確かめる (本体の場所が分からない・App Translocation なら中止)
        self.with_uninstall_context(|ctx| {
            storage::check_app_bundle(ctx.app_bundle.as_deref(), ctx.dev.is_some())
        })??;
        let suspended = if dry_run {
            None
        } else {
            self.set_listening(false).await?;
            let s = self.provisioning.suspend().await?;
            self.asr_process.stop().await;
            Some(s)
        };
        let core = self.clone();
        let trashed = tauri::async_runtime::spawn_blocking(move || {
            core.with_uninstall_context(|ctx| uninstall_blocking(ctx, dry_run))
        })
        .await
        .map_err(|e| anyhow!("アンインストール処理が異常終了しました: {e}"));
        if suspended.is_some() {
            // 本体を消せずに続ける場合 (開発・失敗): データは消えているため未導入に戻す
            self.provisioning.reset();
            if self.managed_asr() {
                self.state.set_error(AppError::runtime_missing());
            }
        }
        drop(suspended);
        let trashed = trashed???;
        if trashed {
            log::info!("アンインストール完了。終了する");
            self.app.exit(0);
        }
        Ok(())
    }

    /// アプリ終了時: セットアップ (uv・ダウンロード・動作確認) と ASR サーバーを止める
    pub fn shutdown(&self) {
        self.provisioning.shutdown_blocking(Duration::from_secs(3));
        self.asr_process.shutdown_blocking();
    }

    /// ON の間、ASR サーバーが落ちていないか定期的に確かめる。
    fn spawn_health_monitor(self: Arc<Self>) {
        tauri::async_runtime::spawn(async move {
            let mut failures = 0u32;
            loop {
                tokio::time::sleep(HEALTH_INTERVAL).await;
                if !self.state.is_listening() {
                    failures = 0;
                    continue;
                }
                let Some(client) = self.asr_client() else {
                    continue;
                };
                match client.health().await {
                    Ok(_) => failures = 0,
                    Err(e) => {
                        failures += 1;
                        log::warn!("ASRサーバーの /health に失敗 ({failures}回目): {e:#}");
                        if failures >= HEALTH_FAILURES_TO_STOP {
                            failures = 0;
                            self.asr_down(format!("{e:#}")).await;
                        }
                    }
                }
            }
        });
    }

    /// 文字起こしの失敗時: サーバーが落ちているかを確かめ、落ちていれば停止エラーにする。
    fn check_asr_after_failure(self: &Arc<Self>) {
        let core = self.clone();
        tauri::async_runtime::spawn(async move {
            let Some(client) = core.asr_client() else {
                return;
            };
            if let Err(e) = client.health().await {
                core.asr_down(format!("{e:#}")).await;
            }
        });
    }

    async fn asr_down(self: &Arc<Self>, detail: String) {
        if self.state.error().map(|e| e.code) == Some(ErrorCode::AsrStopped) {
            return;
        }
        self.fail(AppError::asr_stopped(detail), None).await;
    }

    /// エラーからの復旧 (restart_asr)。本番はサーバーを起動し直す (読み込み中の表示になる)。
    /// 開発で外部のサーバー (process-compose) に接続している時は、応答するかを確かめ直すだけ。
    pub async fn restart_asr(self: &Arc<Self>) -> Result<()> {
        if self.provisioning.is_suspended() {
            return Err(anyhow!("削除を実行中です"));
        }
        if self.managed_asr() {
            if !self.provisioning.is_done() {
                return Err(anyhow!("実行環境とモデルが導入されていません"));
            }
            log::info!("文字起こしサーバーを起動し直す");
            self.asr_process.start(self.launch_spec(), true).await;
            return Ok(());
        }
        let Some(client) = self.asr_client() else {
            if self.state.error().map(|e| e.code) == Some(ErrorCode::RuntimeMissing) {
                return Err(anyhow!("実行環境とモデルが導入されていません"));
            }
            // まだ接続待ち (読み込み中)。準備ができれば自動で使えるようになる
            return Ok(());
        };
        match client.health().await {
            Ok(_) => {
                log::info!("ASRサーバーの応答を確認。エラーを解除する");
                if self.state.error().map(|e| e.code) == Some(ErrorCode::AsrStopped) {
                    self.state.clear_error();
                }
                Ok(())
            }
            Err(e) => {
                log::warn!("ASRサーバーが応答しません: {e:#}");
                Err(anyhow!("文字起こしサーバーが応答しません"))
            }
        }
    }

    fn audio_source(&self) -> Source {
        if cfg!(debug_assertions) {
            if let Some(p) = std::env::var_os(ENV_DEV_AUDIO_FILE).filter(|p| !p.is_empty()) {
                return Source::File(PathBuf::from(p));
            }
        }
        Source::Device(self.settings.get().input_device_id)
    }

    pub async fn set_listening(self: &Arc<Self>, on: bool) -> Result<()> {
        let _guard = self.toggle_lock.lock().await;
        if !on {
            self.stop_capture().await;
            self.state.set_listening(false);
            return Ok(());
        }
        if self.state.is_listening() {
            return Ok(());
        }
        if !self.state.is_asr_ready() {
            // 起動できていない (runtime_missing 等) 場合はそのエラーを返す
            if let Some(e) = self.state.error() {
                return Err(anyhow!(e.message));
            }
            return Err(anyhow!("モデルを読み込んでいます。しばらくお待ちください"));
        }
        // ASR の停止でOFFになった後は、サーバーが戻っているかを確かめてから再開する
        if self.state.error().map(|e| e.code) == Some(ErrorCode::AsrStopped) {
            if let Some(client) = self.asr_client() {
                if let Err(e) = client.health().await {
                    log::warn!("ASRサーバーが応答しないため再開しない: {e:#}");
                    return Err(anyhow!("文字起こしサーバーが停止しています"));
                }
            }
        }
        self.state.clear_error();

        // 入力できない状態で聞き始めない (話した後に失敗するより、ONにする時点で知らせる)
        if !macos::accessibility_trusted() {
            let e = AppError::accessibility_denied();
            self.state.set_error(e.clone());
            return Err(anyhow!(e.message));
        }

        if matches!(self.audio_source(), Source::Device(_)) {
            let mut mic = macos::microphone_authorization();
            if mic == MicAuthorization::NotDetermined {
                mic = macos::request_microphone().await;
                self.emit_permissions();
            }
            if mic != MicAuthorization::Granted {
                let e = AppError::microphone_denied();
                self.state.set_error(e.clone());
                return Err(anyhow!(e.message));
            }
        }

        self.start_capture_locked().await?;
        self.state.set_listening(true);
        Ok(())
    }

    /// 録音を開始する。`toggle_lock` を持って呼ぶ。失敗時はエラー状態にする (OFFになる)。
    async fn start_capture_locked(self: &Arc<Self>) -> Result<()> {
        let source = self.audio_source();
        let generation = self.capture_generation.fetch_add(1, Ordering::SeqCst) + 1;
        let sink: Arc<dyn PipelineSink> = Arc::new(Sink {
            core: Arc::downgrade(self),
            generation,
        });
        // VAD の読み込みとデバイスの初期化は時間がかかりうるため async ランタイムを塞がない
        let started =
            tauri::async_runtime::spawn_blocking(move || pipeline::start(source, sink)).await;
        let running = match started {
            Ok(Ok(r)) => r,
            Ok(Err(e)) => {
                log::error!("録音を開始できません: {e:#}");
                let err = match e {
                    StartError::Vad(e) => AppError::vad_failed(format!("{e:#}")),
                    StartError::Capture(e) => AppError::microphone_missing(format!("{e:#}")),
                };
                self.state.set_error(err.clone());
                return Err(anyhow!(err.message));
            }
            Err(e) => {
                self.state.set_listening(false);
                return Err(anyhow!("録音の開始処理が異常終了しました: {e}"));
            }
        };
        *lock(&self.running) = Some(Capture {
            generation,
            running,
        });
        Ok(())
    }

    /// ON のまま録音をやり直す (マイクの切り替え・既定のマイクの変更)。
    /// 停止と開始を1つの `toggle_lock` の中で行い、間に ON/OFF やエラー処理を割り込ませない。
    pub async fn restart_capture(self: &Arc<Self>) {
        let _guard = self.toggle_lock.lock().await;
        if !self.state.is_listening() {
            return;
        }
        log::info!("マイクの変更のため録音をやり直す");
        self.stop_capture().await;
        if let Err(e) = self.start_capture_locked().await {
            log::error!("マイク切り替え後の再開に失敗: {e:#}");
        }
    }

    /// 録音を止める。話し終わりの無音待ちのものは確定し、話している最中のものは破棄する。
    /// 確定処理中のものは入力まで続く。スレッドの終了待ちは async ランタイムの外で行う。
    async fn stop_capture(&self) {
        let capture = lock(&self.running).take();
        if let Some(c) = capture {
            if let Err(e) = tauri::async_runtime::spawn_blocking(move || c.running.stop()).await {
                log::error!("録音の停止処理が異常終了しました: {e}");
            }
        }
    }

    /// エラーで音声入力を止める。`generation` を指定した場合、その録音がもう動いていなければ
    /// (OFF・マイク切り替えで新しい録音に替わった後の古い通知なら) 何もしない。
    async fn fail(self: &Arc<Self>, error: AppError, generation: Option<u64>) {
        let _guard = self.toggle_lock.lock().await;
        if let Some(g) = generation {
            let current = lock(&self.running).as_ref().map(|c| c.generation);
            if current != Some(g) {
                log::info!("停止済みの録音 ({g}) からのエラーのため無視する");
                return;
            }
        }
        log::error!("エラーのため音声入力をOFFにする: {}", error.message);
        self.stop_capture().await;
        self.state.set_error(error);
    }

    fn fail_later(self: &Arc<Self>, error: AppError, generation: Option<u64>) {
        let core = self.clone();
        tauri::async_runtime::spawn(async move { core.fail(error, generation).await });
    }

    /// 設定を部分更新して保存し、即時に反映する。各項目の反映先:
    /// - inputDeviceId: ON なら録音をやり直す (ここ)
    /// - vadSensitivity / silenceMs: 処理スレッドが約0.5秒ごとに読み直す (`Sink::vad_params`)。
    ///   audio-level の threshold も同じ値から求める
    /// - voiceCommandsEnabled / voiceCommands / excludedApps: 入力キューが発話ごとに読む
    /// - vocabulary: 途中表示・確定のリクエストごとに読む
    /// - panelPosition: パネルを動かす (ここ)
    /// - launchAtLogin: ログイン項目を登録・解除する (ここ。`login_item_change`)。登録・解除できなければ保存しない。
    ///   セットアップ完了前は値を保存するだけで、セットアップ完了時に反映する
    /// - setupCompleted: 起動時にセットアップを出すかの判定と、ログイン項目の反映の時期に使う
    ///
    /// 順序は 検証 → ログイン項目 → 保存。保存に失敗したらログイン項目を元に戻す。
    pub fn update_settings(self: &Arc<Self>, patch: &serde_json::Value) -> Result<Settings> {
        let before = self.settings.get();
        let next = self.settings.update_with(
            patch,
            |before, next| {
                let Some(target) = login_item_change(before, next, cfg!(debug_assertions)) else {
                    return Ok(None);
                };
                let was_enabled = crate::autostart::status() == crate::autostart::Status::Enabled;
                crate::autostart::set_enabled(target)?;
                Ok(Some((target, was_enabled)))
            },
            |applied| {
                if let Some((target, was_enabled)) = applied {
                    if target != was_enabled {
                        log::warn!("設定を保存できないため、ログイン項目を元に戻す");
                        if let Err(e) = crate::autostart::set_enabled(was_enabled) {
                            log::warn!("ログイン項目を元に戻せません: {e:#}");
                        }
                    }
                }
            },
        )?;
        let _ = self.app.emit(events::SETTINGS_CHANGED, &next);
        if before.panel_position != next.panel_position {
            crate::windows::on_settings_panel_position(&self.app, next.panel_position.clone());
        }
        if before.input_device_id != next.input_device_id && self.state.is_listening() {
            let core = self.clone();
            tauri::async_runtime::spawn(async move { core.restart_capture().await });
        }
        Ok(next)
    }

    /// セットアップ完了。ここで初めて「ログイン時に起動」を反映する (`login_item_change`)。
    /// ログイン項目を登録できなくてもセットアップは完了させ、その場合は設定を OFF にする
    /// (利用者は後で設定画面から ON にし直せる。失敗の理由はそこで表示される)。
    pub fn complete_setup(self: &Arc<Self>) -> Result<()> {
        match self.update_settings(&serde_json::json!({ "setupCompleted": true })) {
            Ok(_) => Ok(()),
            Err(e) => {
                log::warn!("セットアップ完了時にログイン項目を反映できません: {e:#}");
                // ログイン項目には触れず設定だけ保存する
                let next = self.settings.update(
                    &serde_json::json!({ "setupCompleted": true, "launchAtLogin": false }),
                )?;
                let _ = self.app.emit(events::SETTINGS_CHANGED, &next);
                Ok(())
            }
        }
    }

    /// 録音の取り込み元がマイクか (開発用の WAV 入力でないか)
    pub fn uses_microphone(&self) -> bool {
        matches!(self.audio_source(), Source::Device(_))
    }

    pub fn emit_permissions(&self) {
        let _ = self
            .app
            .emit(events::PERMISSIONS_CHANGED, crate::permissions::current());
    }

    fn on_utterance_result(self: &Arc<Self>, result: UtteranceResult) {
        log::info!("発話結果: {}", result.summary());
        let delivered = result.is_delivered();
        let _ = self.app.emit(events::UTTERANCE_RESULT, &result);
        self.state.finalizing_finished(delivered);
        if delivered {
            // 「完了」表示の終了を反映する
            let core = self.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(DONE_DISPLAY + Duration::from_millis(50)).await;
                core.state.refresh();
            });
        }
        match result.error_code() {
            Some(ErrorCode::AccessibilityDenied) => {
                self.fail_later(AppError::accessibility_denied(), None)
            }
            Some(ErrorCode::AsrStopped) => self.check_asr_after_failure(),
            _ => {}
        }
    }

    // ---- 途中表示 -------------------------------------------------------------

    fn can_request_partial(&self, samples: usize) -> bool {
        if dev_flag(ENV_DEV_NO_PARTIAL) {
            return false;
        }
        let secs = samples as f64 / crate::vad::SAMPLE_RATE as f64;
        let silence_ms = self.settings.get().silence_ms;
        let p = lock(&self.partial);
        p.in_flight.is_none()
            && p.cost.fits(secs, silence_ms)
            && self.finals_in_flight.load(Ordering::SeqCst) == 0
            && self.asr_client().is_some()
    }

    fn request_partial(self: &Arc<Self>, id: u64, samples: Vec<f32>) {
        let Some(client) = self.asr_client() else {
            return;
        };
        let mut p = lock(&self.partial);
        if id <= p.closed_upto || p.in_flight.is_some() {
            return;
        }
        p.in_flight = Some(id);
        let context = asr::vocabulary_context(&self.settings.get().vocabulary);
        let core = self.clone();
        // 取り消しても応答までは待つ (推論時間を学習するため。close_partial)
        tauri::async_runtime::spawn(async move {
            let started = Instant::now();
            let secs = samples.len() as f64 / crate::vad::SAMPLE_RATE as f64;
            let result = async {
                let wav = audio::encode_wav_16k(&samples)?;
                client.transcribe(wav, context).await
            }
            .await;
            core.partial_done(id, result, secs, started);
        });
    }

    fn partial_done(&self, id: u64, result: Result<Transcript>, secs: f64, started: Instant) {
        let mut p = lock(&self.partial);
        if p.in_flight == Some(id) {
            p.in_flight = None;
        }
        let text = match result {
            Ok(t) => {
                // 取り消した (確定処理に入った) 発話の分も推論時間は実測として使う
                let ms = t
                    .server_ms
                    .map_or_else(|| started.elapsed().as_secs_f64() * 1000.0, |ms| ms as f64);
                p.cost.observe(secs, ms);
                t.text
            }
            Err(e) => {
                // 暫定値のため失敗は無視する (確定処理に任せる)
                if id > p.closed_upto {
                    log::warn!("発話 {id} の途中表示に失敗: {e:#}");
                }
                return;
            }
        };
        // 確定処理に入った発話には反映しない (表示の巻き戻り防止)
        if id <= p.closed_upto {
            return;
        }
        if text.trim().is_empty() {
            return;
        }
        let prev = p
            .prev
            .as_ref()
            .filter(|(pid, _)| *pid == id)
            .map(|(_, t)| t);
        let stable_length = prev.map_or(0, |prev| common_prefix_chars(prev, &text));
        log::info!(
            "発話 {id} の途中表示: 音声 {secs:.2}秒, {}文字, {}ms",
            text.chars().count(),
            started.elapsed().as_millis()
        );
        p.prev = Some((id, text.clone()));
        // ロックを持ったまま送る: close_partial (確定・破棄) と排他にし、確定・破棄の後に
        // その発話の途中表示が届かないようにする (emit は Core を呼び返さないので詰まらない)
        let _ = self.app.emit(
            events::UTTERANCE_PARTIAL,
            Utterance {
                id,
                text,
                stable_length,
            },
        );
        drop(p);
    }

    /// 発話が確定処理に入った・破棄された。以後その発話の途中表示は出さず、次の途中表示を送れるようにする。
    /// 処理中の途中表示を取り消したかを返す。
    ///
    /// 注意: 応答待ちをやめても ASR サーバー側の推論は止まらない (推論は直列のため、確定はその推論の
    /// 終了を待つ)。影響を抑えるため、途中表示は話し終わりの判定までに終わる見込みの時だけ送り
    /// (`PartialCost`)、長い発話 (`PARTIAL_MAX_SAMPLES` 以上) では送らない。
    /// 取り消した要求も応答は受け取り、推論時間の学習に使う (結果の表示は捨てる。`partial_done`)
    fn close_partial(&self, id: u64) -> bool {
        let mut p = lock(&self.partial);
        p.closed_upto = p.closed_upto.max(id);
        p.prev = None;
        if p.in_flight.is_some_and(|i| i <= id) {
            p.in_flight = None;
            return true;
        }
        false
    }

    // ---- 確定 ---------------------------------------------------------------

    fn finalize(self: &Arc<Self>, id: u64, samples: Vec<f32>) {
        let aborted_partial = self.close_partial(id);
        let (tx, rx) = oneshot::channel();
        let queue = lock(&self.insert).clone();
        let Some(queue) = queue else {
            log::error!("入力キューが未初期化");
            return;
        };
        self.state.finalizing_started();
        if let Err(e) = queue.enqueue(Job { id, result: rx }) {
            log::error!("発話 {id} を入力キューに積めません: {e:#}");
            self.state.finalizing_finished(false);
            return;
        }
        let client = self.asr_client();
        let context = asr::vocabulary_context(&self.settings.get().vocabulary);
        let secs = samples.len() as f64 / crate::vad::SAMPLE_RATE as f64;
        log::info!("発話 {id} を確定: {secs:.2}秒 (途中表示の取り消し: {aborted_partial})");
        self.finals_in_flight.fetch_add(1, Ordering::SeqCst);
        let core = self.clone();
        // 確定リクエストはすぐ送る (入力順はキューが保証する)
        tauri::async_runtime::spawn(async move {
            let started = Instant::now();
            let result = async {
                let client = client.ok_or_else(|| anyhow!("ASRサーバーに接続していません"))?;
                let wav = audio::encode_wav_16k(&samples)?;
                client.transcribe(wav, context).await.map(|t| t.text)
            }
            .await;
            core.finals_in_flight.fetch_sub(1, Ordering::SeqCst);
            log::info!(
                "発話 {id} の確定の文字起こし: {}ms ({})",
                started.elapsed().as_millis(),
                if result.is_ok() { "成功" } else { "失敗" }
            );
            let _ = tx.send(result);
        });
    }
}

fn launch_spec(paths: &DataPaths, log_dir: &std::path::Path, model: &HfModel) -> LaunchSpec {
    LaunchSpec {
        python: paths.venv_python(),
        model_dir: model.snapshot_dir(&paths.models()),
        hf_home: paths.models(),
        cwd: paths.venv(),
        log_file: log_dir.join("asr-server.log"),
    }
}

/// アンインストールの本体 (ブロッキング)。アプリ本体をゴミ箱に入れたかを返す。
/// 順序: ログイン項目の解除 → ファイル削除 → 設定 (defaults) → TCC (LaunchServices に登録された
/// アプリが要るため本体より先) → 本体をゴミ箱へ。途中で失敗しても残りは続け、最後にまとめて報告する
fn uninstall_blocking(ctx: &UninstallContext, dry_run: bool) -> Result<bool> {
    let plan = storage::uninstall_plan(ctx);
    let mut errors: Vec<String> = Vec::new();
    if dry_run {
        log::info!("[dry-run] ログイン項目を解除");
    } else if let Err(e) = crate::autostart::set_enabled(false) {
        log::warn!("ログイン項目を解除できません: {e:#}");
        errors.push("ログイン項目".into());
    }
    if let Err(e) = storage::delete_files(&plan, ctx, dry_run) {
        log::error!("{e:#}");
        errors.push("データ".into());
    }
    if let Some((domain, plist)) = &plan.preferences {
        if dry_run {
            log::info!("[dry-run] defaults delete {domain}");
        } else {
            // plist の削除だけでは cfprefsd のキャッシュから書き戻されうるため defaults で消す
            run_tool("/usr/bin/defaults", &["delete", domain]);
            if plist.exists() {
                if let Err(e) = std::fs::remove_file(plist) {
                    log::warn!("{}: {e}", plist.display());
                    errors.push("設定".into());
                }
            }
        }
    }
    if dry_run {
        log::info!("[dry-run] tccutil reset All {}", ctx.bundle_id);
    } else if !run_tool("/usr/bin/tccutil", &["reset", "All", ctx.bundle_id]) {
        errors.push("権限の設定".into());
    }
    let mut trashed = false;
    match &plan.app_bundle {
        Some(b) if dry_run => log::info!("[dry-run] ゴミ箱へ: {}", b.display()),
        Some(b) => match macos::trash(b) {
            Ok(()) => trashed = true,
            Err(e) => {
                log::error!("{e:#}");
                errors.push("アプリ本体".into());
            }
        },
        None => log::info!("アプリ本体なし (未バンドルの実行)"),
    }
    if !errors.is_empty() && !trashed {
        return Err(anyhow!("削除できないものがあります: {}", errors.join("・")));
    }
    Ok(trashed)
}

/// 外部コマンドを実行し、成功したかを返す (出力はログへ)
fn run_tool(program: &str, args: &[&str]) -> bool {
    match std::process::Command::new(program).args(args).output() {
        Ok(o) if o.status.success() => true,
        Ok(o) => {
            log::warn!(
                "{program} {}: {} {}",
                args.join(" "),
                o.status,
                String::from_utf8_lossy(&o.stderr).trim()
            );
            false
        }
        Err(e) => {
            log::warn!("{program} を実行できません: {e}");
            false
        }
    }
}

/// 設定の変更でログイン項目をどうするか (登録なら `Some(true)`、解除なら `Some(false)`)。
/// - セットアップ完了前は何もしない (導入途中のアプリを登録しない。値は保存だけする)
/// - セットアップ完了時: その時点の launchAtLogin に揃える (前のインストールの登録が残っていても
///   セットアップでの選択を優先する)。開発ビルドでは行わない (開発中のバイナリを黙って登録しないため)
/// - 完了後に launchAtLogin が切り替わった時: 利用者の明示的な操作なので開発ビルドでも行う
pub fn login_item_change(before: &Settings, next: &Settings, dev_build: bool) -> Option<bool> {
    if !next.setup_completed {
        return None;
    }
    if before.launch_at_login != next.launch_at_login {
        return Some(next.launch_at_login);
    }
    if !before.setup_completed && !dev_build {
        return Some(next.launch_at_login);
    }
    None
}

/// 2つの文字列の先頭から一致する長さ。フロントエンドが `String.prototype.slice` で分けるため
/// UTF-16 のコード単位で数える (サロゲートペアの途中では切らない)。
pub fn common_prefix_chars(a: &str, b: &str) -> usize {
    a.chars()
        .zip(b.chars())
        .take_while(|(x, y)| x == y)
        .map(|(x, _)| x.len_utf16())
        .sum()
}

/// 現在のキーボード配列で ⌘V になる keycode。TIS はメインスレッド専用のため、
/// メインスレッドで調べて入力キューのスレッドで待つ (メインスレッドは入力キューを待たないので詰まらない)。
fn resolve_v_keycode(app: &AppHandle) -> u16 {
    let (tx, rx) = std::sync::mpsc::channel();
    let sent = app.run_on_main_thread(move || {
        let r = objc2::MainThreadMarker::new()
            .ok_or_else(|| anyhow!("メインスレッドではありません"))
            .and_then(macos::keyboard::command_v_keycode);
        let _ = tx.send(r);
    });
    let result = match sent {
        Ok(()) => rx
            .recv_timeout(Duration::from_millis(500))
            .map_err(|_| anyhow!("応答がありません"))
            .and_then(|r| r),
        Err(e) => Err(anyhow!("メインスレッドに送れません: {e}")),
    };
    result.unwrap_or_else(|e| {
        log::warn!("⌘V のキーを解決できないため ANSI の V を使う: {e:#}");
        macos::keyboard::ANSI_V_KEYCODE
    })
}

/// 処理スレッドからの通知を Core に中継する。Core が破棄された後は何もしない。
struct Sink {
    core: std::sync::Weak<Core>,
    /// どの録音セッションからの通知か
    generation: u64,
}

impl PipelineSink for Sink {
    fn vad_params(&self) -> VadParams {
        let s = self
            .core
            .upgrade()
            .map(|c| c.settings.get())
            .unwrap_or_default();
        VadParams::from_settings(s.vad_sensitivity, s.silence_ms)
    }

    fn next_utterance_id(&self) -> u64 {
        self.core
            .upgrade()
            .map(|c| c.next_id.fetch_add(1, Ordering::SeqCst) + 1)
            .unwrap_or(0)
    }

    fn audio_level(&self, level: f32, threshold: f32, speech: bool) {
        if let Some(c) = self.core.upgrade() {
            let _ = c.app.emit(
                events::AUDIO_LEVEL,
                AudioLevel {
                    level,
                    threshold,
                    speech,
                },
            );
        }
    }

    fn utterance_started(&self, id: u64) {
        if let Some(c) = self.core.upgrade() {
            log::info!("発話 {id} を検出");
            let _ = c
                .app
                .emit(events::UTTERANCE_STARTED, UtteranceStarted { id });
            c.state.set_speaking(true);
        }
    }

    fn can_request_partial(&self, samples: usize) -> bool {
        self.core
            .upgrade()
            .is_some_and(|c| c.can_request_partial(samples))
    }

    fn request_partial(&self, id: u64, audio: Vec<f32>) {
        if let Some(c) = self.core.upgrade() {
            c.request_partial(id, audio);
        }
    }

    fn utterance_ended(&self, id: u64, audio: Vec<f32>) {
        if let Some(c) = self.core.upgrade() {
            c.state.set_speaking(false);
            c.finalize(id, audio);
        }
    }

    fn utterance_discarded(&self, id: u64) {
        if let Some(c) = self.core.upgrade() {
            log::info!("発話 {id} を破棄");
            c.close_partial(id);
            c.state.set_speaking(false);
            let _ = c
                .app
                .emit(events::UTTERANCE_RESULT, UtteranceResult::Discarded { id });
        }
    }

    fn capture_lost(&self, message: String) {
        if let Some(c) = self.core.upgrade() {
            // 処理スレッド自身から stop (join) できないため、別タスクで止める
            c.fail_later(AppError::microphone_missing(message), Some(self.generation));
        }
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_length_is_common_prefix() {
        assert_eq!(common_prefix_chars("", "あいう"), 0);
        assert_eq!(
            common_prefix_chars("明日の打ち合わせ", "明日の打ち合わせは"),
            8
        );
        assert_eq!(common_prefix_chars("明日の打ち", "明日は"), 2);
        assert_eq!(common_prefix_chars("abc", "abc"), 3);
        // サロゲートペアは2単位 (JS の length と同じ)
        assert_eq!(common_prefix_chars("𠮷野家", "𠮷野屋"), 3);
    }

    #[test]
    fn partial_cost_limits_partials_to_silence_window() {
        let mut c = PartialCost::default();
        // 既定 60ms/秒 + 150ms: 5秒 → 450ms
        assert!((c.estimate_ms(5.0) - 450.0).abs() < 1e-9);
        assert!(c.fits(5.0, 1300));
        assert!(
            !c.fits(5.0, 300),
            "無音300msでは5秒の途中表示は間に合わない"
        );
        assert!(c.fits(2.0, 300));
        // 遅い実測が続くと見積もりが伸びる
        for _ in 0..20 {
            c.observe(10.0, 2150.0); // 200ms/秒
        }
        assert!((c.estimate_ms(10.0) - 2150.0).abs() < 20.0);
        assert!(!c.fits(10.0, 1300));
    }

    #[test]
    fn login_item_applied_only_after_setup() {
        let s = |setup_completed, launch_at_login| Settings {
            setup_completed,
            launch_at_login,
            ..Settings::default()
        };
        // セットアップ完了前は保存だけ
        assert_eq!(
            login_item_change(&s(false, true), &s(false, false), false),
            None
        );
        assert_eq!(
            login_item_change(&s(false, false), &s(false, true), true),
            None
        );
        // セットアップ完了時に反映 (本番のみ)
        assert_eq!(
            login_item_change(&s(false, true), &s(true, true), false),
            Some(true)
        );
        assert_eq!(
            login_item_change(&s(false, false), &s(true, false), false),
            Some(false)
        );
        assert_eq!(
            login_item_change(&s(false, true), &s(true, true), true),
            None
        );
        // 完了後の切り替えは開発ビルドでも反映
        assert_eq!(
            login_item_change(&s(true, true), &s(true, false), true),
            Some(false)
        );
        assert_eq!(
            login_item_change(&s(true, false), &s(true, true), false),
            Some(true)
        );
        // 変更なし
        assert_eq!(
            login_item_change(&s(true, true), &s(true, true), false),
            None
        );
    }

    #[test]
    fn utterance_serializes_per_contract() {
        let v = serde_json::to_value(Utterance {
            id: 2,
            text: "あ".into(),
            stable_length: 1,
        })
        .unwrap();
        assert_eq!(
            v,
            serde_json::json!({ "id": 2, "text": "あ", "stableLength": 1 })
        );
    }
}
