//! アプリ全体の結線。設定・状態・録音・ASR・入力キューを持ち、Tauri の event を発行する。

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use anyhow::{anyhow, Result};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

use crate::asr::{self, AsrClient, HttpAsrClient};
use crate::audio::{self, Source};
use crate::insert::{InsertConfig, InsertQueue, Job, UtteranceResult};
use crate::macos::{self, MicAuthorization};
use crate::pipeline::{self, PipelineSink, Running};
use crate::settings::{Settings, SettingsStore};
use crate::state::{AppError, ErrorCode, StateManager, DONE_DISPLAY};
use crate::vad::VadParams;

pub mod events {
    pub const STATUS_CHANGED: &str = "status-changed";
    pub const AUDIO_LEVEL: &str = "audio-level";
    pub const UTTERANCE_STARTED: &str = "utterance-started";
    pub const UTTERANCE_RESULT: &str = "utterance-result";
    pub const SETTINGS_CHANGED: &str = "settings-changed";
    pub const PERMISSIONS_CHANGED: &str = "permissions-changed";
}

/// 開発用: 設定するとマイクの代わりにこの WAV を入力にする (デバッグビルドのみ)
pub const ENV_DEV_AUDIO_FILE: &str = "MUKUCHI_DEV_AUDIO_FILE";
/// 開発用: `1` なら ASR の準備完了後に自動で音声入力をONにする (デバッグビルドのみ)
pub const ENV_DEV_AUTO_LISTEN: &str = "MUKUCHI_DEV_AUTO_LISTEN";

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

pub struct Core {
    app: AppHandle,
    pub settings: SettingsStore,
    pub state: StateManager,
    asr: RwLock<Option<Arc<HttpAsrClient>>>,
    insert: Mutex<Option<InsertQueue>>,
    running: Mutex<Option<Running>>,
    next_id: AtomicU64,
    /// set_listening の多重実行を防ぐ (マイク許可ダイアログ待ちの間に再度押された場合など)
    toggle_lock: tokio::sync::Mutex<()>,
}

impl Core {
    pub fn new(app: AppHandle, settings_path: PathBuf) -> Arc<Self> {
        let core = Arc::new(Self {
            app,
            settings: SettingsStore::load(settings_path),
            state: StateManager::new(),
            asr: RwLock::new(None),
            insert: Mutex::new(None),
            running: Mutex::new(None),
            next_id: AtomicU64::new(0),
            toggle_lock: tokio::sync::Mutex::new(()),
        });
        let app = core.app.clone();
        core.state.subscribe(move |status| {
            let _ = app.emit(events::STATUS_CHANGED, status);
        });
        core
    }

    /// 入力キューと ASR 接続を開始する。
    pub fn start(self: &Arc<Self>) -> Result<()> {
        let weak_cfg = Arc::downgrade(self);
        let weak_res = Arc::downgrade(self);
        let queue = InsertQueue::spawn(
            Arc::new(macos::MacInserter),
            move || {
                weak_cfg
                    .upgrade()
                    .map(|c| {
                        let s = c.settings.get();
                        InsertConfig {
                            voice_commands_enabled: s.voice_commands_enabled,
                            voice_commands: s.voice_commands,
                            excluded_apps: s.excluded_apps,
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
        Ok(())
    }

    async fn connect_asr(self: Arc<Self>) {
        let Some(url) = asr::resolve_endpoint() else {
            log::error!(
                "{} が未設定。本番のASRサーバー起動は未実装 (P4)",
                asr::ENV_ASR_URL
            );
            self.state.set_error(AppError::runtime_missing());
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

        if cfg!(debug_assertions) && std::env::var(ENV_DEV_AUTO_LISTEN).as_deref() == Ok("1") {
            log::info!("{ENV_DEV_AUTO_LISTEN}=1 のため音声入力をONにする");
            if let Err(e) = self.set_listening(true).await {
                log::error!("自動ONに失敗: {e:#}");
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
            self.stop_capture();
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
        self.state.clear_error();

        let source = self.audio_source();
        if matches!(source, Source::Device(_)) {
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

        let sink: Arc<dyn PipelineSink> = Arc::new(Sink(Arc::downgrade(self)));
        // VAD の読み込みとデバイスの初期化は時間がかかりうるため async ランタイムを塞がない
        let started =
            tauri::async_runtime::spawn_blocking(move || pipeline::start(source, sink)).await;
        let running = match started {
            Ok(Ok(r)) => r,
            Ok(Err(e)) => {
                log::error!("録音を開始できません: {e:#}");
                let err = AppError::microphone_missing(format!("{e:#}"));
                self.state.set_error(err.clone());
                return Err(anyhow!(err.message));
            }
            Err(e) => return Err(anyhow!("録音の開始処理が異常終了しました: {e}")),
        };
        *lock(&self.running) = Some(running);
        self.state.set_listening(true);
        Ok(())
    }

    /// 録音を止める。発話中のものは破棄され、確定処理中のものは入力まで続く。
    fn stop_capture(&self) {
        let running = lock(&self.running).take();
        if let Some(r) = running {
            r.stop();
        }
    }

    /// エラーで音声入力を止める。
    fn fail(self: &Arc<Self>, error: AppError) {
        log::error!("エラーのため音声入力をOFFにする: {}", error.message);
        self.stop_capture();
        self.state.set_error(error);
    }

    pub fn update_settings(self: &Arc<Self>, patch: &serde_json::Value) -> Result<Settings> {
        let before = self.settings.get();
        let next = self.settings.update(patch)?;
        let _ = self.app.emit(events::SETTINGS_CHANGED, &next);
        // マイクを変えたら録音をやり直す (感度・無音時間は処理スレッドが読み直す)
        if before.input_device_id != next.input_device_id && self.state.is_listening() {
            let core = self.clone();
            tauri::async_runtime::spawn(async move {
                let _ = core.set_listening(false).await;
                if let Err(e) = core.set_listening(true).await {
                    log::error!("マイク切り替え後の再開に失敗: {e:#}");
                }
            });
        }
        Ok(next)
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
        if result.error_code() == Some(ErrorCode::AccessibilityDenied) {
            self.fail(AppError::accessibility_denied());
        }
    }

    fn finalize(self: &Arc<Self>, id: u64, samples: Vec<f32>) {
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
        let client = self.asr.read().unwrap_or_else(|p| p.into_inner()).clone();
        let context = asr::vocabulary_context(&self.settings.get().vocabulary);
        log::info!(
            "発話 {id} を確定: {:.2}秒",
            samples.len() as f64 / crate::vad::SAMPLE_RATE as f64
        );
        // 確定リクエストはすぐ送る (入力順はキューが保証する)
        tauri::async_runtime::spawn(async move {
            let result = async {
                let client = client.ok_or_else(|| anyhow!("ASRサーバーに接続していません"))?;
                let wav = audio::encode_wav_16k(&samples)?;
                client.transcribe(wav, context).await
            }
            .await;
            let _ = tx.send(result);
        });
    }
}

/// 処理スレッドからの通知を Core に中継する。Core が破棄された後は何もしない。
struct Sink(std::sync::Weak<Core>);

impl PipelineSink for Sink {
    fn vad_params(&self) -> VadParams {
        let s = self
            .0
            .upgrade()
            .map(|c| c.settings.get())
            .unwrap_or_default();
        VadParams::from_settings(s.vad_sensitivity, s.silence_ms)
    }

    fn next_utterance_id(&self) -> u64 {
        self.0
            .upgrade()
            .map(|c| c.next_id.fetch_add(1, Ordering::SeqCst) + 1)
            .unwrap_or(0)
    }

    fn audio_level(&self, level: f32, threshold: f32, speech: bool) {
        if let Some(c) = self.0.upgrade() {
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
        if let Some(c) = self.0.upgrade() {
            log::info!("発話 {id} を検出");
            let _ = c
                .app
                .emit(events::UTTERANCE_STARTED, UtteranceStarted { id });
            c.state.set_speaking(true);
        }
    }

    fn utterance_ended(&self, id: u64, audio: Vec<f32>) {
        if let Some(c) = self.0.upgrade() {
            c.state.set_speaking(false);
            c.finalize(id, audio);
        }
    }

    fn utterance_discarded(&self, id: u64) {
        if let Some(c) = self.0.upgrade() {
            log::info!("発話 {id} を破棄");
            c.state.set_speaking(false);
            let _ = c
                .app
                .emit(events::UTTERANCE_RESULT, UtteranceResult::Discarded { id });
        }
    }

    fn capture_lost(&self, message: String) {
        if let Some(c) = self.0.upgrade() {
            // 処理スレッド自身から stop (join) できないため、別スレッドで止める
            tauri::async_runtime::spawn(async move {
                c.fail(AppError::microphone_missing(message));
            });
        }
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}
