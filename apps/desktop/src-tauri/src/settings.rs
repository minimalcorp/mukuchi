//! 設定 (`settings.json`) の読み書き・既定値・検証。
//!
//! 型は docs/architecture.md の `Settings` と一致させる。フロントエンドからの更新は
//! トップレベルのキー単位の部分更新 (`Partial<Settings>`) で受ける。

use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock};

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
    /// 位置の意味の版。1 (旧・フィールドなし) = ウィンドウの下端中央、2 = ピルのアンカー点。
    /// 旧形式は windows がディスプレイと大きさの分かった時点で 2 に移行して保存し直す
    #[serde(default = "PanelPosition::legacy_version")]
    pub version: u32,
}

impl PanelPosition {
    pub const LEGACY_VERSION: u32 = 1;
    pub const CURRENT_VERSION: u32 = 2;

    fn legacy_version() -> u32 {
        Self::LEGACY_VERSION
    }
}

/// パネルの表示形式。compact はマイクの円形ボタンのみ (描き分けはフロントエンド)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PanelStyle {
    #[default]
    Full,
    Compact,
}

impl PanelStyle {
    fn parse(s: &str) -> Option<Self> {
        match s {
            "full" => Some(Self::Full),
            "compact" => Some(Self::Compact),
            _ => None,
        }
    }
}

/// 保存済みの値が未知 (新しい版で増えた値に戻した等) でも設定全体を捨てないよう、既定値として読む。
/// 変更時の不正な値は `apply_patch` がエラーにする
impl<'de> Deserialize<'de> for PanelStyle {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        Ok(Self::parse(&s).unwrap_or_default())
    }
}

/// 入力モード (docs/architecture.md「入力モード」)。oneShot は1発話を確定したら自動で OFF に戻る
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum InputMode {
    #[default]
    Continuous,
    OneShot,
}

impl InputMode {
    fn parse(s: &str) -> Option<Self> {
        match s {
            "continuous" => Some(Self::Continuous),
            "oneShot" => Some(Self::OneShot),
            _ => None,
        }
    }
}

/// PanelStyle と同じく、未知の値は既定として読む (設定全体を捨てない)
impl<'de> Deserialize<'de> for InputMode {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        Ok(Self::parse(&s).unwrap_or_default())
    }
}

/// ショートカットの既定 (⌥Space)
pub const DEFAULT_SHORTCUT: &str = "Alt+Space";

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
    pub panel_style: PanelStyle,
    pub input_mode: InputMode,
    /// ON/OFF のグローバルショートカット (`shortcut::parse` の形式)。None は無効
    pub shortcut: Option<String>,
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
            panel_style: PanelStyle::Full,
            input_mode: InputMode::Continuous,
            shortcut: Some(DEFAULT_SHORTCUT.to_string()),
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
            if k == "panelStyle" && v.as_str().and_then(PanelStyle::parse).is_none() {
                anyhow::bail!("panelStyle が不正です: {v}");
            }
            if k == "inputMode" && v.as_str().and_then(InputMode::parse).is_none() {
                anyhow::bail!("inputMode が不正です: {v}");
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
        if patch.contains_key("shortcut") {
            if let Some(sc) = &next.shortcut {
                crate::shortcut::parse(sc)?;
            }
        }
        Ok(next)
    }
}

/// 設定の保持と永続化。
pub struct SettingsStore {
    path: PathBuf,
    current: RwLock<Settings>,
    /// 更新同士を直列にする。外部への反映 (ログイン項目の登録等) の間も読み出しを止めないよう、
    /// `current` の書き込みロックとは分ける
    writer: Mutex<()>,
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
            writer: Mutex::new(()),
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
        self.update_with(patch, |_, _| Ok(()), |_| {})
    }

    /// 部分更新を 検証 → `apply` (アプリ外への反映) → 保存 の順に行う。
    /// 検証に失敗したら `apply` を呼ばず、`apply` が失敗したら保存しない。
    /// 保存に失敗したら `apply` の戻り値を `rollback` に渡して反映を取り消させる。
    pub fn update_with<R>(
        &self,
        patch: &serde_json::Value,
        apply: impl FnOnce(&Settings, &Settings) -> Result<R>,
        rollback: impl FnOnce(R),
    ) -> Result<Settings> {
        let _writer = self.writer.lock().unwrap_or_else(|p| p.into_inner());
        let before = self.get();
        let next = before.apply_patch(patch)?;
        let applied = apply(&before, &next)?;
        if let Err(e) = write_atomic(&self.path, &next) {
            rollback(applied);
            return Err(e);
        }
        match self.current.write() {
            Ok(mut g) => *g = next.clone(),
            Err(p) => *p.into_inner() = next.clone(),
        }
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
    fn panel_position_without_version_is_legacy() {
        let s: Settings = serde_json::from_value(json!({
            "panelPosition": { "x": 10, "y": 20, "displayId": "1" }
        }))
        .unwrap();
        let p = s.panel_position.unwrap();
        assert_eq!(p.version, PanelPosition::LEGACY_VERSION);
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v["version"], 1);
    }

    #[test]
    fn missing_fields_fall_back_to_defaults() {
        let s: Settings = serde_json::from_value(json!({ "silenceMs": 800 })).unwrap();
        assert_eq!(s.silence_ms, 800);
        assert_eq!(s.vad_sensitivity, 60);
        assert_eq!(s.voice_commands.len(), 3);
    }

    #[test]
    fn panel_style_default_patch_and_lenient_load() {
        assert_eq!(Settings::default().panel_style, PanelStyle::Full);
        assert_eq!(
            serde_json::to_value(Settings::default()).unwrap()["panelStyle"],
            "full"
        );
        // 旧設定 (キーなし) は full
        let s: Settings = serde_json::from_value(json!({})).unwrap();
        assert_eq!(s.panel_style, PanelStyle::Full);
        // 未知の値でも設定全体は捨てない
        let s: Settings =
            serde_json::from_value(json!({ "panelStyle": "tiny", "silenceMs": 800 })).unwrap();
        assert_eq!((s.panel_style, s.silence_ms), (PanelStyle::Full, 800));
        let s = Settings::default();
        let next = s.apply_patch(&json!({ "panelStyle": "compact" })).unwrap();
        assert_eq!(next.panel_style, PanelStyle::Compact);
        assert!(s.apply_patch(&json!({ "panelStyle": "tiny" })).is_err());
        assert!(s.apply_patch(&json!({ "panelStyle": 1 })).is_err());
    }

    #[test]
    fn input_mode_default_patch_and_lenient_load() {
        let s = Settings::default();
        assert_eq!(s.input_mode, InputMode::Continuous);
        assert_eq!(serde_json::to_value(&s).unwrap()["inputMode"], "continuous");
        // 旧設定 (キーなし) は continuous、未知の値でも設定全体は捨てない
        let old: Settings = serde_json::from_value(json!({})).unwrap();
        assert_eq!(old.input_mode, InputMode::Continuous);
        let s2: Settings =
            serde_json::from_value(json!({ "inputMode": "pushToTalk", "silenceMs": 800 })).unwrap();
        assert_eq!((s2.input_mode, s2.silence_ms), (InputMode::Continuous, 800));
        let next = s.apply_patch(&json!({ "inputMode": "oneShot" })).unwrap();
        assert_eq!(next.input_mode, InputMode::OneShot);
        assert_eq!(serde_json::to_value(&next).unwrap()["inputMode"], "oneShot");
        assert!(s.apply_patch(&json!({ "inputMode": "one_shot" })).is_err());
        assert!(s.apply_patch(&json!({ "inputMode": 1 })).is_err());
    }

    #[test]
    fn shortcut_default_patch_and_null() {
        let s = Settings::default();
        assert_eq!(s.shortcut.as_deref(), Some("Alt+Space"));
        assert_eq!(serde_json::to_value(&s).unwrap()["shortcut"], "Alt+Space");
        // キーなしは既定、null は無効
        let old: Settings = serde_json::from_value(json!({})).unwrap();
        assert_eq!(old.shortcut.as_deref(), Some("Alt+Space"));
        let off: Settings = serde_json::from_value(json!({ "shortcut": null })).unwrap();
        assert_eq!(off.shortcut, None);
        let next = s
            .apply_patch(&json!({ "shortcut": "Ctrl+Shift+KeyM" }))
            .unwrap();
        assert_eq!(next.shortcut.as_deref(), Some("Ctrl+Shift+KeyM"));
        let next = s.apply_patch(&json!({ "shortcut": null })).unwrap();
        assert_eq!(next.shortcut, None);
        for bad in [
            "Space",
            "Shift+Alt+Space",
            "Alt+M",
            "Alt+",
            "Alt+Foo",
            "Alt+Alt",
        ] {
            assert!(
                s.apply_patch(&json!({ "shortcut": bad })).is_err(),
                "{bad} は不正"
            );
        }
        assert!(s.apply_patch(&json!({ "shortcut": 1 })).is_err());
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
    fn update_with_validates_before_apply_and_rolls_back_on_save_failure() {
        let dir = std::env::temp_dir().join(format!(
            "mukuchi-settings-test-rollback-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = SettingsStore::load(dir.join("settings.json"));

        // 検証エラーなら反映しない
        let mut applied = false;
        let r = store.update_with(
            &json!({ "nope": 1 }),
            |_, _| {
                applied = true;
                Ok(())
            },
            |_| {},
        );
        assert!(r.is_err());
        assert!(!applied);

        // 反映に失敗したら保存しない
        let r = store.update_with(
            &json!({ "launchAtLogin": false }),
            |_, _| anyhow::bail!("登録できない"),
            |_: ()| {},
        );
        assert!(r.is_err());
        assert!(store.get().launch_at_login);

        // 保存に失敗したら取り消す (保存先にディレクトリを置いて rename を失敗させる)
        let blocked = dir.join("blocked");
        std::fs::create_dir_all(blocked.join("settings.json").join("x")).unwrap();
        let store = SettingsStore::load(blocked.join("settings.json"));
        let mut rolled_back = None;
        let r = store.update_with(
            &json!({ "launchAtLogin": false }),
            |before, next| Ok((before.launch_at_login, next.launch_at_login)),
            |v| rolled_back = Some(v),
        );
        assert!(r.is_err());
        assert_eq!(rolled_back, Some((true, false)));
        assert!(store.get().launch_at_login);
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
