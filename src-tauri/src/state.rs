//! アプリ状態 (`Phase`) の一元管理。
//!
//! 個々の事実 (ON/OFF、ASR準備完了、発話中、確定処理中の件数、エラー) だけを保持し、
//! `Phase` はそこから導出する。遷移のたびに購読者 (Tauri event・メニュー) へ通知する。

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

/// 入力完了後に「完了」表示を保つ時間 (implementation-plan.md 2. 確定結果の表示)。
pub const DONE_DISPLAY: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Loading,
    Off,
    Listening,
    Speaking,
    Finalizing,
    Done,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    AccessibilityDenied,
    MicrophoneDenied,
    MicrophoneMissing,
    AsrStopped,
    RuntimeMissing,
    InsertFailed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorAction {
    OpenAccessibility,
    OpenMicrophone,
    SelectMicrophone,
    RestartAsr,
    StartSetup,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: ErrorCode,
    pub message: String,
    pub action: Option<ErrorAction>,
}

impl AppError {
    pub fn accessibility_denied() -> Self {
        Self {
            code: ErrorCode::AccessibilityDenied,
            message: "アクセシビリティが許可されていないため入力できません".into(),
            action: Some(ErrorAction::OpenAccessibility),
        }
    }
    pub fn microphone_denied() -> Self {
        Self {
            code: ErrorCode::MicrophoneDenied,
            message: "マイクが許可されていません".into(),
            action: Some(ErrorAction::OpenMicrophone),
        }
    }
    // 以下の detail (技術的な詳細・英語のエラー文) は表示せずログにだけ残す。
    // 表示はメニューの1行・パネルのピルに収まる短い文言にする (デザイン 06)
    pub fn microphone_missing(detail: impl std::fmt::Display) -> Self {
        log::warn!("マイクを使用できない: {detail}");
        Self {
            code: ErrorCode::MicrophoneMissing,
            message: "マイクが見つかりません".into(),
            action: Some(ErrorAction::SelectMicrophone),
        }
    }
    pub fn asr_stopped(detail: impl std::fmt::Display) -> Self {
        log::warn!("文字起こしサーバーの停止: {detail}");
        Self {
            code: ErrorCode::AsrStopped,
            message: "文字起こしサーバーが停止しました".into(),
            action: Some(ErrorAction::RestartAsr),
        }
    }
    pub fn runtime_missing() -> Self {
        Self {
            code: ErrorCode::RuntimeMissing,
            message: "実行環境とモデルが導入されていません".into(),
            action: Some(ErrorAction::StartSetup),
        }
    }
    pub fn insert_failed(detail: impl std::fmt::Display) -> Self {
        log::warn!("入力の失敗: {detail}");
        Self {
            code: ErrorCode::InsertFailed,
            message: "入力に失敗しました".into(),
            action: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStatus {
    pub phase: Phase,
    pub loading_progress: Option<f64>,
    pub error: Option<AppError>,
}

#[derive(Debug, Default)]
struct Facts {
    asr_ready: bool,
    loading_progress: Option<f64>,
    listening: bool,
    speaking: bool,
    finalizing: usize,
    done_until: Option<Instant>,
    error: Option<AppError>,
}

impl Facts {
    fn status(&self, now: Instant) -> AppStatus {
        let phase = if self.error.is_some() {
            Phase::Error
        } else if !self.asr_ready {
            Phase::Loading
        } else if self.listening && self.speaking {
            Phase::Speaking
        } else if self.finalizing > 0 {
            // OFF後も確定処理中のものは最後まで処理するため、OFFより優先して表示する
            Phase::Finalizing
        } else if !self.listening {
            Phase::Off
        } else if self.done_until.is_some_and(|t| t > now) {
            Phase::Done
        } else {
            Phase::Listening
        };
        AppStatus {
            phase,
            loading_progress: if phase == Phase::Loading {
                self.loading_progress
            } else {
                None
            },
            error: self.error.clone(),
        }
    }
}

type Listener = Arc<dyn Fn(&AppStatus) + Send + Sync>;

pub struct StateManager {
    facts: Mutex<(Facts, Option<AppStatus>)>,
    listeners: Mutex<Vec<Listener>>,
}

impl Default for StateManager {
    fn default() -> Self {
        Self::new()
    }
}

impl StateManager {
    pub fn new() -> Self {
        Self {
            facts: Mutex::new((Facts::default(), None)),
            listeners: Mutex::new(Vec::new()),
        }
    }

    pub fn subscribe(&self, f: impl Fn(&AppStatus) + Send + Sync + 'static) {
        lock(&self.listeners).push(Arc::new(f));
    }

    pub fn status(&self) -> AppStatus {
        lock(&self.facts).0.status(Instant::now())
    }

    pub fn is_listening(&self) -> bool {
        lock(&self.facts).0.listening
    }

    pub fn is_asr_ready(&self) -> bool {
        lock(&self.facts).0.asr_ready
    }

    pub fn error(&self) -> Option<AppError> {
        lock(&self.facts).0.error.clone()
    }

    pub fn set_asr_ready(&self, ready: bool) {
        self.mutate(|f| {
            f.asr_ready = ready;
            f.loading_progress = None;
        });
    }

    pub fn set_listening(&self, on: bool) {
        self.mutate(|f| {
            f.listening = on;
            if !on {
                f.speaking = false;
                f.done_until = None;
            }
        });
    }

    pub fn set_speaking(&self, speaking: bool) {
        self.mutate(|f| {
            f.speaking = speaking;
            if speaking {
                f.done_until = None;
            }
        });
    }

    pub fn finalizing_started(&self) {
        self.mutate(|f| f.finalizing += 1);
    }

    /// 確定処理が1件終わった。`inserted` なら「完了」表示を始める。
    pub fn finalizing_finished(&self, inserted: bool) {
        self.mutate(|f| {
            f.finalizing = f.finalizing.saturating_sub(1);
            if inserted {
                f.done_until = Some(Instant::now() + DONE_DISPLAY);
            }
        });
    }

    /// エラーを設定する。エラー時は音声入力を自動でOFFにする (呼び出し側で録音も止めること)。
    pub fn set_error(&self, error: AppError) {
        self.mutate(|f| {
            f.error = Some(error);
            f.listening = false;
            f.speaking = false;
        });
    }

    pub fn clear_error(&self) {
        self.mutate(|f| f.error = None);
    }

    /// 時間経過で変わる状態 (完了表示の終了) を反映する。
    pub fn refresh(&self) {
        self.mutate(|_| {});
    }

    fn mutate(&self, f: impl FnOnce(&mut Facts)) {
        let changed = {
            let mut guard = lock(&self.facts);
            f(&mut guard.0);
            let status = guard.0.status(Instant::now());
            if guard.1.as_ref() == Some(&status) {
                false
            } else {
                guard.1 = Some(status);
                true
            }
        };
        // 購読者の中から再入 (状態の変更・購読の追加) しても詰まらないよう、どのロックも持たずに通知する。
        // 複数スレッドから同時に変更されると通知の順序が前後しうるため、渡すのは通知時点の最新の状態にする
        // (最後に届く通知が必ず最新になる)
        if changed {
            let listeners: Vec<Listener> = lock(&self.listeners).clone();
            let status = self.status();
            for l in &listeners {
                l(&status);
            }
        }
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    // 通知先がpanicしても状態管理自体は続けられるよう、poisonは無視する
    m.lock().unwrap_or_else(|p| p.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phase_transitions() {
        let s = StateManager::new();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let seen2 = seen.clone();
        s.subscribe(move |st| seen2.lock().unwrap().push(st.phase));
        assert_eq!(s.status().phase, Phase::Loading);
        s.set_asr_ready(true);
        s.set_listening(true);
        s.set_speaking(true);
        s.set_speaking(false);
        s.finalizing_started();
        s.finalizing_finished(true);
        s.set_listening(false);
        s.set_error(AppError::accessibility_denied());
        assert_eq!(
            *seen.lock().unwrap(),
            vec![
                Phase::Off,
                Phase::Listening,
                Phase::Speaking,
                Phase::Listening,
                Phase::Finalizing,
                Phase::Done,
                Phase::Off,
                Phase::Error
            ]
        );
        assert!(!s.is_listening());
    }

    #[test]
    fn listener_can_reenter() {
        let s = Arc::new(StateManager::new());
        let s2 = s.clone();
        s.subscribe(move |st| {
            // 通知の中から状態を読み、購読を追加しても詰まらない
            let _ = s2.status();
            if st.phase == Phase::Off {
                s2.subscribe(|_| {});
            }
        });
        s.set_asr_ready(true);
        s.set_listening(true);
        assert_eq!(s.status().phase, Phase::Listening);
    }

    #[test]
    fn finalizing_shown_after_off() {
        let s = StateManager::new();
        s.set_asr_ready(true);
        s.set_listening(true);
        s.finalizing_started();
        s.set_listening(false);
        assert_eq!(s.status().phase, Phase::Finalizing);
        s.finalizing_finished(true);
        assert_eq!(s.status().phase, Phase::Off);
    }

    #[test]
    fn serializes_per_contract() {
        let s = StateManager::new();
        s.set_error(AppError::accessibility_denied());
        let v = serde_json::to_value(s.status()).unwrap();
        assert_eq!(v["phase"], "error");
        assert_eq!(v["loadingProgress"], serde_json::Value::Null);
        assert_eq!(v["error"]["code"], "accessibility_denied");
        assert_eq!(v["error"]["action"], "open_accessibility");
    }
}
