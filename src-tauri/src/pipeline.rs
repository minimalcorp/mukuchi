//! 録音 → VAD → 発話の切り出し を行う処理スレッド。
//!
//! cpal のコールバックからはチャネルで音声を受け取るだけにし、リサンプル・VAD 推論はこのスレッドで行う。
//! 切り出した発話は [`PipelineSink`] に渡し、確定処理 (ASR→入力キュー) はスレッド外で行う
//! (このスレッドを ASR 待ちで止めない)。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::RecvTimeoutError;
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use anyhow::{Context, Result};

use crate::audio::{self, resampler::FrameResampler, AudioMsg, Capture, Source};
use crate::vad::{
    self, normalize_db, rms_db, SegmentEvent, Segmenter, SileroVad, VadParams,
    VoiceActivityDetector, FRAME_SAMPLES, SAMPLE_RATE,
};

/// `audio-level` を送る間隔 (約20Hz)
const LEVEL_INTERVAL_SAMPLES: usize = SAMPLE_RATE as usize / 20;
/// 設定 (感度・無音時間) を読み直す間隔
const PARAMS_REFRESH_FRAMES: usize = 16;

/// 処理スレッドからの通知先。
pub trait PipelineSink: Send + Sync {
    fn vad_params(&self) -> VadParams;
    fn next_utterance_id(&self) -> u64;
    fn audio_level(&self, level: f32, threshold: f32, speech: bool);
    fn utterance_started(&self, id: u64);
    /// 話し終わった発話。確定処理 (ASR→入力) を始める
    fn utterance_ended(&self, id: u64, audio: Vec<f32>);
    /// 誤検出・OFFによる破棄
    fn utterance_discarded(&self, id: u64);
    /// デバイス切断など、録音を続けられない
    fn capture_lost(&self, message: String);
}

pub struct Running {
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
    // worker より後に drop する (録音を止めるのは worker の終了後)
    _capture: Capture,
}

impl Running {
    /// 録音を止める。発話中のものは破棄し (`utterance_discarded`)、確定処理中のものはそのまま続く。
    pub fn stop(mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(w) = self.worker.take() {
            let _ = w.join();
        }
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

pub fn start(source: Source, sink: Arc<dyn PipelineSink>) -> Result<Running> {
    // VAD の読み込み失敗は録音開始前に検出する
    let mut vad = SileroVad::new().context("VAD を初期化できません")?;
    vad.reset();
    let (capture, rx) = audio::start(source)?;
    let mut resampler = FrameResampler::new(
        capture.sample_rate as usize,
        SAMPLE_RATE as usize,
        FRAME_SAMPLES,
    )?;
    let stop = Arc::new(AtomicBool::new(false));
    let stop2 = stop.clone();
    let worker = std::thread::Builder::new()
        .name("mukuchi-pipeline".into())
        .spawn(move || {
            let mut proc = Processor::new(vad, sink.clone());
            loop {
                if stop2.load(Ordering::SeqCst) {
                    break;
                }
                match rx.recv_timeout(Duration::from_millis(100)) {
                    Ok(AudioMsg::Samples(buf)) => {
                        resampler.push(&buf, |frame| proc.frame(frame));
                    }
                    Ok(AudioMsg::Lost(msg)) => {
                        proc.abort();
                        sink.capture_lost(msg);
                        return;
                    }
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => {
                        proc.abort();
                        sink.capture_lost("録音が停止しました".into());
                        return;
                    }
                }
            }
            proc.abort();
        })
        .context("処理スレッドを起動できません")?;
    Ok(Running {
        stop,
        worker: Some(worker),
        _capture: capture,
    })
}

/// フレーム単位の処理。スレッドから切り離してテストできるようにする。
pub struct Processor<V: VoiceActivityDetector> {
    vad: V,
    segmenter: Segmenter,
    sink: Arc<dyn PipelineSink>,
    current: Option<u64>,
    frames: usize,
    level_samples: usize,
    level_peak_db: f32,
    vad_failed: bool,
}

impl<V: VoiceActivityDetector> Processor<V> {
    pub fn new(vad: V, sink: Arc<dyn PipelineSink>) -> Self {
        let params = sink.vad_params();
        Self {
            vad,
            segmenter: Segmenter::new(params),
            sink,
            current: None,
            frames: 0,
            level_samples: 0,
            level_peak_db: f32::MIN,
            vad_failed: false,
        }
    }

    pub fn frame(&mut self, frame: &[f32]) {
        self.frames += 1;
        if self.frames.is_multiple_of(PARAMS_REFRESH_FRAMES) {
            let p = self.sink.vad_params();
            if &p != self.segmenter.params() {
                self.segmenter.set_params(p);
            }
        }
        let db = rms_db(frame);
        let prob = match self.vad.predict(frame) {
            Ok(p) => p,
            Err(e) => {
                // 1フレームの失敗で録音全体を止めない。ログが溢れないよう初回だけ記録する
                if !self.vad_failed {
                    log::error!("VAD の推論に失敗: {e:#}");
                    self.vad_failed = true;
                }
                0.0
            }
        };

        match self.segmenter.push(frame, prob, db) {
            Some(SegmentEvent::Started) => {
                let id = self.sink.next_utterance_id();
                self.current = Some(id);
                self.sink.utterance_started(id);
            }
            Some(SegmentEvent::Ended { audio }) => {
                if let Some(id) = self.current.take() {
                    self.sink.utterance_ended(id, audio);
                }
            }
            Some(SegmentEvent::Misfire) => {
                if let Some(id) = self.current.take() {
                    self.sink.utterance_discarded(id);
                }
            }
            None => {
                // TODO(P2): 途中表示。発話中 (self.segmenter.current_audio()) の長さが前回の要求から
                // 0.8秒以上伸び、かつ途中表示の要求が処理中でなければ ASR に送り utterance-partial を出す
            }
        }

        self.level_samples += frame.len();
        self.level_peak_db = self.level_peak_db.max(db);
        if self.level_samples >= LEVEL_INTERVAL_SAMPLES {
            let threshold = self.segmenter.params().floor_level();
            self.sink.audio_level(
                normalize_db(self.level_peak_db),
                threshold,
                self.segmenter.is_speaking(),
            );
            self.level_samples = 0;
            self.level_peak_db = f32::MIN;
        }
    }

    /// OFF・停止時。発話中のものは破棄する。
    pub fn abort(&mut self) {
        if self.segmenter.abort() {
            if let Some(id) = self.current.take() {
                self.sink.utterance_discarded(id);
            }
        }
        self.vad.reset();
    }
}

/// 発話区間の検出を WAV に対して行う (テスト・調整用)。発話ごとの音声を返す。
#[allow(dead_code)]
pub fn segment_samples(samples_16k: &[f32], params: VadParams) -> Result<Vec<Vec<f32>>> {
    let mut vad = SileroVad::new()?;
    let mut seg = Segmenter::new(params);
    let mut out = Vec::new();
    for frame in samples_16k.as_chunks::<FRAME_SAMPLES>().0 {
        let prob = vad.predict(frame)?;
        if let Some(SegmentEvent::Ended { audio }) = seg.push(frame, prob, vad::rms_db(frame)) {
            out.push(audio);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::AtomicU64;
    use std::sync::Mutex;

    /// リポジトリの smoke WAV (git 管理外) があれば使い、なければ macOS の `say` で作る。
    fn speech_wav(name: &str, text: &str) -> Option<Vec<f32>> {
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../spikes/asr-bench/data/smoke")
            .join(format!("{name}.wav"));
        let path = if repo.exists() {
            repo
        } else {
            let tmp = std::env::temp_dir()
                .join(format!("mukuchi-test-{name}-{}.wav", std::process::id()));
            let ok = std::process::Command::new("say")
                .args(["-o"])
                .arg(&tmp)
                .args(["--data-format=LEI16@16000", text])
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            if !ok {
                eprintln!("skip: {name}.wav がなく say も使えない");
                return None;
            }
            tmp
        };
        let (samples, rate) = audio::read_wav_mono(&path).unwrap();
        assert_eq!(rate, 16000);
        Some(samples)
    }

    fn silence(ms: usize) -> Vec<f32> {
        vec![0.0; ms * 16]
    }

    #[test]
    fn silero_segments_real_speech() {
        let Some(a) = speech_wav("daily01", "今日の午後3時から定例ミーティングがあります。")
        else {
            return;
        };
        let Some(b) = speech_wav("cmd01", "確定") else {
            return;
        };
        let mut signal = silence(1000);
        signal.extend(&a);
        signal.extend(silence(2500));
        signal.extend(&b);
        signal.extend(silence(2500));

        let params = VadParams::from_settings(60, 1300);
        let segs = segment_samples(&signal, params).unwrap();
        assert_eq!(segs.len(), 2, "2つの発話に分かれる");
        for (seg, src) in segs.iter().zip([&a, &b]) {
            let seg_ms = seg.len() / 16;
            let src_ms = src.len() / 16;
            // pre-pad(≤320ms) + 発話 + 末尾(≤320ms) に収まり、無音待ち(1.3秒)は含まない
            assert!(
                seg_ms + 400 >= src_ms && seg_ms <= src_ms + 700,
                "発話 {src_ms}ms に対して切り出し {seg_ms}ms"
            );
        }
    }

    #[test]
    fn silero_ignores_silence_and_low_noise() {
        let mut signal = silence(3000);
        // -70dBFS 程度の雑音
        let mut x: u32 = 1;
        signal.extend((0..48000).map(|_| {
            x = x.wrapping_mul(1664525).wrapping_add(1013904223);
            ((x >> 8) as f32 / (1u32 << 24) as f32 - 0.5) * 0.0006
        }));
        let segs = segment_samples(&signal, VadParams::from_settings(60, 1300)).unwrap();
        assert!(segs.is_empty());
    }

    #[derive(Default)]
    struct Sink {
        ids: AtomicU64,
        log: Mutex<Vec<String>>,
    }

    impl PipelineSink for Sink {
        fn vad_params(&self) -> VadParams {
            VadParams::from_settings(60, 1300)
        }
        fn next_utterance_id(&self) -> u64 {
            self.ids.fetch_add(1, Ordering::SeqCst) + 1
        }
        fn audio_level(&self, _: f32, _: f32, _: bool) {}
        fn utterance_started(&self, id: u64) {
            self.log.lock().unwrap().push(format!("start {id}"));
        }
        fn utterance_ended(&self, id: u64, _: Vec<f32>) {
            self.log.lock().unwrap().push(format!("end {id}"));
        }
        fn utterance_discarded(&self, id: u64) {
            self.log.lock().unwrap().push(format!("discard {id}"));
        }
        fn capture_lost(&self, _: String) {}
    }

    /// 決まった確率を返すVAD
    struct Scripted(Vec<f32>, usize);
    impl VoiceActivityDetector for Scripted {
        fn predict(&mut self, _: &[f32]) -> Result<f32> {
            let p = self.0.get(self.1).copied().unwrap_or(0.0);
            self.1 += 1;
            Ok(p)
        }
        fn reset(&mut self) {}
    }

    #[test]
    fn off_during_speech_discards_current_but_not_finished() {
        let sink = Arc::new(Sink::default());
        let mut probs = vec![0.9; 20];
        probs.extend(vec![0.0; 45]);
        probs.extend(vec![0.9; 20]);
        let mut p = Processor::new(Scripted(probs, 0), sink.clone());
        let loud = vec![0.3f32; FRAME_SAMPLES];
        for _ in 0..85 {
            p.frame(&loud);
        }
        p.abort();
        assert_eq!(
            *sink.log.lock().unwrap(),
            vec!["start 1", "end 1", "start 2", "discard 2"]
        );
    }
}
