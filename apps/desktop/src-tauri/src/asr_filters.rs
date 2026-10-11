//! 認識結果の除外 (Windows の llama-server 経路。docs/architecture.md「ASR (Windows)」の暴走の防止)。
//!
//! Mac は ASR サーバー (asr-server の `filters.py`) が除外する。Windows の llama-server にはその仕組みが無いため、
//! 同じ規則を Rust に移す (`is_hallucination_phrase`。tests/test_filters.py と同じケースで同じ結果にする)。
//! 加えて、無音・雑音で同じ語句を上限まで繰り返す暴走 (spikes/asr-bench/WINDOWS_DECISION.md「ハルシネーション」:
//! 元の Qwen は無音を日本語指定で送ると「自分の心に」を 256 トークンまで繰り返した) を検出して捨てる。

/// YouTube 字幕由来の典型的なハルシネーション (filters.py の HALLUCINATION_PHRASES と同じ)。
/// 出力全体が (区切りを除いて) これらと完全一致する場合のみ除外する。部分一致にしないのは、
/// 利用者が実際にこれらの語を含む文を話すケースを壊さないため
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
pub fn is_hallucination_phrase(text: &str) -> bool {
    let s: String = text.chars().filter(|c| !is_separator(*c)).collect();
    HALLUCINATION_PHRASES.contains(&s.as_str())
}

/// 繰り返しの単位として見る最長の文字数 (「自分の心に」は5文字、英語の短い文で30文字前後)
const MAX_UNIT_CHARS: usize = 40;
/// この回数以上続けて同じ語句が出たら暴走とみなす
const MIN_REPEATS: usize = 4;
/// 繰り返しの部分がこの文字数以上の時だけ暴走とみなす。「はいはいはいはい」(8文字) のような
/// 実際に話しうる短い繰り返しを捨てないため
const MIN_RUN_CHARS: usize = 20;

/// 同じ語句が続けて繰り返されている (暴走) か。区切り (空白・句読点) と大文字小文字は無視して比べる
/// (「自分の心に、自分の心に…」「the first, the first…」を同じ語句の繰り返しとして見るため)
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
}
