//! アプリ状態 (`Phase`) の一元管理。
//!
//! 個々の事実 (ON/OFF、ASR準備完了、発話中、確定処理中の件数、エラー) だけを保持し、
//! `Phase` はそこから導出する。遷移のたびに購読者 (Tauri event・メニュー) へ通知する。

use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::i18n::Msg;

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
    /// 発話検出 (VAD) の初期化に失敗した。マイクの問題ではないため別のコードにする
    VadFailed,
}

impl ErrorCode {
    /// 表示用の文言。message は code だけから決まる (表示言語の変更時に code から作り直す)
    pub fn message(self) -> Msg {
        match self {
            Self::AccessibilityDenied => Msg::ErrAccessibilityDenied,
            Self::MicrophoneDenied => Msg::ErrMicrophoneDenied,
            Self::MicrophoneMissing => Msg::ErrMicrophoneMissing,
            Self::AsrStopped => Msg::ErrAsrStopped,
            Self::RuntimeMissing => Msg::ErrRuntimeMissing,
            Self::InsertFailed => Msg::ErrInsertFailed,
            Self::VadFailed => Msg::ErrVadFailed,
        }
    }
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
    /// 表示用 (作った時点の表示言語)。表示言語の変更時は `StateManager::relocalize` が code から作り直す
    pub message: String,
    pub action: Option<ErrorAction>,
}

impl AppError {
    fn new(code: ErrorCode, action: Option<ErrorAction>) -> Self {
        Self {
            code,
            message: code.message().to_string(),
            action,
        }
    }
    pub fn accessibility_denied() -> Self {
        Self::new(
            ErrorCode::AccessibilityDenied,
            Some(ErrorAction::OpenAccessibility),
        )
    }
    pub fn microphone_denied() -> Self {
        Self::new(
            ErrorCode::MicrophoneDenied,
            Some(ErrorAction::OpenMicrophone),
        )
    }
    // 以下の detail (技術的な詳細・英語のエラー文) は表示せずログにだけ残す。
    // 表示はメニューの1行・パネルのピルに収まる短い文言にする (デザイン 06)
    pub fn microphone_missing(detail: impl std::fmt::Display) -> Self {
        log::warn!("マイクを使用できない: {detail}");
        Self::new(
            ErrorCode::MicrophoneMissing,
            Some(ErrorAction::SelectMicrophone),
        )
    }
    pub fn asr_stopped(detail: impl std::fmt::Display) -> Self {
        log::warn!("文字起こしサーバーの停止: {detail}");
        Self::new(ErrorCode::AsrStopped, Some(ErrorAction::RestartAsr))
    }
    pub fn runtime_missing() -> Self {
        Self::new(ErrorCode::RuntimeMissing, Some(ErrorAction::StartSetup))
    }
    pub fn vad_failed(detail: impl std::fmt::Display) -> Self {
        log::warn!("発話検出の初期化の失敗: {detail}");
        Self::new(ErrorCode::VadFailed, None)
    }
    pub fn insert_failed(detail: impl std::fmt::Display) -> Self {
        log::warn!("入力の失敗: {detail}");
        Self::new(ErrorCode::InsertFailed, None)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStatus {
    pub phase: Phase,
    pub loading_progress: Option<f64>,
    pub error: Option<AppError>,
    /// 状態が変わるたびに増える通番。通知が前後して届いても、受け手は古いものを捨てられる
    /// (`get_status` の応答と `status-changed` の前後も含む)
    pub seq: u64,
}

impl AppStatus {
    /// 通番以外が同じか
    fn same_state(&self, o: &AppStatus) -> bool {
        self.phase == o.phase
            && self.loading_progress == o.loading_progress
            && self.error == o.error
    }
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
            seq: 0,
        }
    }
}

type Listener = Arc<dyn Fn(&AppStatus) + Send + Sync>;

pub struct StateManager {
    /// 事実と、最後に計算した状態 (通番付き)
    facts: Mutex<(Facts, AppStatus)>,
    listeners: Mutex<Vec<Listener>>,
    /// 通知の依頼数。0 でなければ送り手がいる (`deliver`)
    pending: AtomicUsize,
    /// 最後に通知した通番 (送り手だけが読み書きする)
    last_sent: AtomicU64,
}

impl Default for StateManager {
    fn default() -> Self {
        Self::new()
    }
}

impl StateManager {
    pub fn new() -> Self {
        let facts = Facts::default();
        let status = facts.status(Instant::now());
        Self {
            facts: Mutex::new((facts, status)),
            listeners: Mutex::new(Vec::new()),
            pending: AtomicUsize::new(0),
            last_sent: AtomicU64::new(0),
        }
    }

    pub fn subscribe(&self, f: impl Fn(&AppStatus) + Send + Sync + 'static) {
        lock(&self.listeners).push(Arc::new(f));
    }

    /// 最後に確定した状態 (通番付き)。
    pub fn status(&self) -> AppStatus {
        lock(&self.facts).1.clone()
    }

    pub fn is_listening(&self) -> bool {
        lock(&self.facts).0.listening
    }

    /// ON で発話中か (VAD が発話を検出してから確定・破棄まで)
    pub fn is_speaking(&self) -> bool {
        let f = &lock(&self.facts).0;
        f.listening && f.speaking
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

    /// 表示言語の変更時: エラーの文言を今の表示言語で作り直す (変われば status-changed が送られる)
    pub fn relocalize(&self) {
        self.mutate(|f| {
            if let Some(e) = f.error.as_mut() {
                e.message = e.code.message().to_string();
            }
        });
    }

    /// 時間経過で変わる状態 (完了表示の終了) を反映する。
    pub fn refresh(&self) {
        self.mutate(|_| {});
    }

    fn mutate(&self, f: impl FnOnce(&mut Facts)) {
        let changed = {
            let mut guard = lock(&self.facts);
            f(&mut guard.0);
            let mut status = guard.0.status(Instant::now());
            if status.same_state(&guard.1) {
                false
            } else {
                status.seq = guard.1.seq + 1;
                guard.1 = status;
                true
            }
        };
        if changed {
            self.deliver();
        }
    }

    /// 購読者へ最新の状態を通知する。
    ///
    /// 複数スレッドから同時に変更されても通知が古い状態で終わらないよう、送り手を1つにする。
    /// `pending` は通知の依頼数で、0 から増やしたスレッドが送り手になる。他のスレッド (通知の中からの
    /// 再入を含む) は依頼数を増やすだけで戻り、送り手が代わりに最新の状態を送る。
    /// 送り手は1回送るごとに、送る前に見た依頼数を引き、その間に増えていれば送り直す。
    /// 判断と「降りる」が同じ1つの不可分操作 (fetch_sub) なので、降りる直前に来た依頼を取りこぼさない
    /// (mutex の try_lock 方式では、判断してからロックを離すまでに来た依頼を失っていた)。
    /// 購読者の中から状態の変更・購読の追加をしても詰まらない (facts・listeners のロックは持たずに呼ぶ)
    fn deliver(&self) {
        if self.pending.fetch_add(1, Ordering::AcqRel) != 0 {
            return;
        }
        // 購読者が panic しても送り手の役を解放し、以後の通知を止めない
        let reset = ResetOnPanic(&self.pending);
        loop {
            // 依頼数を読んでから状態を読む: ここまでの依頼を出したスレッドの変更は必ず見える
            let requested = self.pending.load(Ordering::Acquire);
            let status = self.status();
            if status.seq > self.last_sent.load(Ordering::Relaxed) {
                self.last_sent.store(status.seq, Ordering::Relaxed);
                let listeners: Vec<Listener> = lock(&self.listeners).clone();
                for l in &listeners {
                    l(&status);
                }
            }
            release_window();
            let before = self.pending.fetch_sub(requested, Ordering::AcqRel);
            if before == requested {
                break;
            }
        }
        std::mem::forget(reset);
    }
}

/// 送り手が panic で抜けた時に依頼数を 0 に戻す (次の変更で新しい送り手が立つように)
struct ResetOnPanic<'a>(&'a AtomicUsize);

impl Drop for ResetOnPanic<'_> {
    fn drop(&mut self) {
        self.0.store(0, Ordering::Release);
    }
}

/// テスト用: 送り手が「新しい通番はない」と判断してから送り手を降りるまでの間を広げ、
/// 取りこぼしの競合を再現しやすくする
#[inline]
fn release_window() {
    #[cfg(test)]
    std::thread::sleep(Duration::from_micros(20));
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
        assert_eq!(v["seq"], 1);
    }

    #[test]
    fn seq_increments_only_on_change() {
        let s = StateManager::new();
        assert_eq!(s.status().seq, 0);
        s.set_asr_ready(true);
        assert_eq!(s.status().seq, 1);
        s.set_asr_ready(true);
        s.refresh();
        assert_eq!(s.status().seq, 1);
        s.set_listening(true);
        assert_eq!(s.status().seq, 2);
    }

    /// 複数スレッドから同時に変更しても、通知は通番の昇順で、最後の通知が最新の状態になる。
    #[test]
    fn concurrent_notifications_end_in_latest_state() {
        for _ in 0..50 {
            let s = Arc::new(StateManager::new());
            s.set_asr_ready(true);
            let seen = Arc::new(Mutex::new(Vec::<AppStatus>::new()));
            let seen2 = seen.clone();
            s.subscribe(move |st| {
                // 通知中に他のスレッドが割り込みやすくする
                std::thread::yield_now();
                seen2.lock().unwrap().push(st.clone());
            });
            let threads: Vec<_> = (0..4)
                .map(|t| {
                    let s = s.clone();
                    std::thread::spawn(move || {
                        for i in 0..50 {
                            match (t + i) % 3 {
                                0 => s.set_listening(i % 2 == 0),
                                1 => s.set_speaking(i % 2 == 0),
                                _ => s.finalizing_started(),
                            }
                        }
                    })
                })
                .collect();
            for t in threads {
                t.join().unwrap();
            }
            let seen = seen.lock().unwrap();
            assert!(seen.windows(2).all(|w| w[0].seq < w[1].seq));
            assert_eq!(seen.last(), Some(&s.status()));
        }
    }

    /// 通知中のスレッドが「新しい通番はない」と判断してから送り手を降りるまでの間に、他のスレッドが
    /// 変更して通知を諦める、という取りこぼしが起きないこと。多数のスレッドを barrier で同時に
    /// 走らせ、毎回必ず通番が増える変更 (メッセージの異なるエラー) を繰り返す
    #[test]
    fn no_lost_wakeup_under_contention() {
        const THREADS: usize = 8;
        const PER_THREAD: usize = 20;
        for round in 0..300 {
            let s = Arc::new(StateManager::new());
            let seen = Arc::new(Mutex::new(Vec::<u64>::new()));
            let seen2 = seen.clone();
            s.subscribe(move |st| {
                std::thread::yield_now();
                seen2.lock().unwrap().push(st.seq);
            });
            let barrier = Arc::new(std::sync::Barrier::new(THREADS));
            let threads: Vec<_> = (0..THREADS)
                .map(|t| {
                    let s = s.clone();
                    let barrier = barrier.clone();
                    std::thread::spawn(move || {
                        barrier.wait();
                        for i in 0..PER_THREAD {
                            s.set_error(AppError {
                                code: ErrorCode::InsertFailed,
                                message: format!("{t}-{i}"),
                                action: None,
                            });
                        }
                    })
                })
                .collect();
            for t in threads {
                t.join().unwrap();
            }
            let latest = s.status().seq;
            assert_eq!(latest, (THREADS * PER_THREAD) as u64);
            let seen = seen.lock().unwrap();
            assert!(seen.windows(2).all(|w| w[0] < w[1]), "round {round}");
            assert_eq!(seen.last(), Some(&latest), "round {round}");
        }
    }

    #[test]
    fn relocalize_rebuilds_message_from_code() {
        let s = StateManager::new();
        s.set_error(AppError {
            code: ErrorCode::AsrStopped,
            message: "stale".into(),
            action: Some(ErrorAction::RestartAsr),
        });
        let seq = s.status().seq;
        s.relocalize();
        let st = s.status();
        let e = st.error.unwrap();
        assert_eq!(e.message, Msg::ErrAsrStopped.to_string());
        assert_eq!(e.action, Some(ErrorAction::RestartAsr));
        assert_eq!(st.seq, seq + 1, "変われば status-changed を送る");
        s.relocalize();
        assert_eq!(s.status().seq, seq + 1, "同じなら送らない");
        // エラーが無ければ何もしない
        let s = StateManager::new();
        s.relocalize();
        assert_eq!(s.status().seq, 0);
    }

    #[test]
    fn reentrant_change_is_delivered() {
        let s = Arc::new(StateManager::new());
        let s2 = s.clone();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let seen2 = seen.clone();
        s.subscribe(move |st| {
            seen2.lock().unwrap().push(st.phase);
            // 通知の中から変更しても、その変更は後で通知される
            if st.phase == Phase::Off {
                s2.set_listening(true);
            }
        });
        s.set_asr_ready(true);
        assert_eq!(*seen.lock().unwrap(), vec![Phase::Off, Phase::Listening]);
    }
}
