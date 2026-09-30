//! Silero VAD v5 (ONNX) を ort で実行する。
//!
//! モデル: `resources/silero/silero_vad.onnx` (snakers4/silero-vad v5.1.2, MIT License。
//! ライセンス全文は `resources/silero/LICENSE`)。
//! 入出力は公式実装 (`utils_vad.py` の `OnnxWrapper`) に合わせる:
//! input = [直前フレームの末尾64サンプル + 512サンプル], state = [2,1,128], sr = int64 スカラー。

use anyhow::{anyhow, Context, Result};
use ort::session::Session;
use ort::value::Tensor;

use super::{VoiceActivityDetector, FRAME_SAMPLES, SAMPLE_RATE};

const MODEL: &[u8] = include_bytes!("../../resources/silero/silero_vad.onnx");
const CONTEXT_SAMPLES: usize = 64;
const STATE_LEN: usize = 2 * 128;

pub struct SileroVad {
    session: Session,
    state: Vec<f32>,
    context: Vec<f32>,
    input: Vec<f32>,
}

impl SileroVad {
    pub fn new() -> Result<Self> {
        let session = Session::builder()
            .map_err(|e| anyhow!("ONNX Runtime の初期化に失敗: {e}"))?
            // 1フレームずつ逐次実行するため、スレッドを増やしても速くならない (公式実装も1)
            .with_intra_threads(1)
            .map_err(|e| anyhow!("intra threads の設定に失敗: {e}"))?
            .with_inter_threads(1)
            .map_err(|e| anyhow!("inter threads の設定に失敗: {e}"))?
            .commit_from_memory(MODEL)
            .map_err(|e| anyhow!("Silero VAD モデルの読み込みに失敗: {e}"))?;
        Ok(Self {
            session,
            state: vec![0.0; STATE_LEN],
            context: vec![0.0; CONTEXT_SAMPLES],
            input: Vec::with_capacity(CONTEXT_SAMPLES + FRAME_SAMPLES),
        })
    }
}

impl VoiceActivityDetector for SileroVad {
    fn predict(&mut self, frame: &[f32]) -> Result<f32> {
        if frame.len() != FRAME_SAMPLES {
            anyhow::bail!(
                "Silero VAD のフレーム長が不正: {} (期待値 {FRAME_SAMPLES})",
                frame.len()
            );
        }
        self.input.clear();
        self.input.extend_from_slice(&self.context);
        self.input.extend_from_slice(frame);

        let input = Tensor::from_array(([1usize, self.input.len()], self.input.clone()))
            .context("input テンソルの作成に失敗")?;
        let state = Tensor::from_array(([2usize, 1, 128], self.state.clone()))
            .context("state テンソルの作成に失敗")?;
        let sr = Tensor::from_array(((), vec![SAMPLE_RATE as i64]))
            .context("sr テンソルの作成に失敗")?;

        let outputs = self
            .session
            .run(ort::inputs! {
                "input" => input,
                "state" => state,
                "sr" => sr,
            })
            .context("Silero VAD の推論に失敗")?;
        let (_, prob) = outputs["output"]
            .try_extract_tensor::<f32>()
            .context("output の取り出しに失敗")?;
        let prob = *prob.first().context("output が空")?;
        let (_, next_state) = outputs["stateN"]
            .try_extract_tensor::<f32>()
            .context("stateN の取り出しに失敗")?;
        if next_state.len() != STATE_LEN {
            anyhow::bail!("stateN の長さが不正: {}", next_state.len());
        }
        self.state.copy_from_slice(next_state);
        self.context
            .copy_from_slice(&frame[FRAME_SAMPLES - CONTEXT_SAMPLES..]);
        Ok(prob)
    }

    fn reset(&mut self) {
        self.state.fill(0.0);
        self.context.fill(0.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn silence_has_low_probability() {
        let mut vad = SileroVad::new().unwrap();
        let frame = vec![0.0f32; FRAME_SAMPLES];
        for _ in 0..10 {
            let p = vad.predict(&frame).unwrap();
            assert!(p < 0.1, "無音の発話確率が高い: {p}");
        }
        assert!(vad.predict(&[0.0; 10]).is_err());
    }
}
