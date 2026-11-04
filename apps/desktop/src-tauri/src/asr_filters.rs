//! 認識結果の除外 (Windows の llama-server 経路。docs/architecture.md「ASR (Windows)」の暴走の防止)。
//!
//! Mac は ASR サーバー (asr-server の `filters.py`) が除外する。Windows の llama-server にはその仕組みが無いため、
//! 同じ規則を Rust に移す (`is_hallucination_phrase`。tests/test_filters.py と同じケースで同じ結果にする)。
//! 加えて、無音・雑音で同じ語句を上限まで繰り返す暴走 (spikes/asr-bench/WINDOWS_DECISION.md「ハルシネーション」:
//! 元の Qwen は無音を日本語指定で送ると「自分の心に」を 256 トークンまで繰り返した) を検出して捨てる。
//!
//! 上の 2 つは Windows でのみ使う (Mac はサーバーが除外する)。
//! 認識のヒントの書き写しの判定 (`context_echo_check`・`decide_context_echo`) は Mac・Windows 共通
//! (docs/architecture.md「決定事項」の認識のヒントの書き写しの除外)。

/// YouTube 字幕由来の典型的なハルシネーション (filters.py の HALLUCINATION_PHRASES と同じ)。
/// 出力全体が (区切りを除いて) これらと完全一致する場合のみ除外する。部分一致にしないのは、
/// 利用者が実際にこれらの語を含む文を話すケースを壊さないため
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const HALLUCINATION_PHRASES: [&str; 10] = [
    "ご視聴ありがとうございました",
    "ご視聴ありがとうございます",
    "最後までご視聴いただきありがとうございました",
    "最後までご視聴ありがとうございました",
    "チャンネル登録お願いします",
    "チャンネル登録をお願いします",
    "チャンネル登録よろしくお願いします",
    "次回もお楽しみに",
    "次回予告",
    "おやすみなさい",
];

/// filters.py の `_NORMALIZE_RE` (`[\s、。，．,.！!？?・…「」『』（）()\[\]〜~♪]`) に当たる文字。
/// Python の `\s` (str.isspace) は Rust の `is_whitespace` (Unicode の White_Space) に加えて
/// U+001C〜U+001F (情報分離文字) も含むため、それも区切りとして扱う (同じ入力で同じ結果にするため)
fn is_separator(c: char) -> bool {
    c.is_whitespace()
        || ('\u{1c}'..='\u{1f}').contains(&c)
        || matches!(
            c,
            '、' | '。'
                | '，'
                | '．'
                | ','
                | '.'
                | '！'
                | '!'
                | '？'
                | '?'
                | '・'
                | '…'
                | '「'
                | '」'
                | '『'
                | '』'
                | '（'
                | '）'
                | '('
                | ')'
                | '['
                | ']'
                | '〜'
                | '~'
                | '♪'
        )
}

/// 無音・雑音由来の定型ハルシネーションか (filters.py の `is_hallucination_phrase` と同じ)
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn is_hallucination_phrase(text: &str) -> bool {
    let s: String = text.chars().filter(|c| !is_separator(*c)).collect();
    HALLUCINATION_PHRASES.contains(&s.as_str())
}

/// 繰り返しの単位として見る最長の文字数 (「自分の心に」は5文字、英語の短い文で30文字前後)
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const MAX_UNIT_CHARS: usize = 40;
/// この回数以上続けて同じ語句が出たら暴走とみなす
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const MIN_REPEATS: usize = 4;
/// 繰り返しの部分がこの文字数以上の時だけ暴走とみなす。「はいはいはいはい」(8文字) のような
/// 実際に話しうる短い繰り返しを捨てないため
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const MIN_RUN_CHARS: usize = 20;

/// 同じ語句が続けて繰り返されている (暴走) か。区切り (空白・句読点) と大文字小文字は無視して比べる
/// (「自分の心に、自分の心に…」「the first, the first…」を同じ語句の繰り返しとして見るため)
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn is_runaway_repetition(text: &str) -> bool {
    let c: Vec<char> = text
        .chars()
        .filter(|c| !is_separator(*c))
        .flat_map(char::to_lowercase)
        .collect();
    let n = c.len();
    if n < MIN_RUN_CHARS {
        return false;
    }
    for unit in 1..=MAX_UNIT_CHARS.min(n / MIN_REPEATS) {
        let mut i = 0;
        while i + unit * MIN_REPEATS <= n {
            let mut repeats = 1;
            while i + (repeats + 1) * unit <= n
                && c[i + repeats * unit..i + (repeats + 1) * unit] == c[i..i + unit]
            {
                repeats += 1;
            }
            if repeats >= MIN_REPEATS && repeats * unit >= MIN_RUN_CHARS {
                return true;
            }
            i += 1;
        }
    }
    false
}

// ---- 認識のヒントの書き写し -------------------------------------------------

/// 疑いとみなす最短の文字数 (正規化後)。「MLX」「はい」のような短い語は話した語とヒントの語が
/// 重なりやすく、書き写しでも短いので入力されて困ることが少ないため対象にしない
const ECHO_MIN_CHARS: usize = 4;
/// ヒントの 3 文字の並びに一致する文字の割合がこれ以上なら疑い。書き写しは区切り・表記が少し
/// 変わる (「:」が消える、「固有名詞:」が「固有名詞。」になる、先頭の語が置き換わる) ため完全一致にしない
const ECHO_MIN_RATIO: f64 = 0.8;
/// 比べる文字の並びの長さ。1〜2 文字だと「の」「さん」のようなありふれた並びで一致してしまう
const ECHO_NGRAM: usize = 3;
/// ヒントなしで認識し直した結果がこれだけなら空にする。ヒントなしで無音を認識すると
/// 「はい。」「あ、」が出る (実測) ため、書き写しを置き換えた結果としては使わない
const NO_SPEECH_PHRASES: [&str; 3] = ["", "はい", "あ"];

/// 書き写しの判定用の正規化。区切りに加えて「:」も除く (ヒントの「固有名詞: 」の類が
/// 書き写しで消えたり読点に変わったりするため)。is_hallucination_phrase の区切りは変えない
fn normalize_for_echo(text: &str) -> Vec<char> {
    text.chars()
        .filter(|c| !is_separator(*c) && !matches!(c, ':' | '：'))
        .flat_map(char::to_lowercase)
        .collect()
}

/// 認識結果がヒントの書き写しかの判定材料 (ログには文字数・割合だけを出す)
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EchoCheck {
    /// 正規化した認識結果の文字数
    pub chars: usize,
    /// そのうちヒントの 3 文字の並びに一致する位置に含まれる文字の割合
    pub ratio: f64,
}

impl EchoCheck {
    pub fn is_suspect(&self) -> bool {
        self.chars >= ECHO_MIN_CHARS && self.ratio >= ECHO_MIN_RATIO
    }
}

/// 認識結果 `text` を、それを認識した時のヒント `context` と比べる。ヒントが空なら疑いにしない
pub fn context_echo_check(text: &str, context: &str) -> EchoCheck {
    let t = normalize_for_echo(text);
    let ctx = normalize_for_echo(context);
    let grams: std::collections::HashSet<&[char]> = ctx.windows(ECHO_NGRAM).collect();
    let mut covered = vec![false; t.len()];
    for (i, w) in t.windows(ECHO_NGRAM).enumerate() {
        if grams.contains(w) {
            covered[i..i + ECHO_NGRAM]
                .iter_mut()
                .for_each(|c| *c = true);
        }
    }
    let n = covered.iter().filter(|c| **c).count();
    EchoCheck {
        chars: t.len(),
        ratio: if t.is_empty() {
            0.0
        } else {
            n as f64 / t.len() as f64
        },
    }
}

/// 疑いのある認識結果をヒントなしで認識し直した後の採用
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EchoDecision {
    /// ヒントの語を実際に話した (ヒントなしでも長さが近い): ヒントありの結果を使う
    KeepWithHint,
    /// 書き写し: ヒントなしの結果を使う
    UseWithoutHint,
    /// 書き写しで、ヒントなしの結果も話し言葉の無い音声の定型: 何も入力しない
    Drop,
}

/// ヒントあり `with_hint` (疑いのあるもの) とヒントなし `without_hint` の結果から採用を決める。
/// 文字だけでは「ヒントの語を話した」と区別できないため長さで比べる: 話した時は表記が変わっても
/// 長さが近く (実測 9/6・4/4)、書き写しはヒントなしが大幅に短い (61/2・14/2)
pub fn decide_context_echo(with_hint: &str, without_hint: &str) -> EchoDecision {
    let with_len = normalize_for_echo(with_hint).len();
    let without: String = normalize_for_echo(without_hint).into_iter().collect();
    if without.chars().count() * 2 >= with_len {
        EchoDecision::KeepWithHint
    } else if NO_SPEECH_PHRASES.contains(&without.as_str()) {
        EchoDecision::Drop
    } else {
        EchoDecision::UseWithoutHint
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// tests/test_filters.py の test_exact_phrases_are_dropped と同じケース
    #[test]
    fn exact_phrases_are_dropped() {
        for text in [
            "ご視聴ありがとうございました",
            "ご視聴ありがとうございました。",
            " おやすみなさい！ ",
            "「次回予告」…",
        ] {
            assert!(is_hallucination_phrase(text), "{text}");
        }
    }

    /// tests/test_filters.py の test_other_text_is_kept と同じケース
    #[test]
    fn other_text_is_kept() {
        for text in [
            "",
            "了解です。",
            "今日はご視聴ありがとうございました、と言って配信を終えた",
            "おやすみなさいませ",
        ] {
            assert!(!is_hallucination_phrase(text), "{text}");
        }
    }

    #[test]
    fn python_whitespace_is_separator() {
        // Python の \s に含まれる文字 (全角空白・改行・情報分離文字)
        assert!(is_hallucination_phrase("\u{3000}次回予告\n\u{1f}"));
        assert!(is_hallucination_phrase(
            "チャンネル 登録 を お願い します ♪"
        ));
    }

    #[test]
    fn runaway_repetition_is_detected() {
        // 実測 (WINDOWS_DECISION.md): 元の Qwen + 日本語指定 + 無音
        assert!(is_runaway_repetition(&"自分の心に".repeat(50)));
        assert!(is_runaway_repetition(&"自分の心に、".repeat(5)));
        // 途中から暴走したもの
        assert!(is_runaway_repetition(&format!(
            "今日は{}",
            "ありがとうございます。".repeat(4)
        )));
        assert!(is_runaway_repetition(&"The first, ".repeat(8)));
        assert!(is_runaway_repetition(&"あ".repeat(30)));
        assert!(is_runaway_repetition(&"the THE The the ".repeat(4)));
    }

    #[test]
    fn natural_text_is_kept() {
        for text in [
            "",
            "確定",
            "はいはいはいはい",
            "ありがとうございます。ありがとうございます。",
            "2026年9月30日の午前10時に150万円を振り込みます。",
            "The first was the first of the three.",
            "I'm going to go to the bathroom.",
            "ははははは、面白いですね",
            "テストテストテスト、マイクのテストです",
        ] {
            assert!(!is_runaway_repetition(text), "{text}");
        }
    }

    const SYN: &str =
        "mukuchi の開発。固有名詞: Tauri, Qwen3-ASR, MLX, pnpm, process-compose, minimalcorp";
    const MEET: &str = "会議の議事録。参加者: 田中さん、佐藤さん。議題: 予算、了解事項の確認。はい、うん等の相づちも書き起こす。";
    const SYN_ECHO: &str =
        "mukuchiの開発。固有名詞:Tauri、Qwen3-ASR、MLX、pnpm、process-compose、minimalcorp";

    fn suspect(text: &str, context: &str) -> bool {
        context_echo_check(text, context).is_suspect()
    }

    /// 採用した文字列 (Drop は空)。core の確定と同じ組み立て
    fn resolve(with_hint: &str, without_hint: &str) -> String {
        assert!(
            suspect(with_hint, SYN) || suspect(with_hint, MEET),
            "{with_hint}"
        );
        match decide_context_echo(with_hint, without_hint) {
            EchoDecision::KeepWithHint => with_hint.into(),
            EchoDecision::UseWithoutHint => without_hint.into(),
            EchoDecision::Drop => String::new(),
        }
    }

    /// 実測 (dev モデル・TTS): 書き写しの疑い
    #[test]
    fn context_echo_is_suspected() {
        for text in [
            SYN_ECHO,
            "各社の開発。固有名詞。Tauri、Qwen3-ASR、MLX、pnpm、process-compose、minimalcorp。",
            "Tauri。",
            "pnpm。",
            "Qwen3ASR。",
            "pnpmとprocess-composeを使う",
        ] {
            assert!(suspect(text, SYN), "{text}");
        }
        for text in [
            MEET,
            "田中さん、佐藤さん。議題予算、了解事項の確認。はい、うん等の相づちも書き起こす。",
            "田中さんと佐藤さん。",
            "田中さん。",
        ] {
            assert!(suspect(text, MEET), "{text}");
        }
    }

    #[test]
    fn short_or_unrelated_text_is_not_suspected() {
        for text in ["MLX。", "タウリとMLX。", "はい。", "確定。", "了解。", ""] {
            assert!(!suspect(text, SYN), "{text}");
        }
        // ヒントが空なら何もしない
        assert!(!suspect(SYN_ECHO, ""));
        assert!(!suspect(SYN_ECHO, " 。、 "));
        let c = context_echo_check("MLX。", SYN);
        assert_eq!(c.chars, 3);
        assert_eq!(c.ratio, 1.0);
    }

    /// 実測 (dev モデル・TTS): ヒントあり / ヒントなし → 採用
    #[test]
    fn context_echo_is_resolved_by_recognizing_without_hint() {
        assert_eq!(resolve(SYN_ECHO, "はい。"), "");
        assert_eq!(resolve(SYN_ECHO, "あ、"), "");
        assert_eq!(resolve(SYN_ECHO, ""), "");
        assert_eq!(resolve("Tauri。", "あぶり。"), "Tauri。");
        assert_eq!(resolve("pnpm。", "P.N.P.M."), "pnpm。");
        assert_eq!(resolve("Qwen3ASR。", "QY3ASR。"), "Qwen3ASR。");
        assert_eq!(
            resolve(
                "pnpmとprocess-composeを使う",
                "PNPMとプロセスコンポーズを使う"
            ),
            "pnpmとprocess-composeを使う"
        );
        assert_eq!(resolve(MEET, "うん。"), "うん。");
        assert_eq!(resolve(MEET, "開業。"), "開業。");
        assert_eq!(resolve(MEET, "はい。"), "");
        assert_eq!(
            resolve(
                "田中さん、佐藤さん。議題予算、了解事項の確認。はい、うん等の相づちも書き起こす。",
                "田中さん。"
            ),
            "田中さん。"
        );
        assert_eq!(
            resolve("田中さんと佐藤さん。", "田中さんと佐藤さん。"),
            "田中さんと佐藤さん。"
        );
        assert_eq!(resolve("田中さん。", "よさみ。"), "田中さん。");
    }

    /// 書き写し用の「:」の扱いは is_hallucination_phrase に影響しない
    #[test]
    fn colon_is_not_a_hallucination_separator() {
        assert!(!is_hallucination_phrase("次回予告:"));
    }
}
