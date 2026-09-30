//! 発話検出 (VAD)。
//!
//! - `VoiceActivityDetector`: フレームごとの発話確率を返す検出器 (Silero を差し替え可能にするtrait)
//! - `Segmenter`: 確率と音量から発話区間を切り出す状態機械 (値は implementation-plan.md 2.)

mod segmenter;
mod silero;

pub use segmenter::{SegmentEvent, Segmenter};
pub use silero::SileroVad;

use anyhow::Result;

pub const SAMPLE_RATE: u32 = 16_000;

/// 1フレームのサンプル数。Silero v5 の 16kHz 入力は 512 サンプル (32ms) 固定。
pub const FRAME_SAMPLES: usize = 512;
pub const FRAME_MS: f64 = FRAME_SAMPLES as f64 * 1000.0 / SAMPLE_RATE as f64;

pub trait VoiceActivityDetector: Send {
    /// `FRAME_SAMPLES` 個の 16kHz mono サンプルを受け取り、発話確率 (0..1) を返す。
    fn predict(&mut self, frame: &[f32]) -> Result<f32>;
    /// 内部状態 (RNNの状態など) を初期化する。録音の開始ごとに呼ぶ。
    fn reset(&mut self);
}

/// 話し始めの前に含める音声 (語頭が切れない)
pub const PRE_SPEECH_PAD_MS: u32 = 300;
/// 開始しきい値に届く前の小さな語頭を遡って含める上限
pub const ONSET_LOOKBACK_MS: u32 = 1000;
/// これ未満の発話は誤検出 (咳・物音) として破棄する
pub const MIN_SPEECH_MS: u32 = 300;
/// 確定時、無音待ちに使った末尾のうち残す長さ (無音はハルシネーションの原因)
pub const KEEP_TAIL_MS: u32 = 300;
/// ASRサーバーの上限 (5MiB ≒ 160秒) に達する前に強制的に区切る
pub const MAX_SPEECH_MS: u32 = 100_000;

/// 入力レベル表示の範囲 (dBFS)。-60〜-10dB を 0〜1 に対応付ける
pub const LEVEL_MIN_DB: f32 = -60.0;
pub const LEVEL_MAX_DB: f32 = -10.0;

/// 発話検出のパラメータ。
#[derive(Debug, Clone, PartialEq)]
pub struct VadParams {
    /// 発話開始とみなす確率
    pub positive_threshold: f32,
    /// 発話継続とみなす確率 (ヒステリシス)
    pub negative_threshold: f32,
    /// 発話開始に必要な音量の下限 (dBFS)。無音で「はい、」等が出る問題の対策
    pub floor_db: f32,
    pub pre_pad_frames: usize,
    /// 発話開始時に、継続しきい値以上のフレームを遡って含める上限
    pub lookback_frames: usize,
    pub redemption_frames: usize,
    pub min_speech_frames: usize,
    pub keep_tail_frames: usize,
    pub max_speech_frames: usize,
}

pub fn ms_to_frames(ms: u32) -> usize {
    (ms as f64 / FRAME_MS).ceil() as usize
}

impl VadParams {
    /// 感度 (0..100) と話し終わりの無音 (ms) から求める。
    ///
    /// 既定の感度60で Silero 推奨値 (開始0.5 / 継続0.35) になるよう対応付ける。
    /// 感度を上げるほど確率と音量のしきい値が下がる (小さな声も拾う)。
    pub fn from_settings(sensitivity: u32, silence_ms: u32) -> Self {
        let s = sensitivity.min(100) as f32;
        // 0 → 0.8, 60 → 0.5, 100 → 0.3
        let positive = (0.5 + (60.0 - s) * 0.005).clamp(0.05, 0.95);
        let negative = (positive - 0.15).max(0.02);
        // 0 → -30dB, 60 → -45dB, 100 → -55dB
        let floor_db = -45.0 + (60.0 - s) * 0.25;
        Self {
            positive_threshold: positive,
            negative_threshold: negative,
            floor_db,
            pre_pad_frames: ms_to_frames(PRE_SPEECH_PAD_MS),
            lookback_frames: ms_to_frames(ONSET_LOOKBACK_MS),
            redemption_frames: ms_to_frames(silence_ms).max(1),
            min_speech_frames: ms_to_frames(MIN_SPEECH_MS),
            keep_tail_frames: ms_to_frames(KEEP_TAIL_MS),
            max_speech_frames: ms_to_frames(MAX_SPEECH_MS),
        }
    }

    /// 音量の下限を表示用 (0..1) に正規化した値 (`audio-level` の threshold)。
    pub fn floor_level(&self) -> f32 {
        normalize_db(self.floor_db)
    }
}

/// RMS を dBFS で返す。無音は `LEVEL_MIN_DB` 未満の有限値に丸める。
pub fn rms_db(frame: &[f32]) -> f32 {
    if frame.is_empty() {
        return -120.0;
    }
    let mean_sq = frame.iter().map(|s| s * s).sum::<f32>() / frame.len() as f32;
    let rms = mean_sq.sqrt();
    if rms <= 1e-6 {
        -120.0
    } else {
        20.0 * rms.log10()
    }
}

pub fn normalize_db(db: f32) -> f32 {
    ((db - LEVEL_MIN_DB) / (LEVEL_MAX_DB - LEVEL_MIN_DB)).clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_sensitivity_gives_silero_recommended_thresholds() {
        let p = VadParams::from_settings(60, 1300);
        assert!((p.positive_threshold - 0.5).abs() < 1e-6);
        assert!((p.negative_threshold - 0.35).abs() < 1e-6);
        assert_eq!(p.pre_pad_frames, 10); // 320ms >= 300ms
        assert_eq!(p.redemption_frames, 41); // 1312ms >= 1300ms
        assert_eq!(p.min_speech_frames, 10);
        assert_eq!(p.keep_tail_frames, 10);
    }

    #[test]
    fn sensitivity_is_monotonic() {
        let lo = VadParams::from_settings(0, 1300);
        let hi = VadParams::from_settings(100, 1300);
        assert!(lo.positive_threshold > hi.positive_threshold);
        assert!(lo.floor_db > hi.floor_db);
        assert!(hi.negative_threshold > 0.0);
    }

    #[test]
    fn level_normalization() {
        assert_eq!(normalize_db(-80.0), 0.0);
        assert_eq!(normalize_db(0.0), 1.0);
        assert!((normalize_db(-35.0) - 0.5).abs() < 1e-6);
        let full = vec![1.0f32; 512];
        assert!(rms_db(&full).abs() < 1e-3);
        assert!(rms_db(&[0.0; 512]) < LEVEL_MIN_DB);
    }
}
