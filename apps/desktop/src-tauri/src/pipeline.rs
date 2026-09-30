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
/// 長い発話の途中表示は区切り (chunk) ごとに文字起こしする。1区切りの長さの上限。
///
/// 途中表示を取り消しても ASR サーバーは推論を最後まで続ける (直列実行) ため、話し終わり直前に
/// 長い音声の途中表示が走っていると確定がその分遅れる。発話全体を毎回送ると推論時間が発話の長さに
/// 比例して伸びるので、区切りが一定の長さに達したら静かな所で確定し、以後は区切りの後の音声だけを送る
/// (表示は確定した区切りの文字 + 今の区切りの文字)。1回の推論は区切りの長さで頭打ちになる。
/// 比較 (約50秒の発話、implementation-plan.md 2.): 12秒は8秒より境目が少なく表示の誤りが少ない
pub const PARTIAL_CHUNK_MAX_SAMPLES: usize = SAMPLE_RATE as usize * 12;
/// 区切りの長さの下限 (推論が遅い環境・短い silenceMs でも、区切りが細かくなりすぎないように)
pub const PARTIAL_CHUNK_MIN_SAMPLES: usize = SAMPLE_RATE as usize * 3;
/// 区切る位置は直近のこの長さの中で最も静かな所 (話の間) にする
const SPLIT_SEARCH_SAMPLES: usize = SAMPLE_RATE as usize * 3;
/// 静かさを測る幅 (160ms) と刻み (20ms)
const SPLIT_WINDOW_SAMPLES: usize = SAMPLE_RATE as usize * 16 / 100;
const SPLIT_STEP_SAMPLES: usize = SAMPLE_RATE as usize * 2 / 100;
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
    /// 途中表示の要求を今送ってよいか (前の要求が処理中・確定処理中なら送らない)。
    /// `samples` は送る音声の長さ (推論時間の見積もりに使う)
    fn can_request_partial(&self, samples: usize) -> bool;
    /// 途中表示の区切りの長さ (サンプル数。`PARTIAL_CHUNK_MIN_SAMPLES..=PARTIAL_CHUNK_MAX_SAMPLES`)
    fn partial_chunk_samples(&self) -> usize;
    /// 途中表示を要求する。結果を待たずに戻ること。受け付けなかったら false
    fn request_partial(&self, id: u64, req: PartialRequest) -> bool;
    /// 話し終わった発話。確定処理 (ASR→入力) を始める
    fn utterance_ended(&self, id: u64, audio: Vec<f32>);
    /// 誤検出・OFFによる破棄
    fn utterance_discarded(&self, id: u64);
    /// デバイス切断など、録音を続けられない
    fn capture_lost(&self, message: String);
}

/// 途中表示の要求。音声は確定済みの区切りの後から
#[derive(Debug)]
pub struct PartialRequest {
    pub audio: Vec<f32>,
    /// この音声で区切りを確定する (結果は表示せず、以後の途中表示の前に付ける)
    pub commit: bool,
}

/// `[lo, hi)` の中で最も静かな (160ms の平均パワーが最小の) 所の位置。短すぎれば `hi`
fn quietest_point(audio: &[f32], lo: usize, hi: usize) -> usize {
    let hi = hi.min(audio.len());
    if lo + SPLIT_WINDOW_SAMPLES > hi {
        return hi;
    }
    let mut best = (f32::INFINITY, hi);
    let mut i = lo;
    while i + SPLIT_WINDOW_SAMPLES <= hi {
        let e: f32 = audio[i..i + SPLIT_WINDOW_SAMPLES]
            .iter()
            .map(|x| x * x)
            .sum();
        // 同じ静かさなら後ろ (新しい方) を選ぶ: 次の区切りを短くする
        if e <= best.0 {
            best = (e, i + SPLIT_WINDOW_SAMPLES / 2);
        }
        i += SPLIT_STEP_SAMPLES;
    }
    best.1
}

/// 録音の開始の失敗。VAD の問題をマイクの問題と区別して知らせるため分ける
#[derive(Debug, thiserror::Error)]
pub enum StartError {
    #[error("VAD を初期化できません: {0:#}")]
    Vad(anyhow::Error),
    #[error("{0:#}")]
    Capture(anyhow::Error),
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

pub fn start(source: Source, sink: Arc<dyn PipelineSink>) -> Result<Running, StartError> {
    // VAD の読み込み失敗は録音開始前に検出する
    let mut vad = SileroVad::new().map_err(StartError::Vad)?;
    vad.reset();
    let stream = open(&source).map_err(StartError::Capture)?;
    let stop = Arc::new(AtomicBool::new(false));
    let stop2 = stop.clone();
    let worker = std::thread::Builder::new()
        .name("mukuchi-pipeline".into())
        .spawn(move || run(source, stream, vad, sink, stop2))
        .context("処理スレッドを起動できません")
        .map_err(StartError::Capture)?;
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
        // 開き直す前に古いストリームを閉じる (同じデバイスを二重に開かない。録音スレッドの終了も待つ)
        drop(stream);
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
    /// 確定した区切りの終わり (サンプル数)。途中表示はここからの音声を送る
    partial_base: usize,
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
            partial_base: 0,
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
                self.partial_base = 0;
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
    /// 話し終わりの確定リクエストの直前に途中表示が ASR を占有して確定を遅らせるため。
    /// 区切りの後の音声が区切りの長さに達したら、直近の最も静かな所までを区切りとして確定する
    /// (`PARTIAL_CHUNK_MAX_SAMPLES`)
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
        let base = self.partial_base.min(audio.len());
        let chunk = self
            .sink
            .partial_chunk_samples()
            .clamp(PARTIAL_CHUNK_MIN_SAMPLES, PARTIAL_CHUNK_MAX_SAMPLES);
        let (end, commit) = if audio.len() - base >= chunk {
            let lo = (base + chunk / 2).max(audio.len().saturating_sub(SPLIT_SEARCH_SAMPLES));
            (quietest_point(audio, lo, audio.len()), true)
        } else {
            (audio.len(), false)
        };
        if !self.sink.can_request_partial(end - base) {
            return;
        }
        let req = PartialRequest {
            audio: audio[base..end].to_vec(),
            commit,
        };
        if !self.sink.request_partial(id, req) {
            return;
        }
        self.partial_len = audio.len();
        if commit {
            self.partial_base = end;
        }
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
    use crate::vad::{KEEP_TAIL_MS, MIN_SPEECH_MS, ONSET_LOOKBACK_MS, PRE_SPEECH_PAD_MS};
    use std::path::PathBuf;
    use std::sync::atomic::AtomicU64;
    use std::sync::Mutex;

    /// 実音声の 2 発話 (長文 + 短いコマンド) を返す。
    ///
    /// リポジトリの smoke WAV (git 管理外) があれば使い、なければ macOS の `say` で作る。
    /// CI の runner には日本語音声 (Kyoko) が無いことがあり、英語音声に日本語を読ませると
    /// ほぼ無音の短いクリップになって発話が 1 つ消える。そのため音声とテキストの言語を揃える。
    /// `MUKUCHI_TEST_NO_SMOKE=1` で smoke WAV を無視 (CI 条件の再現)、
    /// `MUKUCHI_TEST_SAY_VOICE=<名前>` で音声を固定できる。
    /// `say` が使えない時は None (テストはスキップ理由を出して戻る)。
    fn speech_pair() -> Option<(Vec<f32>, Vec<f32>)> {
        let smoke =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../spikes/asr-bench/data/smoke");
        let use_smoke = std::env::var_os("MUKUCHI_TEST_NO_SMOKE").is_none();
        let (a, b) = (smoke.join("daily01.wav"), smoke.join("cmd01.wav"));
        if use_smoke && a.exists() && b.exists() {
            eprintln!("speech source: smoke WAV");
            return Some((read_16k(&a), read_16k(&b)));
        }

        let Some((voice, texts)) = pick_say_voice() else {
            eprintln!("skip: smoke WAV がなく say の音声も見つからない");
            return None;
        };
        eprintln!("speech source: say -v {voice}");
        let a = say_16k(&voice, texts[0], "a");
        let b = say_16k(&voice, texts[1], "b");
        Some((a, b))
    }

    const JA_TEXTS: [&str; 2] = ["今日の午後3時から定例ミーティングがあります。", "確定"];
    const EN_TEXTS: [&str; 2] = [
        "The regular meeting starts at three o'clock this afternoon.",
        "Okay, confirmed.",
    ];

    /// `say -v ?` の一覧から、テキストの言語と一致する音声を選ぶ。
    fn pick_say_voice() -> Option<(String, [&'static str; 2])> {
        let out = std::process::Command::new("say")
            .args(["-v", "?"])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        // 各行は「名前 (空白) ロケール # 例文」。名前に空白や括弧を含むことがある
        let voices: Vec<(String, String)> = String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|l| {
                let head = l.split('#').next()?.trim_end();
                let (name, locale) = head.rsplit_once(char::is_whitespace)?;
                Some((name.trim().to_string(), locale.to_string()))
            })
            .collect();
        let texts_for = |locale: &str| {
            if locale.starts_with("ja") {
                Some(JA_TEXTS)
            } else if locale.starts_with("en") {
                Some(EN_TEXTS)
            } else {
                None
            }
        };
        if let Ok(forced) = std::env::var("MUKUCHI_TEST_SAY_VOICE") {
            let (name, locale) = voices
                .iter()
                .find(|(n, _)| *n == forced)
                .unwrap_or_else(|| panic!("MUKUCHI_TEST_SAY_VOICE={forced} が say -v ? にない"));
            let texts = texts_for(locale)
                .unwrap_or_else(|| panic!("{forced} ({locale}) は ja/en の音声ではない"));
            return Some((name.clone(), texts));
        }
        // 既知の音声を優先して結果を安定させ、無ければ ja/en の最初の音声
        ["Kyoko", "Samantha", "Alex", "Fred"]
            .iter()
            .find_map(|want| voices.iter().find(|(n, _)| n == want))
            .or_else(|| voices.iter().find(|(_, l)| texts_for(l).is_some()))
            .and_then(|(n, l)| Some((n.clone(), texts_for(l)?)))
    }

    fn say_16k(voice: &str, text: &str, tag: &str) -> Vec<f32> {
        let tmp = std::env::temp_dir().join(format!(
            "mukuchi-test-{tag}-{}-{}.wav",
            voice.replace(|c: char| !c.is_ascii_alphanumeric(), "_"),
            std::process::id()
        ));
        let status = std::process::Command::new("say")
            .args(["-v", voice, "-o"])
            .arg(&tmp)
            .args(["--data-format=LEI16@16000", text])
            .status()
            .expect("say を起動できない");
        assert!(status.success(), "say -v {voice} が失敗した: {status}");
        let samples = read_16k(&tmp);
        let _ = std::fs::remove_file(&tmp);
        samples
    }

    fn read_16k(path: &std::path::Path) -> Vec<f32> {
        let (samples, rate) = audio::read_wav_mono(path).unwrap();
        assert_eq!(rate, 16000);
        samples
    }

    fn silence(ms: usize) -> Vec<f32> {
        vec![0.0; ms * 16]
    }

    #[test]
    fn silero_segments_real_speech() {
        let Some((a, b)) = speech_pair() else {
            return;
        };
        // 元音声が短すぎると VAD の最小発話長で落ち、分割の検証にならない
        for (name, src) in [("a", &a), ("b", &b)] {
            let ms = src.len() / 16;
            assert!(
                ms >= (MIN_SPEECH_MS + 300) as usize,
                "発話 {name} が {ms}ms しかない (音声とテキストの言語不一致の疑い)"
            );
        }

        let silence_ms = 1300;
        // 話し終わり判定 (無音待ち + 末尾保持) と次発話の遡り・前置きが重ならない間隔
        let gap_ms =
            (silence_ms + KEEP_TAIL_MS + PRE_SPEECH_PAD_MS + ONSET_LOOKBACK_MS + 1000) as usize;
        let mut signal = silence(1000);
        signal.extend(&a);
        signal.extend(silence(gap_ms));
        signal.extend(&b);
        signal.extend(silence(gap_ms));

        let params = VadParams::from_settings(60, silence_ms);
        let segs = segment_samples(&signal, params).unwrap();
        let lens: Vec<usize> = segs.iter().map(|s| s.len() / 16).collect();
        assert_eq!(
            segs.len(),
            2,
            "2つの発話に分かれる (元 {}ms/{}ms, 切り出し {lens:?}ms)",
            a.len() / 16,
            b.len() / 16
        );
        for (seg, src) in segs.iter().zip([&a, &b]) {
            let seg_ms = seg.len() / 16;
            let src_ms = src.len() / 16;
            // say/録音の前後の無音は削られてよい (≤400ms)。pre-pad + 発話 + 末尾に収まり、
            // 無音待ち (1.3秒) は含まない
            let max_extra = (PRE_SPEECH_PAD_MS + KEEP_TAIL_MS + 100) as usize;
            assert!(
                seg_ms + 400 >= src_ms && seg_ms <= src_ms + max_extra,
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

    struct Sink {
        ids: AtomicU64,
        log: Mutex<Vec<String>>,
        levels: Mutex<usize>,
        thresholds: Mutex<Vec<f32>>,
        busy: AtomicBool,
        /// (感度, 無音ms)。設定画面での変更を模す
        settings: Mutex<(u32, u32)>,
    }

    impl Default for Sink {
        fn default() -> Self {
            Self {
                ids: AtomicU64::new(0),
                log: Mutex::default(),
                levels: Mutex::default(),
                thresholds: Mutex::default(),
                busy: AtomicBool::new(false),
                settings: Mutex::new((60, 1300)),
            }
        }
    }

    impl PipelineSink for Sink {
        fn vad_params(&self) -> VadParams {
            let (s, ms) = *self.settings.lock().unwrap();
            VadParams::from_settings(s, ms)
        }
        fn next_utterance_id(&self) -> u64 {
            self.ids.fetch_add(1, Ordering::SeqCst) + 1
        }
        fn audio_level(&self, _: f32, threshold: f32, _: bool) {
            *self.levels.lock().unwrap() += 1;
            self.thresholds.lock().unwrap().push(threshold);
        }
        fn can_request_partial(&self, _: usize) -> bool {
            !self.busy.load(Ordering::SeqCst)
        }
        fn partial_chunk_samples(&self) -> usize {
            PARTIAL_CHUNK_MAX_SAMPLES
        }
        fn request_partial(&self, id: u64, req: PartialRequest) -> bool {
            let kind = if req.commit { "commit" } else { "partial" };
            let frames = req.audio.len() as f32 / FRAME_SAMPLES as f32;
            self.log
                .lock()
                .unwrap()
                .push(format!("{kind} {id} {}", frames.round()));
            true
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

    /// 感度・無音時間の変更は再起動なしで約0.5秒以内に反映される (しきい値の表示も)
    #[test]
    fn settings_apply_live() {
        let sink = Arc::new(Sink::default());
        let mut p = Processor::new(Scripted(vec![], 0), sink.clone());
        let quiet = vec![0.0f32; FRAME_SAMPLES];
        for _ in 0..4 {
            p.frame(&quiet);
        }
        let before = *sink.thresholds.lock().unwrap().last().unwrap();
        *sink.settings.lock().unwrap() = (100, 300);
        for _ in 0..PARAMS_REFRESH_FRAMES {
            p.frame(&quiet);
        }
        assert_eq!(p.segmenter.params(), &VadParams::from_settings(100, 300));
        let after = *sink.thresholds.lock().unwrap().last().unwrap();
        assert!(after < before, "感度を上げるとしきい値の線が下がる");
    }

    #[test]
    fn quietest_point_picks_the_pause() {
        let mut a = vec![0.3f32; SAMPLE_RATE as usize * 3];
        // 1.0〜1.3秒が静か
        let pause = SAMPLE_RATE as usize..SAMPLE_RATE as usize * 13 / 10;
        a[pause.clone()].iter_mut().for_each(|x| *x = 0.0);
        let p = quietest_point(&a, 0, a.len());
        assert!(pause.contains(&p), "{p}");
        // 探す範囲が窓より短ければ終わり
        assert_eq!(quietest_point(&a, 100, 200), 200);
    }

    /// 長い発話: 区切りの長さに達したら静かな所で区切りを確定し、以後は区切りの後だけを送る。
    /// 1回に送る音声は区切りの長さ (+ 待ち) で頭打ちになる
    #[test]
    fn long_utterance_partials_are_chunked_at_pauses() {
        let sink = Arc::new(Sink::default());
        let chunk_frames = PARTIAL_CHUNK_MAX_SAMPLES / FRAME_SAMPLES; // 375
        let total = chunk_frames * 3;
        let mut probs = vec![0.0; 1];
        probs.extend(vec![0.9; total]);
        let mut p = Processor::new(Scripted(probs.clone(), 0), sink.clone());
        let loud = vec![0.3f32; FRAME_SAMPLES];
        let quiet = vec![0.0f32; FRAME_SAMPLES];
        // 340〜350 フレーム目に話の間 (VAD は発話中のまま)
        for i in 0..probs.len() {
            p.frame(if (340..350).contains(&i) {
                &quiet
            } else {
                &loud
            });
        }
        let log = sink.log.lock().unwrap();
        let reqs: Vec<(String, usize)> = log
            .iter()
            .filter_map(|l| {
                let mut it = l.split(' ');
                let kind = it.next()?;
                (kind == "partial" || kind == "commit")
                    .then(|| (kind.to_string(), it.nth(1).unwrap().parse().unwrap()))
            })
            .collect();
        let commits: Vec<usize> = reqs
            .iter()
            .filter(|(k, _)| k == "commit")
            .map(|r| r.1)
            .collect();
        assert!(commits.len() >= 2, "{reqs:?}");
        // 最初の区切りは話の間で終わる (音声は pre-pad を含むためフレーム番号は少しずれる)
        assert!((335..=355).contains(&commits[0]), "{commits:?}");
        assert!(
            reqs.iter().all(|(_, n)| *n <= chunk_frames + 25),
            "{reqs:?}"
        );
        // 区切りの後も途中表示を送り続ける (0.8秒ごと)
        assert!(reqs.len() >= total / 25 - 2, "{}", reqs.len());
        assert_eq!(reqs.last().unwrap().0, "partial");
    }
}
