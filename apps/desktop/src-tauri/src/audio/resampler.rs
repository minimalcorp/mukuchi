//! 任意のサンプルレートから 16kHz への変換と、固定長フレームへの分割。
//!
//! cjpais/Handy (MIT License, Copyright (c) 2025 CJ Pais) の
//! `src-tauri/src/audio_toolkit/audio/resampler.rs` を元にしている。
//! 変更点: 生成失敗を panic ではなくエラーで返す、unwrap の除去、録音停止時は残りを捨てるため
//! `finish()` を削除 (OFF時は発話中の音声を破棄する仕様のため不要)。

use anyhow::{anyhow, Result};
use rubato::{FftFixedIn, Resampler};

const CHUNK_IN: usize = 1024;

pub struct FrameResampler {
    resampler: Option<FftFixedIn<f32>>,
    in_buf: Vec<f32>,
    frame_samples: usize,
    pending: Vec<f32>,
}

impl FrameResampler {
    pub fn new(in_hz: usize, out_hz: usize, frame_samples: usize) -> Result<Self> {
        if frame_samples == 0 {
            anyhow::bail!("frame_samples は1以上");
        }
        let resampler = if in_hz == out_hz {
            None
        } else {
            Some(
                FftFixedIn::<f32>::new(in_hz, out_hz, CHUNK_IN, 1, 1)
                    .map_err(|e| anyhow!("リサンプラの作成に失敗 ({in_hz}Hz → {out_hz}Hz): {e}"))?,
            )
        };
        Ok(Self {
            resampler,
            in_buf: Vec::with_capacity(CHUNK_IN),
            frame_samples,
            pending: Vec::with_capacity(frame_samples),
        })
    }

    /// サンプルを入れ、`frame_samples` 個そろうごとに `emit` を呼ぶ。
    pub fn push(&mut self, mut src: &[f32], mut emit: impl FnMut(&[f32])) {
        let Some(resampler) = self.resampler.as_mut() else {
            Self::emit_frames(&mut self.pending, self.frame_samples, src, &mut emit);
            return;
        };
        while !src.is_empty() {
            let take = (CHUNK_IN - self.in_buf.len()).min(src.len());
            self.in_buf.extend_from_slice(&src[..take]);
            src = &src[take..];
            if self.in_buf.len() == CHUNK_IN {
                match resampler.process(&[&self.in_buf[..]], None) {
                    Ok(out) => {
                        Self::emit_frames(&mut self.pending, self.frame_samples, &out[0], &mut emit)
                    }
                    Err(e) => log::warn!("リサンプルに失敗したチャンクを捨てる: {e}"),
                }
                self.in_buf.clear();
            }
        }
    }

    fn emit_frames(
        pending: &mut Vec<f32>,
        frame_samples: usize,
        mut data: &[f32],
        emit: &mut impl FnMut(&[f32]),
    ) {
        while !data.is_empty() {
            let take = (frame_samples - pending.len()).min(data.len());
            pending.extend_from_slice(&data[..take]);
            data = &data[take..];
            if pending.len() == frame_samples {
                emit(pending);
                pending.clear();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passthrough_frames() {
        let mut r = FrameResampler::new(16000, 16000, 512).unwrap();
        let mut frames = 0;
        r.push(&vec![0.1; 1500], |f| {
            assert_eq!(f.len(), 512);
            frames += 1;
        });
        assert_eq!(frames, 2);
        r.push(&vec![0.1; 100], |_| frames += 1);
        assert_eq!(frames, 3);
    }

    #[test]
    fn downsamples_48k_to_16k() {
        let mut r = FrameResampler::new(48000, 16000, 512).unwrap();
        let sine: Vec<f32> = (0..48000)
            .map(|i| (2.0 * std::f32::consts::PI * 440.0 * i as f32 / 48000.0).sin() * 0.5)
            .collect();
        let mut out = Vec::new();
        r.push(&sine, |f| out.extend_from_slice(f));
        // 1秒 → 約16000サンプル (FFTの遅延ぶん少し少ない)
        assert!(out.len() > 14000 && out.len() <= 16000, "{}", out.len());
        let peak = out.iter().fold(0.0f32, |m, s| m.max(s.abs()));
        assert!(peak > 0.4 && peak < 0.6, "{peak}");
    }
}
