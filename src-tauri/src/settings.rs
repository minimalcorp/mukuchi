//! 設定 (`settings.json`) の読み書き・既定値・検証。
//!
//! 型は docs/architecture.md の `Settings` と一致させる。フロントエンドからの更新は
//! トップレベルのキー単位の部分更新 (`Partial<Settings>`) で受ける。

use std::path::{Path, PathBuf};
use std::sync::RwLock;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

pub const VAD_SENSITIVITY_MAX: u32 = 100;
pub const SILENCE_MS_MIN: u32 = 300;
pub const SILENCE_MS_MAX: u32 = 3000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Key {
    Enter,
    Tab,
    Escape,
    Backspace,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Modifier {
    Cmd,
    Shift,
    Option,
    Ctrl,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyCombo {
    pub key: Key,
    pub modifiers: Vec<Modifier>,
}

impl KeyCombo {
    /// パネル表示用の文字列 (例 "⌘+Enter")。
    pub fn display(&self) -> String {
        let mut mods = self.modifiers.clone();
        mods.sort();
        mods.dedup();
        // macOS の慣例順 (⌃⌥⇧⌘) で並べる
        let order = [
            Modifier::Ctrl,
            Modifier::Option,
            Modifier::Shift,
            Modifier::Cmd,
        ];
        let mut parts: Vec<&str> = order
            .iter()
            .filter(|m| mods.contains(m))
            .map(|m| match m {
                Modifier::Cmd => "⌘",
                Modifier::Shift => "⇧",
                Modifier::Option => "⌥",
                Modifier::Ctrl => "⌃",
            })
            .collect();
        parts.push(match self.key {
            Key::Enter => "Enter",
            Key::Tab => "Tab",
            Key::Escape => "Esc",
            Key::Backspace => "Delete",
        });
        parts.join("+")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceCommand {
    pub id: String,
    pub phrases: Vec<String>,
    pub key: KeyCombo,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExcludedApp {
    pub bundle_id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelPosition {
    pub x: f64,
    pub y: f64,
    pub display_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub launch_at_login: bool,
    pub input_device_id: Option<String>,
    pub vad_sensitivity: u32,
    pub silence_ms: u32,
    pub voice_commands_enabled: bool,
    pub voice_commands: Vec<VoiceCommand>,
    pub vocabulary: Vec<String>,
    pub excluded_apps: Vec<ExcludedApp>,
    pub panel_position: Option<PanelPosition>,
    pub setup_completed: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            launch_at_login: true,
            input_device_id: None,
            vad_sensitivity: 60,
            // 言葉を考える間で発話が分割されないよう長め (implementation-plan.md 2.)
            silence_ms: 1300,
            voice_commands_enabled: true,
            voice_commands: default_voice_commands(),
            vocabulary: Vec::new(),
            excluded_apps: Vec::new(),
            panel_position: None,
            setup_completed: false,
        }
    }
}

pub fn default_voice_commands() -> Vec<VoiceCommand> {
    let cmd = |id: &str, phrases: &[&str], key: Key, modifiers: Vec<Modifier>| VoiceCommand {
        id: id.to_string(),
        phrases: phrases.iter().map(|s| s.to_string()).collect(),
        key: KeyCombo { key, modifiers },
    };
    vec![
        cmd("enter", &["確定", "エンター"], Key::Enter, vec![]),
        cmd("newline", &["改行"], Key::Enter, vec![Modifier::Shift]),
        cmd("send", &["送信"], Key::Enter, vec![Modifier::Cmd]),
    ]
}

impl Settings {
    /// 範囲外の値を丸める。不正な値でアプリが動かなくなるより、近い有効値で動く方がよい。
    pub fn normalized(mut self) -> Self {
        self.vad_sensitivity = self.vad_sensitivity.min(VAD_SENSITIVITY_MAX);
        self.silence_ms = self.silence_ms.clamp(SILENCE_MS_MIN, SILENCE_MS_MAX);
        self.input_device_id = self.input_device_id.filter(|s| !s.is_empty());
        self.vocabulary = self
            .vocabulary
            .into_iter()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        for c in &mut self.voice_commands {
            c.phrases = c
                .phrases
                .iter()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
        }
        self
    }

    /// トップレベルのキー単位で上書きする。未知のキーや型違いはエラー。
    pub fn apply_patch(&self, patch: &serde_json::Value) -> Result<Settings> {
        let patch = patch
            .as_object()
            .context("patch はオブジェクトである必要があります")?;
        let mut base = serde_json::to_value(self).context("設定のシリアライズに失敗")?;
        let obj = base
            .as_object_mut()
            .context("設定がオブジェクトではありません")?;
        for (k, v) in patch {
            if !obj.contains_key(k) {
                anyhow::bail!("未知の設定キー: {k}");
            }
            obj.insert(k.clone(), v.clone());
        }
        let next: Settings =
            serde_json::from_value(base).context("設定の値の型が正しくありません")?;
        let next = next.normalized();
        // 保存済みの値は検証しない (古い設定が不正でも他の項目を変更できるように)。変更する時だけ
        if patch.contains_key("voiceCommands") {
            crate::voice_command::validate(&next.voice_commands)?;
        }
        Ok(next)
    }
}

/// 設定の保持と永続化。
pub struct SettingsStore {
    path: PathBuf,
    current: RwLock<Settings>,
}

impl SettingsStore {
    /// 読めない・壊れている場合は既定値で起動する (壊れたファイルは退避して残す)。
    pub fn load(path: PathBuf) -> Self {
        let settings = match std::fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<Settings>(&bytes) {
                Ok(s) => s.normalized(),
                Err(e) => {
                    log::warn!("settings.json を読めないため既定値を使う: {e}");
                    let backup = path.with_extension("json.broken");
                    if let Err(e) = std::fs::rename(&path, &backup) {
                        log::warn!("壊れた settings.json の退避に失敗: {e}");
                    }
                    Settings::default()
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Settings::default(),
            Err(e) => {
                log::warn!("settings.json の読み込みに失敗: {e}");
                Settings::default()
            }
        };
        Self {
            path,
            current: RwLock::new(settings),
        }
    }

    pub fn get(&self) -> Settings {
        match self.current.read() {
            Ok(g) => g.clone(),
            Err(p) => p.into_inner().clone(),
        }
    }

    /// 部分更新して保存する。保存に失敗した場合はメモリ上の値も更新しない。
    pub fn update(&self, patch: &serde_json::Value) -> Result<Settings> {
        let mut guard = match self.current.write() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        let next = guard.apply_patch(patch)?;
        write_atomic(&self.path, &next)?;
        *guard = next.clone();
        Ok(next)
    }
}

/// 書き込み途中で落ちても壊れたファイルが残らないよう、一時ファイルに書いてから rename する。
fn write_atomic(path: &Path, settings: &Settings) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .with_context(|| format!("ディレクトリを作成できません: {}", dir.display()))?;
    }
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_vec_pretty(settings).context("設定のシリアライズに失敗")?;
    std::fs::write(&tmp, json).with_context(|| format!("書き込みに失敗: {}", tmp.display()))?;
    std::fs::rename(&tmp, path).with_context(|| format!("rename に失敗: {}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn defaults_match_spec() {
        let s = Settings::default();
        assert!(s.launch_at_login);
        assert_eq!(s.vad_sensitivity, 60);
        assert_eq!(s.silence_ms, 1300);
        assert!(s.voice_commands_enabled);
        assert_eq!(s.input_device_id, None);
        assert!(!s.setup_completed);
        let v = serde_json::to_value(&s).unwrap();
        // JSON は camelCase
        assert_eq!(v["silenceMs"], 1300);
        assert_eq!(v["voiceCommands"][0]["key"]["key"], "enter");
        assert_eq!(v["voiceCommands"][2]["key"]["modifiers"][0], "cmd");
    }

    #[test]
    fn missing_fields_fall_back_to_defaults() {
        let s: Settings = serde_json::from_value(json!({ "silenceMs": 800 })).unwrap();
        assert_eq!(s.silence_ms, 800);
        assert_eq!(s.vad_sensitivity, 60);
        assert_eq!(s.voice_commands.len(), 3);
    }

    #[test]
    fn patch_clamps_and_rejects_unknown() {
        let s = Settings::default();
        let next = s
            .apply_patch(&json!({ "silenceMs": 10, "vadSensitivity": 500 }))
            .unwrap();
        assert_eq!(next.silence_ms, SILENCE_MS_MIN);
        assert_eq!(next.vad_sensitivity, 100);
        let next = s.apply_patch(&json!({ "silenceMs": 99999 })).unwrap();
        assert_eq!(next.silence_ms, SILENCE_MS_MAX);
        assert!(s.apply_patch(&json!({ "nope": 1 })).is_err());
        assert!(s.apply_patch(&json!({ "silenceMs": "x" })).is_err());
        assert!(s.apply_patch(&json!([1])).is_err());
    }

    #[test]
    fn patch_rejects_invalid_voice_commands() {
        let s = Settings::default();
        let mut cmds = serde_json::to_value(&s.voice_commands).unwrap();
        cmds[1]["phrases"] = json!(["確定。"]);
        let e = s
            .apply_patch(&json!({ "voiceCommands": cmds }))
            .unwrap_err();
        assert!(format!("{e:#}").contains("重複"));
        cmds[1]["phrases"] = json!(["  ", "、"]);
        assert!(s.apply_patch(&json!({ "voiceCommands": cmds })).is_err());
        cmds[1]["phrases"] = json!([" 改行 "]);
        let next = s.apply_patch(&json!({ "voiceCommands": cmds })).unwrap();
        assert_eq!(next.voice_commands[1].phrases, vec!["改行".to_string()]);
    }

    #[test]
    fn store_persists_and_reloads() {
        let dir =
            std::env::temp_dir().join(format!("mukuchi-settings-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("settings.json");
        let store = SettingsStore::load(path.clone());
        assert_eq!(store.get(), Settings::default());
        store
            .update(&json!({ "vocabulary": [" mukuchi ", ""], "inputDeviceId": "" }))
            .unwrap();
        let reloaded = SettingsStore::load(path.clone());
        assert_eq!(reloaded.get().vocabulary, vec!["mukuchi".to_string()]);
        assert_eq!(reloaded.get().input_device_id, None);

        std::fs::write(&path, b"{broken").unwrap();
        let broken = SettingsStore::load(path.clone());
        assert_eq!(broken.get(), Settings::default());
        assert!(path.with_extension("json.broken").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn key_combo_display() {
        let k = KeyCombo {
            key: Key::Enter,
            modifiers: vec![Modifier::Cmd, Modifier::Shift],
        };
        assert_eq!(k.display(), "⇧+⌘+Enter");
    }
}
