//! 設定 (`settings.json`) の読み書き・既定値・検証。
//!
//! 型は docs/architecture.md の `Settings` と一致させる。フロントエンドからの更新は
//! トップレベルのキー単位の部分更新 (`Partial<Settings>`) で受ける。

use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::i18n::{Locale, Msg, UiLanguage};

pub const VAD_SENSITIVITY_MAX: u32 = 100;
pub const SILENCE_MS_MIN: u32 = 300;
pub const SILENCE_MS_MAX: u32 = 3000;
/// 認識のヒントの上限 (Unicode スカラー値の数)。context は URL のクエリで送るため、uvicorn (h11) の
/// リクエスト行+ヘッダーの上限 16KiB に日本語の URL エンコード (1文字9バイト) で収まるようにする。
/// 長いほど毎回の推論も遅くなる
pub const ASR_CONTEXT_MAX_CHARS: usize = 1000;

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
    /// 認識のヒント (自由記述)。ASR の context にそのまま渡す (asr::asr_context)
    pub asr_context: String,
    pub excluded_apps: Vec<ExcludedApp>,
    pub panel_position: Option<PanelPosition>,
    pub setup_completed: bool,
    pub panel_style: PanelStyle,
    pub input_mode: InputMode,
    /// 自動でアップデートを確認・取得する (update.rs)。旧設定 (キーなし) は true
    pub auto_check_updates: bool,
    /// ON/OFF のグローバルショートカット (`shortcut::parse` の形式)。None は無効
    pub shortcut: Option<String>,
    /// 表示言語 (docs/architecture.md「言語」)。system は macOS の優先言語から解決する (i18n::UiLanguage::resolve)
    pub ui_language: UiLanguage,
    /// 話す言語。ASR の language・推奨モデル・音声コマンドの既定を決める。
    /// 既存の設定に無ければ ja (それまで日本語だけだったため)。新規は `Settings::new_install` で表示言語に合わせる
    #[serde(deserialize_with = "lenient_locale")]
    pub speech_language: Locale,
}

/// 未知の値・文字列でない値 (null 等) は既定 (ja) として読む (設定全体を捨てない)。
/// 変更時の不正な値は apply_patch がエラーにする
fn lenient_locale<'de, D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Locale, D::Error> {
    let v = serde_json::Value::deserialize(d)?;
    Ok(v.as_str().and_then(Locale::parse).unwrap_or_default())
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
            voice_commands: default_voice_commands(Locale::default()),
            asr_context: String::new(),
            excluded_apps: Vec::new(),
            panel_position: None,
            setup_completed: false,
            panel_style: PanelStyle::Full,
            input_mode: InputMode::Continuous,
            auto_check_updates: true,
            shortcut: Some(DEFAULT_SHORTCUT.to_string()),
            ui_language: UiLanguage::System,
            speech_language: Locale::default(),
        }
    }
}

/// 話す言語ごとの音声コマンドの既定 (docs/architecture.md「言語」の音声コマンドの既定)。
/// id とキーは言語によらず同じにする (言い方だけが言語ごとに違う)
pub fn default_voice_commands(lang: Locale) -> Vec<VoiceCommand> {
    let (enter, newline, send): (&[&str], &[&str], &[&str]) = match lang {
        Locale::Ja => (&["確定", "エンター"], &["改行"], &["送信"]),
        Locale::En => (&["enter"], &["new line", "line break"], &["send"]),
    };
    let cmd = |id: &str, phrases: &[&str], key: Key, modifiers: Vec<Modifier>| VoiceCommand {
        id: id.to_string(),
        phrases: phrases.iter().map(|s| s.to_string()).collect(),
        key: KeyCombo { key, modifiers },
    };
    vec![
        cmd("enter", enter, Key::Enter, vec![]),
        cmd("newline", newline, Key::Enter, vec![Modifier::Shift]),
        cmd("send", send, Key::Enter, vec![Modifier::Cmd]),
    ]
}

impl Settings {
    /// 新規 (settings.json が無い) の既定。話す言語は解決した表示言語に合わせる
    pub fn new_install(display: Locale) -> Self {
        Self {
            speech_language: display,
            voice_commands: default_voice_commands(display),
            ..Self::default()
        }
    }

    /// 範囲外の値を丸める。不正な値でアプリが動かなくなるより、近い有効値で動く方がよい。
    pub fn normalized(mut self) -> Self {
        self.vad_sensitivity = self.vad_sensitivity.min(VAD_SENSITIVITY_MAX);
        self.silence_ms = self.silence_ms.clamp(SILENCE_MS_MIN, SILENCE_MS_MAX);
        self.input_device_id = self.input_device_id.filter(|s| !s.is_empty());
        // 文章として扱うため、中の改行・空白は残して前後だけ除く
        self.asr_context = self.asr_context.trim().to_string();
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
        let patch = patch.as_object().ok_or(Msg::SettingsInvalidType)?;
        let mut base = serde_json::to_value(self).context("設定のシリアライズに失敗")?;
        let obj = base
            .as_object_mut()
            .context("設定がオブジェクトではありません")?;
        for (k, v) in patch {
            if !obj.contains_key(k) {
                anyhow::bail!(Msg::SettingsUnknownKey { key: k.clone() });
            }
            // 列挙の値は読み込み時には未知の値を既定として読むため、変更時にここで弾く
            let valid = match k.as_str() {
                "panelStyle" => v.as_str().and_then(PanelStyle::parse).is_some(),
                "inputMode" => v.as_str().and_then(InputMode::parse).is_some(),
                "uiLanguage" => v.as_str().and_then(UiLanguage::parse).is_some(),
                "speechLanguage" => v.as_str().and_then(Locale::parse).is_some(),
                _ => true,
            };
            if !valid {
                log::warn!("設定 {k} の値が不正: {v}");
                anyhow::bail!(Msg::SettingsInvalidValue { key: k.clone() });
            }
            obj.insert(k.clone(), v.clone());
        }
        // serde の詳細 (英語の技術的な文) は表示せずログにだけ出す
        let next: Settings = serde_json::from_value(base).map_err(|e| {
            log::warn!("設定の値の型が正しくありません: {e}");
            Msg::SettingsInvalidType
        })?;
        let mut next = next.normalized();
        // 話す言語を変えた時、音声コマンドが変更前の言語の既定のまま (編集していない) なら新しい言語の既定にする。
        // 同じ変更で音声コマンドも渡された場合はそちらを使う
        if next.speech_language != self.speech_language
            && !patch.contains_key("voiceCommands")
            && self.voice_commands == default_voice_commands(self.speech_language)
        {
            next.voice_commands = default_voice_commands(next.speech_language);
        }
        // 保存済みの値は検証しない (古い設定が不正でも他の項目を変更できるように)。変更する時だけ
        if patch.contains_key("voiceCommands") {
            crate::voice_command::validate(&next.voice_commands)?;
        }
        if patch.contains_key("asrContext")
            && next.asr_context.chars().count() > ASR_CONTEXT_MAX_CHARS
        {
            anyhow::bail!(Msg::AsrContextTooLong {
                max: ASR_CONTEXT_MAX_CHARS
            });
        }
        if patch.contains_key("shortcut") {
            if let Some(sc) = &next.shortcut {
                crate::shortcut::parse(sc)?;
            }
        }
        Ok(next)
    }
}

impl Settings {
    /// 保存済みの settings.json を読む。旧形式の移行と、範囲外の値の丸めを行う。
    fn from_saved(bytes: &[u8]) -> Result<Settings> {
        let mut value: serde_json::Value =
            serde_json::from_slice(bytes).context("JSON として読めません")?;
        migrate_vocabulary(&mut value);
        let has_voice_commands = value.get("voiceCommands").is_some();
        let mut s: Settings =
            serde_json::from_value(value).context("設定の値の型が正しくありません")?;
        if !has_voice_commands {
            // キーが無ければ話す言語の既定 (struct の既定は ja のため)
            s.voice_commands = default_voice_commands(s.speech_language);
        }
        s = s.normalized();
        // 手で編集する等で上限を超えていても起動は止めず、上限で切って使う (normalized と同じく
        // 近い有効値で動かす)。変更時は apply_patch がエラーにして保存させない。
        // 切るのは読み込み時だけ (apply_patch の前に切ると上限超過を検出できないため normalized には置かない)
        if let Some((i, _)) = s.asr_context.char_indices().nth(ASR_CONTEXT_MAX_CHARS) {
            log::warn!("認識のヒントが{ASR_CONTEXT_MAX_CHARS}文字を超えているため切り詰める");
            s.asr_context.truncate(i);
            s = s.normalized();
        }
        Ok(s)
    }
}

/// 旧形式の `vocabulary: string[]` を `asrContext` に移す。それまで ASR に渡していた context と
/// 同じになるよう、前後の空白を除いた空でない語を空白区切りでつなぐ。
/// `asrContext` がある場合はそちらを使う。旧キーは Settings のフィールドにないため保存時に消える
fn migrate_vocabulary(value: &mut serde_json::Value) {
    let Some(obj) = value.as_object_mut() else {
        return;
    };
    let Some(legacy) = obj.remove("vocabulary") else {
        return;
    };
    if obj.contains_key("asrContext") {
        return;
    }
    // 型の違う旧値は移さない (旧形式の不正値で設定全体を捨てないため)
    let Some(words) = legacy.as_array() else {
        return;
    };
    let joined = words
        .iter()
        .filter_map(|w| w.as_str())
        .map(str::trim)
        .filter(|w| !w.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    obj.insert("asrContext".into(), serde_json::Value::String(joined));
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
    /// `system` は macOS の優先言語から求めた表示言語。新規 (と読めない時) の話す言語に使う
    pub fn load(path: PathBuf, system: Locale) -> Self {
        let settings = match std::fs::read(&path) {
            Ok(bytes) => match Settings::from_saved(&bytes) {
                Ok(s) => s,
                Err(e) => {
                    log::warn!("settings.json を読めないため既定値を使う: {e}");
                    let backup = path.with_extension("json.broken");
                    if let Err(e) = std::fs::rename(&path, &backup) {
                        log::warn!("壊れた settings.json の退避に失敗: {e}");
                    }
                    Settings::new_install(system)
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Settings::new_install(system),
            Err(e) => {
                log::warn!("settings.json の読み込みに失敗: {e}");
                Settings::new_install(system)
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
            // 詳細 (パス・OS のエラー) はログにだけ出す
            log::error!("設定を保存できません: {e:#}");
            return Err(Msg::SettingsSaveFailed.into());
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
    fn auto_check_updates_default_and_patch() {
        let s = Settings::default();
        assert!(s.auto_check_updates);
        assert_eq!(serde_json::to_value(&s).unwrap()["autoCheckUpdates"], true);
        let old: Settings = serde_json::from_value(json!({ "silenceMs": 800 })).unwrap();
        assert!(old.auto_check_updates);
        let next = s
            .apply_patch(&json!({ "autoCheckUpdates": false }))
            .unwrap();
        assert!(!next.auto_check_updates);
        assert!(s.apply_patch(&json!({ "autoCheckUpdates": "no" })).is_err());
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
        let store = SettingsStore::load(path.clone(), Locale::Ja);
        assert_eq!(store.get(), Settings::default());
        store
            .update(&json!({ "asrContext": " mukuchi の話\n固有名詞 \n", "inputDeviceId": "" }))
            .unwrap();
        let reloaded = SettingsStore::load(path.clone(), Locale::Ja);
        assert_eq!(reloaded.get().asr_context, "mukuchi の話\n固有名詞");
        assert_eq!(reloaded.get().input_device_id, None);

        std::fs::write(&path, b"{broken").unwrap();
        let broken = SettingsStore::load(path.clone(), Locale::Ja);
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
        let store = SettingsStore::load(dir.join("settings.json"), Locale::Ja);

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
        let store = SettingsStore::load(blocked.join("settings.json"), Locale::Ja);
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
    fn asr_context_default_and_limit() {
        let s = Settings::default();
        assert_eq!(s.asr_context, "");
        assert_eq!(serde_json::to_value(&s).unwrap()["asrContext"], "");
        // 日本語も1文字として数える。前後の空白は数えない
        let ok = "あ".repeat(ASR_CONTEXT_MAX_CHARS);
        let next = s
            .apply_patch(&json!({ "asrContext": format!("  {ok}\n") }))
            .unwrap();
        assert_eq!(next.asr_context, ok);
        let e = s
            .apply_patch(&json!({ "asrContext": "a".repeat(ASR_CONTEXT_MAX_CHARS + 1) }))
            .unwrap_err();
        assert_eq!(format!("{e:#}"), "認識のヒントは1000文字以内にしてください");
        assert!(s
            .apply_patch(&json!({ "asrContext": "😀".repeat(ASR_CONTEXT_MAX_CHARS + 1) }))
            .is_err());
        // 旧キーは受け付けない
        assert!(s.apply_patch(&json!({ "vocabulary": ["x"] })).is_err());
    }

    #[test]
    fn load_truncates_too_long_asr_context() {
        let long = format!("{}い", "あ".repeat(ASR_CONTEXT_MAX_CHARS));
        let s = Settings::from_saved(json!({ "asrContext": long }).to_string().as_bytes()).unwrap();
        assert_eq!(s.asr_context, "あ".repeat(ASR_CONTEXT_MAX_CHARS));
    }

    #[test]
    fn legacy_vocabulary_is_migrated() {
        let load = |v: serde_json::Value| Settings::from_saved(v.to_string().as_bytes()).unwrap();
        let s = load(json!({ "vocabulary": [" Tauri ", "", "  ", "mukuchi"], "silenceMs": 800 }));
        assert_eq!(
            (s.asr_context.as_str(), s.silence_ms),
            ("Tauri mukuchi", 800)
        );
        // 旧キーは書き戻さない
        let v = serde_json::to_value(&s).unwrap();
        assert!(v.get("vocabulary").is_none());
        // 両方あれば asrContext を使う
        let s = load(json!({ "vocabulary": ["Tauri"], "asrContext": "ヒント" }));
        assert_eq!(s.asr_context, "ヒント");
        // 空の旧値、型の違う旧値でも設定全体は捨てない
        assert_eq!(load(json!({ "vocabulary": [] })).asr_context, "");
        let s = load(json!({ "vocabulary": "x", "silenceMs": 800 }));
        assert_eq!((s.asr_context.as_str(), s.silence_ms), ("", 800));
    }

    #[test]
    fn store_migrates_legacy_vocabulary_and_drops_it_on_save() {
        let dir = std::env::temp_dir().join(format!(
            "mukuchi-settings-test-vocab-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        std::fs::write(
            &path,
            json!({ "vocabulary": ["Tauri", "mukuchi"] }).to_string(),
        )
        .unwrap();
        let store = SettingsStore::load(path.clone(), Locale::Ja);
        assert_eq!(store.get().asr_context, "Tauri mukuchi");
        store.update(&json!({ "silenceMs": 800 })).unwrap();
        let saved: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert!(saved.get("vocabulary").is_none());
        assert_eq!(saved["asrContext"], "Tauri mukuchi");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn languages_default_new_install_and_existing() {
        // 既存の設定 (キーなし) は ja: それまで日本語だけだったため
        let old = Settings::from_saved(json!({ "silenceMs": 800 }).to_string().as_bytes()).unwrap();
        assert_eq!(
            (old.ui_language, old.speech_language),
            (UiLanguage::System, Locale::Ja)
        );
        assert_eq!(old.voice_commands, default_voice_commands(Locale::Ja));
        // 新規は解決した表示言語
        let fresh = Settings::new_install(Locale::En);
        assert_eq!(fresh.ui_language, UiLanguage::System);
        assert_eq!(fresh.speech_language, Locale::En);
        assert_eq!(fresh.voice_commands, default_voice_commands(Locale::En));
        assert_eq!(Settings::new_install(Locale::Ja), Settings::default());
        let v = serde_json::to_value(&fresh).unwrap();
        assert_eq!(
            (v["uiLanguage"].clone(), v["speechLanguage"].clone()),
            (json!("system"), json!("en"))
        );
        // 未知の値は既定として読み、設定全体は捨てない
        let s = Settings::from_saved(
            json!({ "uiLanguage": "fr", "speechLanguage": "de", "silenceMs": 800 })
                .to_string()
                .as_bytes(),
        )
        .unwrap();
        assert_eq!(
            (s.ui_language, s.speech_language, s.silence_ms),
            (UiLanguage::System, Locale::Ja, 800)
        );
        // 文字列でない値 (null 等) でも設定全体は捨てない
        let s = Settings::from_saved(
            json!({ "uiLanguage": null, "speechLanguage": 3, "silenceMs": 800 })
                .to_string()
                .as_bytes(),
        )
        .unwrap();
        assert_eq!(
            (s.ui_language, s.speech_language, s.silence_ms),
            (UiLanguage::System, Locale::Ja, 800)
        );
        // 音声コマンドが無く話す言語が en なら en の既定
        let s =
            Settings::from_saved(json!({ "speechLanguage": "en" }).to_string().as_bytes()).unwrap();
        assert_eq!(s.voice_commands, default_voice_commands(Locale::En));
        // 保存された音声コマンドはそのまま
        let s = Settings::from_saved(
            json!({ "speechLanguage": "en", "voiceCommands": [] })
                .to_string()
                .as_bytes(),
        )
        .unwrap();
        assert!(s.voice_commands.is_empty());
    }

    #[test]
    fn store_new_install_uses_system_locale() {
        let dir = tempfile::tempdir().unwrap();
        let store = SettingsStore::load(dir.path().join("settings.json"), Locale::En);
        assert_eq!(store.get().speech_language, Locale::En);
        assert_eq!(
            store.get().voice_commands,
            default_voice_commands(Locale::En)
        );
    }

    #[test]
    fn type_error_is_reported_without_serde_details() {
        let e = Settings::default()
            .apply_patch(&json!({ "silenceMs": "x" }))
            .unwrap_err();
        assert_eq!(format!("{e:#}"), Msg::SettingsInvalidType.to_string());
        assert_eq!(e.downcast_ref::<Msg>(), Some(&Msg::SettingsInvalidType));
    }

    #[test]
    fn language_patch_validation() {
        let s = Settings::default();
        let next = s
            .apply_patch(&json!({ "uiLanguage": "en", "speechLanguage": "en" }))
            .unwrap();
        assert_eq!(
            (next.ui_language, next.speech_language),
            (UiLanguage::En, Locale::En)
        );
        assert_eq!(
            s.apply_patch(&json!({ "uiLanguage": "ja" }))
                .unwrap()
                .ui_language,
            UiLanguage::Ja
        );
        for bad in [
            json!({ "uiLanguage": "fr" }),
            json!({ "uiLanguage": 1 }),
            json!({ "speechLanguage": "system" }),
            json!({ "speechLanguage": "EN" }),
        ] {
            assert!(s.apply_patch(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn speech_language_change_swaps_default_voice_commands_only() {
        let ja = Settings::default();
        // 既定のままなら新しい言語の既定に入れ替える
        let en = ja.apply_patch(&json!({ "speechLanguage": "en" })).unwrap();
        assert_eq!(en.voice_commands, default_voice_commands(Locale::En));
        let back = en.apply_patch(&json!({ "speechLanguage": "ja" })).unwrap();
        assert_eq!(back.voice_commands, default_voice_commands(Locale::Ja));
        // 編集済みなら変えない
        let mut edited = ja.clone();
        edited.voice_commands[0].phrases.push("オッケー".into());
        let next = edited
            .apply_patch(&json!({ "speechLanguage": "en" }))
            .unwrap();
        assert_eq!(next.voice_commands, edited.voice_commands);
        // 同じ変更で音声コマンドも渡されたらそちら
        let custom =
            json!([{ "id": "x", "phrases": ["go"], "key": { "key": "enter", "modifiers": [] } }]);
        let next = ja
            .apply_patch(&json!({ "speechLanguage": "en", "voiceCommands": custom }))
            .unwrap();
        assert_eq!(next.voice_commands.len(), 1);
        // 話す言語が変わらなければ何もしない
        let same = ja.apply_patch(&json!({ "speechLanguage": "ja" })).unwrap();
        assert_eq!(same.voice_commands, ja.voice_commands);
    }

    #[test]
    fn default_voice_commands_per_language() {
        for l in Locale::ALL {
            let c = default_voice_commands(l);
            assert!(crate::voice_command::validate(&c).is_ok(), "{l:?}");
            let ids: Vec<&str> = c.iter().map(|c| c.id.as_str()).collect();
            assert_eq!(ids, ["enter", "newline", "send"], "{l:?}");
        }
        let en = default_voice_commands(Locale::En);
        use crate::voice_command::match_command;
        assert_eq!(match_command("Enter.", &en).unwrap().modifiers, vec![]);
        assert_eq!(
            match_command("New line.", &en).unwrap().modifiers,
            vec![Modifier::Shift]
        );
        assert_eq!(
            match_command("line break", &en).unwrap().modifiers,
            vec![Modifier::Shift]
        );
        assert_eq!(
            match_command("Send!", &en).unwrap().modifiers,
            vec![Modifier::Cmd]
        );
    }

    #[test]
    fn save_failure_is_reported_without_details() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("settings.json").join("x")).unwrap();
        let store = SettingsStore::load(dir.path().join("settings.json"), Locale::Ja);
        let e = store.update(&json!({ "silenceMs": 800 })).unwrap_err();
        assert_eq!(e.downcast_ref::<Msg>(), Some(&Msg::SettingsSaveFailed));
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
