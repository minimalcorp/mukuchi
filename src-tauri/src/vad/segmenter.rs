//! 発話区間の切り出し。
//!
//! アルゴリズムは tsunagi が使う @ricky0123/vad-web の frame processor と同じ考え方
//! (開始/継続の2しきい値、redemption、pre-pad、最短発話) に、音量の下限と末尾の無音の削除を加えたもの。

use std::collections::VecDeque;

use super::{VadParams, FRAME_SAMPLES};

#[derive(Debug, Clone, PartialEq)]
pub enum SegmentEvent {
    /// 発話を検出した
    Started,
    /// 発話が終わった。`audio` は pre-pad を含み、末尾の無音は `keep_tail_frames` だけ残して削ったもの
    Ended { audio: Vec<f32> },
    /// 短すぎる発話 (誤検出) として破棄した
    Misfire,
}

pub struct Segmenter {
    params: VadParams,
    /// 発話していない間の直近フレームとその発話確率 (pre-pad・遡り用)
    pre: VecDeque<(Vec<f32>, f32)>,
    speaking: bool,
    /// 発話中の音声 (pre-pad を含む)
    audio: Vec<f32>,
    /// `audio` のうち pre-pad 部分のフレーム数
    pad_frames: usize,
    /// 発話開始からのフレーム数
    speech_frames: usize,
    /// 発話開始から数えた、最後に継続しきい値以上だったフレームの位置 (1始まり)
    last_voiced: usize,
    redemption: usize,
}

impl Segmenter {
    pub fn new(params: VadParams) -> Self {
        Self {
            params,
            pre: VecDeque::new(),
            speaking: false,
            audio: Vec::new(),
            pad_frames: 0,
            speech_frames: 0,
            last_voiced: 0,
            redemption: 0,
        }
    }

    pub fn params(&self) -> &VadParams {
        &self.params
    }

    /// 設定変更を反映する。進行中の発話はそのまま続ける。
    pub fn set_params(&mut self, params: VadParams) {
        self.params = params;
    }

    pub fn is_speaking(&self) -> bool {
        self.speaking
    }

    /// 発話中の音声 (途中表示で使う。P2)
    #[allow(dead_code)]
    pub fn current_audio(&self) -> Option<&[f32]> {
        self.speaking.then_some(self.audio.as_slice())
    }

    /// 1フレーム分の音声と、その発話確率・音量を入れる。
    pub fn push(&mut self, frame: &[f32], prob: f32, db: f32) -> Option<SegmentEvent> {
        debug_assert_eq!(frame.len(), FRAME_SAMPLES);
        let p = &self.params;
        if !self.speaking {
            // 発話開始は確率と音量の両方で判定する (無音に近い雑音を送らない)
            if prob >= p.positive_threshold && db >= p.floor_db {
                self.speaking = true;
                self.audio.clear();
                // 開始しきい値・音量の下限に届く前の小さな声 (語頭) も含めるため、
                // 継続しきい値以上のフレームが続く所まで遡り、その前に pre-pad を付ける
                let mut first = self.pre.len();
                while first > 0 && self.pre[first - 1].1 >= p.negative_threshold {
                    first -= 1;
                }
                let first = first.saturating_sub(p.pre_pad_frames);
                self.pad_frames = self.pre.len() - first;
                for (f, _) in self.pre.drain(..).skip(first) {
                    self.audio.extend_from_slice(&f);
                }
                self.audio.extend_from_slice(frame);
                self.speech_frames = 1;
                self.last_voiced = 1;
                self.redemption = 0;
                return Some(SegmentEvent::Started);
            }
            self.pre.push_back((frame.to_vec(), prob));
            while self.pre.len() > p.pre_pad_frames + p.lookback_frames {
                self.pre.pop_front();
            }
            return None;
        }

        self.audio.extend_from_slice(frame);
        self.speech_frames += 1;
        if prob >= p.negative_threshold {
            self.last_voiced = self.speech_frames;
        }
        if prob >= p.positive_threshold {
            self.redemption = 0;
        } else if prob < p.negative_threshold {
            self.redemption += 1;
        }

        if self.redemption >= p.redemption_frames || self.speech_frames >= p.max_speech_frames {
            return Some(self.finish());
        }
        None
    }

    /// 発話中なら打ち切る (OFF時)。発話中だったかを返す。音声は破棄する。
    pub fn abort(&mut self) -> bool {
        let was = self.speaking;
        self.reset();
        was
    }

    pub fn reset(&mut self) {
        self.speaking = false;
        self.audio.clear();
        self.pre.clear();
        self.speech_frames = 0;
        self.last_voiced = 0;
        self.redemption = 0;
        self.pad_frames = 0;
    }

    fn finish(&mut self) -> SegmentEvent {
        let p = &self.params;
        self.speaking = false;
        self.redemption = 0;
        let voiced = self.last_voiced;
        let event = if voiced < p.min_speech_frames {
            SegmentEvent::Misfire
        } else {
            let keep = (self.pad_frames + voiced + p.keep_tail_frames) * FRAME_SAMPLES;
            let mut audio = std::mem::take(&mut self.audio);
            audio.truncate(keep);
            SegmentEvent::Ended { audio }
        };
        self.audio.clear();
        self.pre.clear();
        self.speech_frames = 0;
        self.last_voiced = 0;
        event
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params() -> VadParams {
        VadParams::from_settings(60, 1300)
    }

    /// 確率列を流し、イベントとそのフレーム位置を返す。各フレームの値は位置を表す定数にする。
    fn run(seg: &mut Segmenter, probs: &[f32], db: f32) -> Vec<(usize, SegmentEvent)> {
        let mut out = Vec::new();
        for (i, &p) in probs.iter().enumerate() {
            let frame = vec![i as f32; FRAME_SAMPLES];
            if let Some(e) = seg.push(&frame, p, db) {
                out.push((i, e));
            }
        }
        out
    }

    fn seq(parts: &[(f32, usize)]) -> Vec<f32> {
        parts
            .iter()
            .flat_map(|&(p, n)| std::iter::repeat_n(p, n))
            .collect()
    }

    #[test]
    fn segments_with_prepad_and_trimmed_tail() {
        let mut seg = Segmenter::new(params());
        // 無音20 → 発話30 → 無音60
        let probs = seq(&[(0.0, 20), (0.9, 30), (0.0, 60)]);
        let ev = run(&mut seg, &probs, -20.0);
        assert_eq!(ev.len(), 2);
        assert_eq!(ev[0], (20, SegmentEvent::Started));
        let (at, SegmentEvent::Ended { audio }) = &ev[1] else {
            panic!("expected Ended: {:?}", ev[1]);
        };
        // 最後の発話フレーム(49)から redemption 41 フレーム後に確定
        assert_eq!(*at, 49 + 41);
        // pre-pad 10 + 発話 30 + 末尾 10
        assert_eq!(audio.len(), 50 * FRAME_SAMPLES);
        assert_eq!(audio[0], 10.0, "pre-pad は発話直前の10フレーム");
        assert_eq!(
            audio[audio.len() - 1],
            59.0,
            "末尾は最後の発話 + 10フレーム"
        );
    }

    #[test]
    fn hysteresis_keeps_speech_between_thresholds() {
        let mut seg = Segmenter::new(params());
        // 継続しきい値(0.35)以上・開始しきい値未満の区間は発話が続く扱い
        let probs = seq(&[(0.9, 12), (0.4, 60), (0.9, 5), (0.0, 50)]);
        let ev = run(&mut seg, &probs, -20.0);
        assert_eq!(ev.len(), 2, "{ev:?}");
        let SegmentEvent::Ended { audio } = &ev[1].1 else {
            panic!()
        };
        assert_eq!(audio.len(), (12 + 60 + 5 + 10) * FRAME_SAMPLES);
    }

    #[test]
    fn short_pause_does_not_split() {
        let mut seg = Segmenter::new(params());
        let probs = seq(&[(0.9, 15), (0.0, 30), (0.9, 15), (0.0, 50)]);
        let ev = run(&mut seg, &probs, -20.0);
        assert_eq!(ev.len(), 2, "1.3秒未満の間では分割しない: {ev:?}");
    }

    #[test]
    fn short_utterance_is_misfire() {
        let mut seg = Segmenter::new(params());
        let probs = seq(&[(0.0, 5), (0.9, 5), (0.0, 50)]);
        let ev = run(&mut seg, &probs, -20.0);
        assert_eq!(ev.len(), 2);
        assert_eq!(ev[1].1, SegmentEvent::Misfire);
        assert!(!seg.is_speaking());
    }

    #[test]
    fn quiet_onset_is_included() {
        let mut seg = Segmenter::new(params());
        // 無音20 → 小さな声(確率は継続しきい値以上だが音量が下限未満)8 → 発話20 → 無音50
        let mut ev = Vec::new();
        for i in 0..98 {
            let (p, db) = match i {
                0..20 => (0.0, -80.0),
                20..28 => (0.4, -50.0),
                28..48 => (0.9, -20.0),
                _ => (0.0, -80.0),
            };
            if let Some(e) = seg.push(&vec![i as f32; FRAME_SAMPLES], p, db) {
                ev.push(e);
            }
        }
        let Some(SegmentEvent::Ended { audio }) = ev.last() else {
            panic!("{ev:?}")
        };
        // 遡った8フレームの前に pre-pad 10 フレーム
        assert_eq!(audio[0], 10.0);
        assert_eq!(audio.len(), (10 + 8 + 20 + 10) * FRAME_SAMPLES);
    }

    #[test]
    fn quiet_audio_does_not_start_speech() {
        let mut seg = Segmenter::new(params());
        let probs = seq(&[(0.9, 30)]);
        assert!(run(&mut seg, &probs, -70.0).is_empty());
    }

    #[test]
    fn abort_discards_in_progress_speech() {
        let mut seg = Segmenter::new(params());
        let probs = seq(&[(0.9, 20)]);
        run(&mut seg, &probs, -20.0);
        assert!(seg.is_speaking());
        assert!(seg.abort());
        assert!(!seg.is_speaking());
        assert!(!seg.abort());
    }

    #[test]
    fn long_speech_is_force_split() {
        let mut p = params();
        p.max_speech_frames = 100;
        let mut seg = Segmenter::new(p);
        let probs = seq(&[(0.9, 250)]);
        let ev = run(&mut seg, &probs, -20.0);
        let ends = ev
            .iter()
            .filter(|(_, e)| matches!(e, SegmentEvent::Ended { .. }))
            .count();
        assert_eq!(ends, 2);
    }
}
