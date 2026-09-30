//! 録音 → VAD → 発話の切り出し を行う処理スレッド。
//!
//! cpal のコールバックからはチャネルで音声を受け取るだけにし、リサンプル・VAD 推論はこのスレッドで行う。
//! 切り出した発話は [`PipelineSink`] に渡し、確定処理 (ASR→入力キュー) はスレッド外で行う
//! (このスレッドを ASR 待ちで止めない)。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};

use crate::audio::{self, resampler::FrameResampler, AudioMsg, Capture, Source};
use crate::vad::{
    self, normalize_db, rms_db, SegmentEvent, Segmenter, SileroVad, VadParams,
    VoiceActivityDetector, FRAME_SAMPLES, SAMPLE_RATE,
};

/// `audio-level` を送る間隔 (VADフレーム2つ = 64ms、約15Hz)
const LEVEL_INTERVAL_FRAMES: usize = 2;
/// 設定 (感度・無音時間) を読み直す間隔
const PARAMS_REFRESH_FRAMES: usize = 16;
/// 途中表示: 前回の要求から音声がこれだけ伸びたら次を送る (implementation-plan.md 2.)
pub const PARTIAL_STEP_SAMPLES: usize = SAMPLE_RATE as usize * 8 / 10;
/// デバイスが失われた時に開き直すまでの待ち (AirPods のプロファイル切り替え等が落ち着くまで)
const REOPEN_DELAY: Duration = Duration::from_millis(500);
/// 開き直してからこの時間内に再び失われたら諦める (開き直しは1回まで)
const REOPEN_WINDOW: Duration = Duration::from_secs(10);

/// 処理スレッドからの通知先。
pub trait PipelineSink: Send + Sync {
    fn vad_params(&self) -> VadParams;
    fn next_utterance_id(&self) -> u64;
    fn audio_level(&self, level: f32, threshold: f32, speech: bool);
    fn utterance_started(&self, id: u64);
    /// 途中表示の要求を今送ってよいか (前の要求が処理中・確定処理中なら送らない)
    fn can_request_partial(&self) -> bool;
    /// 発話開始からの音声で途中表示を要求する。結果を待たずに戻ること
    fn request_partial(&self, id: u64, audio: Vec<f32>);
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
}

impl Running {
    /// 録音を止める (処理スレッドと録音スレッドの終了を待つため、ブロックする)。
    /// 発話中のものは破棄または確定し ([`Segmenter::stop`])、確定処理中のものはそのまま続く。
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

struct Stream {
    // 録音を止めるのは drop 時 (Capture の Drop が録音スレッドを join する)
    _capture: Capture,
    rx: Receiver<AudioMsg>,
    resampler: FrameResampler,
}

fn open(source: &Source) -> Result<Stream> {
    let (capture, rx) = audio::start(source.clone())?;
    let resampler = FrameResampler::new(
        capture.sample_rate as usize,
        SAMPLE_RATE as usize,
        FRAME_SAMPLES,
    )?;
    Ok(Stream {
        _capture: capture,
        rx,
        resampler,
    })
}

pub fn start(source: Source, sink: Arc<dyn PipelineSink>) -> Result<Running> {
    // VAD の読み込み失敗は録音開始前に検出する
    let mut vad = SileroVad::new().context("VAD を初期化できません")?;
    vad.reset();
    let stream = open(&source)?;
    let stop = Arc::new(AtomicBool::new(false));
    let stop2 = stop.clone();
    let worker = std::thread::Builder::new()
        .name("mukuchi-pipeline".into())
        .spawn(move || run(source, stream, vad, sink, stop2))
        .context("処理スレッドを起動できません")?;
    Ok(Running {
        stop,
        worker: Some(worker),
    })
}

fn run(
    source: Source,
    mut stream: Stream,
    vad: SileroVad,
    sink: Arc<dyn PipelineSink>,
    stop: Arc<AtomicBool>,
) {
    let mut proc = Processor::new(vad, sink.clone());
    let mut reopened_at: Option<Instant> = None;
    while !stop.load(Ordering::SeqCst) {
        let lost = match stream.rx.recv_timeout(Duration::from_millis(100)) {
            Ok(AudioMsg::Samples(buf)) => {
                stream.resampler.push(&buf, |frame| proc.frame(frame));
                continue;
            }
            Ok(AudioMsg::Lost(msg)) => msg,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => "録音が停止しました".to_string(),
        };
        // サンプルレートの変更や AirPods のプロファイル切り替えでもストリームは無効になる。
        // 1回だけ開き直し、だめなら録音を止める
        proc.stop();
        log::warn!("録音が中断されました: {lost}");
        if reopened_at.is_some_and(|t| t.elapsed() < REOPEN_WINDOW) {
            sink.capture_lost(lost);
            return;
        }
        std::thread::sleep(REOPEN_DELAY);
        if stop.load(Ordering::SeqCst) {
            return;
        }
        match open(&source) {
            Ok(s) => {
                log::info!("録音を開き直しました");
                stream = s;
                reopened_at = Some(Instant::now());
            }
            Err(e) => {
                log::error!("録音を開き直せません: {e:#}");
                sink.capture_lost(lost);
                return;
            }
        }
    }
    proc.stop();
}

/// フレーム単位の処理。スレッドから切り離してテストできるようにする。
pub struct Processor<V: VoiceActivityDetector> {
    vad: V,
    segmenter: Segmenter,
    sink: Arc<dyn PipelineSink>,
    current: Option<u64>,
    /// 最後に途中表示を要求した時点の音声の長さ (サンプル数)
    partial_len: usize,
    frames: usize,
    level_frames: usize,
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
            partial_len: 0,
            frames: 0,
            level_frames: 0,
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

        let event = self.segmenter.push(frame, prob, db);
        match event {
            Some(SegmentEvent::Started) => {
                let id = self.sink.next_utterance_id();
                self.current = Some(id);
                self.partial_len = 0;
                self.sink.utterance_started(id);
            }
            Some(e) => self.deliver(e),
            None => self.maybe_request_partial(),
        }

        self.level_frames += 1;
        self.level_peak_db = self.level_peak_db.max(db);
        if self.level_frames >= LEVEL_INTERVAL_FRAMES {
            let threshold = self.segmenter.params().floor_level();
            self.sink.audio_level(
                normalize_db(self.level_peak_db),
                threshold,
                self.segmenter.is_speaking(),
            );
            self.level_frames = 0;
            self.level_peak_db = f32::MIN;
        }
    }

    /// 途中表示: 前回の要求から 0.8秒以上伸び、前の要求が処理中でなければ送る。
    /// 間隔はタイマーではなく音声の長さで決める (処理が遅い時に要求が溜まらない)。
    /// 無音待ちの間は送らない: 増えたのは無音だけで表示は変わらず (無音はハルシネーションの原因にもなる)、
    /// 話し終わりの確定リクエストの直前に途中表示が ASR を占有して確定を遅らせるため
    fn maybe_request_partial(&mut self) {
        if self.segmenter.in_silence() {
            return;
        }
        let (Some(id), Some(audio)) = (self.current, self.segmenter.current_audio()) else {
            return;
        };
        if audio.len() < self.partial_len + PARTIAL_STEP_SAMPLES {
            return;
        }
        if !self.sink.can_request_partial() {
            return;
        }
        self.partial_len = audio.len();
        self.sink.request_partial(id, audio.to_vec());
    }

    fn deliver(&mut self, event: SegmentEvent) {
        let Some(id) = self.current.take() else {
            return;
        };
        match event {
            SegmentEvent::Ended { audio } => self.sink.utterance_ended(id, audio),
            SegmentEvent::Misfire => self.sink.utterance_discarded(id),
            SegmentEvent::Started => {}
        }
    }

    /// OFF・停止時。話し終わりの無音待ちなら確定し、話している最中なら破棄する。
    pub fn stop(&mut self) {
        if let Some(e) = self.segmenter.stop() {
            self.deliver(e);
        }
        self.current = None;
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
        levels: Mutex<usize>,
        busy: AtomicBool,
    }

    impl PipelineSink for Sink {
        fn vad_params(&self) -> VadParams {
            VadParams::from_settings(60, 1300)
        }
        fn next_utterance_id(&self) -> u64 {
            self.ids.fetch_add(1, Ordering::SeqCst) + 1
        }
        fn audio_level(&self, _: f32, _: f32, _: bool) {
            *self.levels.lock().unwrap() += 1;
        }
        fn can_request_partial(&self) -> bool {
            !self.busy.load(Ordering::SeqCst)
        }
        fn request_partial(&self, id: u64, audio: Vec<f32>) {
            self.log
                .lock()
                .unwrap()
                .push(format!("partial {id} {}", audio.len() / FRAME_SAMPLES));
        }
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
        p.stop();
        let log: Vec<String> = sink
            .log
            .lock()
            .unwrap()
            .iter()
            .filter(|l| !l.starts_with("partial"))
            .cloned()
            .collect();
        assert_eq!(log, vec!["start 1", "end 1", "start 2", "discard 2"]);
        // 85フレームで約15Hz (2フレームごと)
        assert_eq!(*sink.levels.lock().unwrap(), 42);
    }

    #[test]
    fn off_during_silence_wait_finalizes() {
        let sink = Arc::new(Sink::default());
        let mut probs = vec![0.9; 20];
        probs.extend(vec![0.0; 10]);
        let mut p = Processor::new(Scripted(probs, 0), sink.clone());
        let loud = vec![0.3f32; FRAME_SAMPLES];
        for _ in 0..30 {
            p.frame(&loud);
        }
        p.stop();
        let log = sink.log.lock().unwrap();
        assert_eq!(log.first().map(String::as_str), Some("start 1"));
        assert_eq!(log.last().map(String::as_str), Some("end 1"));
    }

    #[test]
    fn no_partials_during_silence_wait() {
        let sink = Arc::new(Sink::default());
        // 発話 20 フレーム → 無音 40 フレーム (無音待ち中に 0.8秒を超えても送らない)
        let mut probs = vec![0.9; 20];
        probs.extend(vec![0.0; 40]);
        let mut p = Processor::new(Scripted(probs, 0), sink.clone());
        let loud = vec![0.3f32; FRAME_SAMPLES];
        for _ in 0..60 {
            p.frame(&loud);
        }
        assert!(!sink
            .log
            .lock()
            .unwrap()
            .iter()
            .any(|l| l.starts_with("partial")));
    }

    #[test]
    fn partials_every_0_8s_of_audio_and_only_when_idle() {
        let sink = Arc::new(Sink::default());
        // 0.8秒 = 12800 サンプル = 25 フレーム
        assert_eq!(PARTIAL_STEP_SAMPLES.div_ceil(FRAME_SAMPLES), 25);
        let mut probs = vec![0.0; 5];
        probs.extend(vec![0.9; 100]);
        let mut p = Processor::new(Scripted(probs, 0), sink.clone());
        let loud = vec![0.3f32; FRAME_SAMPLES];
        for i in 0..105 {
            // 3回目の要求時期 (音声 75 フレーム) は前の要求が処理中
            sink.busy.store((70..80).contains(&i), Ordering::SeqCst);
            p.frame(&loud);
        }
        let partials: Vec<String> = sink
            .log
            .lock()
            .unwrap()
            .iter()
            .filter(|l| l.starts_with("partial"))
            .cloned()
            .collect();
        // 音声は pre-pad 5 フレーム + 発話。25 フレームごと、処理中の間は待って空いたら送る
        assert_eq!(
            partials,
            vec!["partial 1 25", "partial 1 50", "partial 1 81"]
        );
    }
}
