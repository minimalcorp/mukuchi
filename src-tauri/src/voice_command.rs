//! 音声コマンドの判定。発話全体が、正規化後に「言い方」と完全一致した時だけコマンドとみなす
//! (文中の「確定」等で誤ってキーを送らないため)。

use unicode_normalization::UnicodeNormalization;

use crate::settings::{KeyCombo, VoiceCommand};

/// NFKC で全角・半角を揃え、句読点・記号・空白を除き、英字を小文字にする。
/// ASRは「確定。」「確定!」のように句読点を付けることがあるため。
///
/// `src/lib/voice-command.ts` が `normalize` / `is_punctuation` と同じ処理を持つ (設定画面での重複・空の
/// 判定のため)。変更する時は両方を揃えること。
pub fn normalize(s: &str) -> String {
    s.nfkc()
        .filter(|c| !c.is_whitespace() && !is_punctuation(*c))
        .flat_map(char::to_lowercase)
        .collect()
}

fn is_punctuation(c: char) -> bool {
    if c.is_ascii_punctuation() {
        return true;
    }
    matches!(c,
        // 一般句読点 (… ‥ ‐ — “ ” など)
        '\u{2000}'..='\u{206F}'
        // CJK記号と句読点 (、。「」『』【】〜 など)。々〆〇 などの文字は除く
        | '\u{3000}'..='\u{3004}'
        | '\u{3008}'..='\u{3020}'
        | '\u{3030}'
        | '\u{303D}'
        // 中黒
        | '\u{30FB}'
        // 全角形のうちNFKCで変換されずに残るもの
        | '\u{FF5F}'..='\u{FF65}'
    )
}

/// 音声コマンドの対応表を検証する (設定の保存時)。
/// 正規化すると空になる言い方 (記号だけ等)、言い方のないコマンド、正規化後に重複する言い方は
/// どのコマンドが選ばれるか分からなくなるため受け付けない。
pub fn validate(commands: &[VoiceCommand]) -> anyhow::Result<()> {
    let mut seen = std::collections::HashMap::<String, &str>::new();
    for c in commands {
        if c.phrases.is_empty() {
            anyhow::bail!("言い方が入力されていない音声コマンドがあります");
        }
        for p in &c.phrases {
            let n = normalize(p);
            if n.is_empty() {
                anyhow::bail!("「{p}」は記号や空白だけのため言い方に使えません");
            }
            if let Some(prev) = seen.insert(n, p) {
                anyhow::bail!("言い方「{p}」が「{prev}」と重複しています");
            }
        }
    }
    Ok(())
}

/// 一致したコマンドのキーを返す。
pub fn match_command<'a>(text: &str, commands: &'a [VoiceCommand]) -> Option<&'a KeyCombo> {
    let t = normalize(text);
    if t.is_empty() {
        return None;
    }
    commands
        .iter()
        .find(|c| c.phrases.iter().any(|p| normalize(p) == t))
        .map(|c| &c.key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::{default_voice_commands, Key, Modifier};

    #[test]
    fn normalization() {
        assert_eq!(normalize("確定。"), "確定");
        assert_eq!(normalize(" 確定! "), "確定");
        assert_eq!(normalize("「送信」…"), "送信");
        assert_eq!(normalize("エンター"), "エンター");
        // 半角カナ → 全角 (NFKC)
        assert_eq!(normalize("ｴﾝﾀｰ"), "エンター");
        assert_eq!(normalize("ＥＮＴＥＲ．"), "enter");
        assert_eq!(normalize("改　行、"), "改行");
        // 長音符は記号ではなく文字として残す
        assert_eq!(normalize("ー"), "ー");
        assert_eq!(normalize("々"), "々");
    }

    #[test]
    fn validation_rejects_empty_and_duplicates() {
        use crate::settings::{Key, KeyCombo, VoiceCommand};
        let cmd = |phrases: &[&str]| VoiceCommand {
            id: "x".into(),
            phrases: phrases.iter().map(|s| s.to_string()).collect(),
            key: KeyCombo {
                key: Key::Enter,
                modifiers: vec![],
            },
        };
        assert!(validate(&default_voice_commands()).is_ok());
        assert!(validate(&[cmd(&["。"])]).is_err());
        assert!(validate(&[cmd(&[])]).is_err());
        // 正規化後に同じ (全角・句読点・大文字小文字の違い)
        assert!(validate(&[cmd(&["Enter"]), cmd(&["ＥＮＴＥＲ。"])]).is_err());
        assert!(validate(&[cmd(&["確定", "確定!"])]).is_err());
        let mut cmds = default_voice_commands();
        cmds.push(cmd(&["エンター"]));
        let e = validate(&cmds).unwrap_err().to_string();
        assert!(e.contains("重複"), "{e}");
    }

    #[test]
    fn exact_match_only() {
        let cmds = default_voice_commands();
        let enter = match_command("確定。", &cmds).unwrap();
        assert_eq!(enter.key, Key::Enter);
        assert!(enter.modifiers.is_empty());
        assert_eq!(match_command("エンター", &cmds).unwrap().key, Key::Enter);
        assert_eq!(
            match_command("改行", &cmds).unwrap().modifiers,
            vec![Modifier::Shift]
        );
        assert_eq!(
            match_command("送信!", &cmds).unwrap().modifiers,
            vec![Modifier::Cmd]
        );
        assert!(match_command("これで確定します", &cmds).is_none());
        assert!(match_command("確定確定", &cmds).is_none());
        assert!(match_command("", &cmds).is_none());
        assert!(match_command("。", &cmds).is_none());
    }
}
