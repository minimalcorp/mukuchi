//! 表示言語と表示用の文言 (docs/architecture.md「言語」)。
//!
//! - 表示言語 (`Settings.uiLanguage`) は macOS の優先言語と照らして Rust で解決し (`resolve`)、
//!   プロセス全体で1つ持つ (`current`)。表示用の文言はここに置いた `Msg` から作る
//! - `Msg` は表示言語ごとの辞書 (`ja.rs`・`en.rs`) の `match` で文字列にする。辞書には `_ =>` を書かない
//!   (キーの欠落をコンパイルで落とすため)
//! - `Msg` は `Display` (と `Serialize`) の時点の表示言語で文字列になる。エラー (`anyhow`) にそのまま入れれば、
//!   command の reject は返す時点の表示言語になり、状態 (ProvisioningStatus 等) に持てば送る時点の表示言語になる
//! - ログ (開発者向け) は日本語のまま。ここに置くのは利用者に見える文言だけ
//!
//! 言語を足す時: `Locale` に足し、辞書ファイルを1つ作って `Msg::text` に登録する
//! (話す言語なら provisioning/models.rs の `model_order` と settings.rs の音声コマンドの既定も)

mod en;
mod ja;

use std::sync::atomic::{AtomicU8, Ordering};

use serde::{Deserialize, Serialize};

/// 対応している言語 (表示言語・話す言語の両方)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Locale {
    /// それまで日本語だけだったため、既存の設定に無い時の既定にする
    #[default]
    Ja,
    En,
}

impl Locale {
    pub const ALL: [Locale; 2] = [Locale::Ja, Locale::En];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ja => "ja",
            Self::En => "en",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|l| l.as_str() == s)
    }

    /// ASR サーバーの `language` (話す言語として使う時)。省くと自動判定になり精度が崩れるため常に渡す
    pub fn asr_language(self) -> &'static str {
        match self {
            Self::Ja => "Japanese",
            Self::En => "English",
        }
    }
}

/// 表示言語の設定 (`Settings.uiLanguage`)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum UiLanguage {
    /// macOS の優先言語に合わせる
    #[default]
    System,
    Ja,
    En,
}

impl UiLanguage {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "system" => Some(Self::System),
            _ => Locale::parse(s).map(Self::from),
        }
    }

    /// 実際の表示言語。`system` は macOS の優先言語から求めたもの (`system_locale`)
    pub fn resolve(self, system: Locale) -> Locale {
        match self {
            Self::System => system,
            Self::Ja => Locale::Ja,
            Self::En => Locale::En,
        }
    }
}

impl From<Locale> for UiLanguage {
    fn from(l: Locale) -> Self {
        match l {
            Locale::Ja => Self::Ja,
            Locale::En => Self::En,
        }
    }
}

/// 未知の値・文字列でない値 (null 等) は既定 (system) として読む (設定全体を捨てない)。
/// 変更時の不正な値は settings の apply_patch がエラーにする
impl<'de> Deserialize<'de> for UiLanguage {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let v = serde_json::Value::deserialize(d)?;
        Ok(v.as_str().and_then(Self::parse).unwrap_or_default())
    }
}

// ---- 現在の表示言語 ---------------------------------------------------------------

/// 解決した表示言語。起動時と uiLanguage の変更時に Core が設定する。
/// エラー文言は深い所 (モデルの管理・セットアップ等) で作られるため、引数で回さずプロセスで1つ持つ。
/// テストでは書き換えない (並行するテストの文言が変わるため。英語の確認は `Msg::text` で行う)
static CURRENT: AtomicU8 = AtomicU8::new(0);

pub fn current() -> Locale {
    match CURRENT.load(Ordering::Relaxed) {
        1 => Locale::En,
        _ => Locale::Ja,
    }
}

/// 変わったかを返す
pub fn set_current(l: Locale) -> bool {
    let v = match l {
        Locale::Ja => 0,
        Locale::En => 1,
    };
    CURRENT.swap(v, Ordering::Relaxed) != v
}

/// 優先言語の並び (BCP 47。例 "ja-JP" "en-US" "zh-Hans-CN") を先頭から見て、最初に対応している言語。
/// どれも対応していなければ en
pub fn locale_from_preferred<'a>(languages: impl IntoIterator<Item = &'a str>) -> Locale {
    languages
        .into_iter()
        .find_map(|tag| {
            let primary = tag.split(['-', '_']).next().unwrap_or_default();
            Locale::parse(&primary.to_ascii_lowercase())
        })
        .unwrap_or(Locale::En)
}

/// macOS の優先言語 (`NSLocale.preferredLanguages`) から求めた表示言語。
/// システム設定の「言語と地域」の並びに、アプリ別の言語の設定 (アプリのドメインの `AppleLanguages`) があれば
/// それが反映される (NSUserDefaults の検索順でアプリのドメインがグローバルより先のため)
#[cfg(target_os = "macos")]
pub fn system_locale() -> Locale {
    let langs = objc2_foundation::NSLocale::preferredLanguages();
    let langs: Vec<String> = langs.iter().map(|s| s.to_string()).collect();
    let l = locale_from_preferred(langs.iter().map(String::as_str));
    log::info!("macOS の優先言語: {langs:?} → {}", l.as_str());
    l
}

/// Windows の表示言語の優先順 (設定 > 時刻と言語 > 言語と地域。`GetUserPreferredUILanguages`) から求めた表示言語。
/// 地域の形式 (`GetUserDefaultLocaleName`) ではなく表示言語を見る (mac の優先言語と同じ意味のため)
#[cfg(target_os = "windows")]
pub fn system_locale() -> Locale {
    let langs = crate::platform::preferred_ui_languages();
    let l = locale_from_preferred(langs.iter().map(String::as_str));
    log::info!("Windows の表示言語: {langs:?} → {}", l.as_str());
    l
}

// ---- 文言 -------------------------------------------------------------------------

/// カタログのモデル (provisioning/models.rs) の表示名・説明
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelText {
    Ja8bit,
    Base17b8bit,
    JaBf16,
    /// Windows (GGUF)
    JaGguf,
    BaseGguf,
}

/// アンインストールで消せなかったもの (macOS。Windows はアプリ内で消さない)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(target_os = "windows", allow(dead_code))]
pub enum UninstallPart {
    LoginItem,
    Data,
    Preferences,
    Permissions,
    AppBundle,
}

/// 利用者に見える文言。値を持つものは差し込む値 (表示用に整えたもの)
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Msg {
    // ---- AppError.message (状態のエラー) ----
    ErrAccessibilityDenied,
    ErrMicrophoneDenied,
    ErrMicrophoneMissing,
    ErrAsrStopped,
    ErrRuntimeMissing,
    ErrVadFailed,
    ErrInsertFailed,
    /// Windows のみ: 前面のアプリが管理者として動いていて入力が届かない (UIPI)
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    ErrInsertElevated,
    /// Windows のみ: GPU が使えず CPU 実行への同意も無い
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    ErrGpuUnavailable,

    // ---- メニュー (メニューバー・パネルの右クリック) ----
    /// 読み込みの進捗 (%)。分からなければ None
    MenuLoading(Option<u32>),
    MenuOffReady,
    MenuListening,
    MenuError,
    MenuOpenSystemSettings,
    MenuSelectMicrophone,
    MenuRestartAsr,
    /// Windows のみ (gpu_unavailable の復旧)
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    MenuAcceptCpu,
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    MenuProbeGpu,
    MenuOpenSetup,
    MenuTurnOn,
    MenuTurnOff,
    MenuCompact,
    MenuRestartToUpdate {
        version: String,
    },
    MenuSettings,
    MenuQuit,

    // ---- アプリのメニューバー (app_menu.rs。「終了」は MenuQuit) ----
    AppMenuAbout,
    AppMenuServices,
    AppMenuHide,
    AppMenuHideOthers,
    AppMenuShowAll,
    AppMenuFile,
    AppMenuCloseWindow,
    AppMenuEdit,
    AppMenuUndo,
    AppMenuRedo,
    AppMenuCut,
    AppMenuCopy,
    AppMenuPaste,
    AppMenuSelectAll,
    AppMenuWindow,
    AppMenuMinimize,
    AppMenuZoom,
    AppMenuHelp,

    // ---- ウィンドウのタイトル ----
    WindowSettings,
    WindowSetup,

    // ---- 操作の拒否・失敗 (command の reject) ----
    InstallingUpdate,
    DevBuildWithProductionId,
    CannotDeleteRuntimeAndModel,
    UpdateBusy,
    SwitchingModel,
    DeletionInProgress,
    AsrNotResponding,
    AsrIsStopped,
    ModelLoading,
    SetupIncomplete,
    /// 選択を保存できず元のモデルに戻した
    ModelSelectionNotSaved {
        prev: String,
    },
    /// 新しいモデルを読み込めず元のモデルに戻した
    ModelLoadFailed {
        next: String,
        prev: String,
    },
    // macOS のアンインストールでだけ使う
    #[cfg_attr(target_os = "windows", allow(dead_code))]
    UninstallIncomplete(Vec<UninstallPart>),
    #[cfg_attr(target_os = "windows", allow(dead_code))]
    AppBundleUnknown,
    #[cfg_attr(target_os = "windows", allow(dead_code))]
    AppTranslocated,
    /// Windows: 実行ファイルの隣に uninstall.exe が無い (NSIS で入れたものでない)
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    UninstallerMissing,
    /// Windows: uninstall.exe を起動できない
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    UninstallerLaunchFailed,
    /// 想定外の失敗 (詳細はログ)
    Internal,
    OpenSystemSettingsFailed,
    OpenLogsFailed,
    OpenSettingsFailed,
    OpenSetupFailed,
    PanelFailed,
    ListDevicesFailed,

    // ---- モデルの管理 ----
    UnknownModel,
    RemovingModel,
    OtherModelDownloading,
    ModelNotDownloaded,
    ModelInUse,
    ModelDownloadingCannotDelete,
    ModelAlreadyDownloaded,
    CannotDeleteModel,
    CannotSaveModelSelection,
    ModelName(ModelText),
    ModelDescription(ModelText),

    // ---- セットアップ・モデルの取得の失敗 (ProvisioningStatus.error・ModelInfo.error) ----
    FetchNetwork,
    FetchListHttp {
        status: u16,
    },
    ModelInfoInvalid,
    FetchInterrupted,
    FetchHttp {
        status: u16,
    },
    ModelCorrupted,
    ModelSaveFailed,
    DiskFull,
    // Mac の実行環境 (uv) の導入でだけ使う
    #[cfg_attr(target_os = "windows", allow(dead_code))]
    UvLaunchFailed,
    #[cfg_attr(target_os = "windows", allow(dead_code))]
    RuntimeInstallFailed,
    #[cfg_attr(target_os = "windows", allow(dead_code))]
    UvMissing,
    #[cfg_attr(target_os = "windows", allow(dead_code))]
    AsrServerFilesFailed,
    VerifyFailed,
    VerifyAudioMissing,
    SetupSaveFailed,
    // ---- Windows の文字起こしエンジン (llama-server) の導入 ----
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    GpuConsentRequired,
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    LlamaServerMissing,
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    LlamaServerBroken,
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    CpuRuntimeFailed,

    // ---- 設定 ----
    SettingsUnknownKey {
        key: String,
    },
    SettingsInvalidValue {
        key: String,
    },
    SettingsInvalidType,
    SettingsSaveFailed,
    AsrContextTooLong {
        max: usize,
    },
    VoiceCommandNoPhrase,
    VoiceCommandSymbolsOnly {
        phrase: String,
    },
    VoiceCommandDuplicate {
        phrase: String,
        other: String,
    },
    ShortcutEmpty,
    ShortcutNeedsModifier {
        shortcut: String,
    },
    ShortcutInvalidModifier {
        shortcut: String,
    },
    ShortcutModifierOrder {
        shortcut: String,
    },
    ShortcutUnparsable {
        shortcut: String,
    },
    ShortcutUnsupportedKey {
        key: String,
    },
    /// `shortcut` は表示用 (shortcut::display)
    ShortcutRegisterFailed {
        shortcut: String,
    },
    /// macOS のみ (SMAppService は macOS 13 から)
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    LoginItemNeedsMacos13,
    /// 文言は OS ごと (Mac: システム設定のログイン項目 / Windows: 設定のスタートアップ)
    LoginItemNotApproved,
    LoginItemEnableFailed,
    LoginItemDisableFailed,

    // ---- アップデート (UpdateStatus.error・reject) ----
    UpdateDevBuild,
    UpdateLocationUnknown,
    UpdateMoveToApplications,
    UpdateCheckFailed,
    UpdateDownloadFailed,
    UpdateDevNoInstall,
    UpdateChecking,
    UpdateInstallFailed,
    UpdateNotInstallable,
}

impl Msg {
    /// 指定した言語の文字列
    pub fn text(&self, l: Locale) -> String {
        match l {
            Locale::Ja => ja::text(self),
            Locale::En => en::text(self),
        }
    }
}

/// 表示した時点の表示言語 (`current`) で文字列にする
impl std::fmt::Display for Msg {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.text(current()))
    }
}

/// `anyhow` のエラーに入れ、呼び出し元で `downcast_ref::<Msg>` で取り出せるようにする
impl std::error::Error for Msg {}

/// 送る時点の表示言語の文字列にする (状態に持った文言が表示言語の変更に追従するように)
impl Serialize for Msg {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_str(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preferred_languages_resolve_to_first_supported() {
        let r = |v: &[&str]| locale_from_preferred(v.iter().copied());
        assert_eq!(r(&["ja-JP", "en-US"]), Locale::Ja);
        assert_eq!(r(&["en-JP", "ja-JP"]), Locale::En);
        assert_eq!(r(&["en"]), Locale::En);
        assert_eq!(r(&["JA"]), Locale::Ja);
        assert_eq!(r(&["ja_JP"]), Locale::Ja);
        // 先頭が未対応なら次の対応言語
        assert_eq!(r(&["fr-FR", "ja-JP"]), Locale::Ja);
        assert_eq!(r(&["zh-Hans-CN", "en-GB"]), Locale::En);
        // どれも対応していなければ en
        assert_eq!(r(&["fr-FR", "de"]), Locale::En);
        assert_eq!(r(&[]), Locale::En);
        // "jav" (ジャワ語) 等を ja と誤らない
        assert_eq!(r(&["jv-ID"]), Locale::En);
    }

    #[test]
    fn ui_language_resolves_and_reads_leniently() {
        assert_eq!(UiLanguage::System.resolve(Locale::En), Locale::En);
        assert_eq!(UiLanguage::System.resolve(Locale::Ja), Locale::Ja);
        assert_eq!(UiLanguage::Ja.resolve(Locale::En), Locale::Ja);
        assert_eq!(UiLanguage::En.resolve(Locale::Ja), Locale::En);
        let read = |v: serde_json::Value| serde_json::from_value::<UiLanguage>(v).unwrap();
        assert_eq!(read(serde_json::json!("en")), UiLanguage::En);
        assert_eq!(read(serde_json::json!("fr")), UiLanguage::System);
        assert_eq!(read(serde_json::json!(null)), UiLanguage::System);
        assert_eq!(read(serde_json::json!(1)), UiLanguage::System);
        assert_eq!(
            serde_json::to_value(UiLanguage::System).unwrap(),
            serde_json::json!("system")
        );
        assert_eq!(
            serde_json::to_value(Locale::En).unwrap(),
            serde_json::json!("en")
        );
        assert_eq!(Locale::Ja.asr_language(), "Japanese");
        assert_eq!(Locale::En.asr_language(), "English");
    }

    /// 全ての文言の見本。`index` の `match` で網羅を型で強制し (variant を足すとコンパイルが落ちる)、
    /// 見本が全ての index を含むことをテストで確かめる
    fn samples() -> Vec<Msg> {
        use Msg::*;
        let s = |v: &str| v.to_string();
        let mut v = vec![
            ErrAccessibilityDenied,
            ErrMicrophoneDenied,
            ErrMicrophoneMissing,
            ErrAsrStopped,
            ErrRuntimeMissing,
            ErrVadFailed,
            ErrInsertFailed,
            ErrInsertElevated,
            MenuLoading(None),
            MenuLoading(Some(42)),
            MenuOffReady,
            MenuListening,
            MenuError,
            MenuOpenSystemSettings,
            MenuSelectMicrophone,
            MenuRestartAsr,
            MenuOpenSetup,
            MenuTurnOn,
            MenuTurnOff,
            MenuCompact,
            MenuRestartToUpdate {
                version: s("9.8.7"),
            },
            MenuSettings,
            MenuQuit,
            WindowSettings,
            WindowSetup,
            AppMenuAbout,
            AppMenuServices,
            AppMenuHide,
            AppMenuHideOthers,
            AppMenuShowAll,
            AppMenuFile,
            AppMenuCloseWindow,
            AppMenuEdit,
            AppMenuUndo,
            AppMenuRedo,
            AppMenuCut,
            AppMenuCopy,
            AppMenuPaste,
            AppMenuSelectAll,
            AppMenuWindow,
            AppMenuMinimize,
            AppMenuZoom,
            AppMenuHelp,
            InstallingUpdate,
            DevBuildWithProductionId,
            CannotDeleteRuntimeAndModel,
            UpdateBusy,
            SwitchingModel,
            DeletionInProgress,
            AsrNotResponding,
            AsrIsStopped,
            ModelLoading,
            SetupIncomplete,
            ModelSelectionNotSaved {
                prev: s("PrevModel"),
            },
            ModelLoadFailed {
                next: s("NextModel"),
                prev: s("PrevModel"),
            },
            UninstallIncomplete(vec![
                UninstallPart::LoginItem,
                UninstallPart::Data,
                UninstallPart::Preferences,
                UninstallPart::Permissions,
                UninstallPart::AppBundle,
            ]),
            AppBundleUnknown,
            AppTranslocated,
            UninstallerMissing,
            UninstallerLaunchFailed,
            Internal,
            OpenSystemSettingsFailed,
            OpenLogsFailed,
            OpenSettingsFailed,
            OpenSetupFailed,
            PanelFailed,
            ListDevicesFailed,
            UnknownModel,
            RemovingModel,
            OtherModelDownloading,
            ModelNotDownloaded,
            ModelInUse,
            ModelDownloadingCannotDelete,
            ModelAlreadyDownloaded,
            CannotDeleteModel,
            CannotSaveModelSelection,
            FetchNetwork,
            FetchListHttp { status: 404 },
            ModelInfoInvalid,
            FetchInterrupted,
            FetchHttp { status: 503 },
            ModelCorrupted,
            ModelSaveFailed,
            DiskFull,
            UvLaunchFailed,
            RuntimeInstallFailed,
            UvMissing,
            AsrServerFilesFailed,
            VerifyFailed,
            VerifyAudioMissing,
            SetupSaveFailed,
            SettingsUnknownKey { key: s("someKey") },
            SettingsInvalidValue { key: s("someKey") },
            SettingsInvalidType,
            SettingsSaveFailed,
            AsrContextTooLong { max: 1000 },
            VoiceCommandNoPhrase,
            VoiceCommandSymbolsOnly { phrase: s("!?") },
            VoiceCommandDuplicate {
                phrase: s("PhraseA"),
                other: s("PhraseB"),
            },
            ShortcutEmpty,
            ShortcutNeedsModifier {
                shortcut: s("Space"),
            },
            ShortcutInvalidModifier {
                shortcut: s("Foo+Space"),
            },
            ShortcutModifierOrder {
                shortcut: s("Shift+Alt+Space"),
            },
            ShortcutUnparsable {
                shortcut: s("Alt+Foo"),
            },
            ShortcutUnsupportedKey { key: s("CapsLock") },
            ShortcutRegisterFailed {
                shortcut: s("⌥ Space"),
            },
            LoginItemNeedsMacos13,
            LoginItemNotApproved,
            LoginItemEnableFailed,
            LoginItemDisableFailed,
            UpdateDevBuild,
            UpdateLocationUnknown,
            UpdateMoveToApplications,
            UpdateCheckFailed,
            UpdateDownloadFailed,
            UpdateDevNoInstall,
            UpdateChecking,
            UpdateInstallFailed,
            UpdateNotInstallable,
            ErrGpuUnavailable,
            MenuAcceptCpu,
            MenuProbeGpu,
            GpuConsentRequired,
            LlamaServerMissing,
            LlamaServerBroken,
            CpuRuntimeFailed,
        ];
        for t in [
            ModelText::Ja8bit,
            ModelText::Base17b8bit,
            ModelText::JaBf16,
            ModelText::JaGguf,
            ModelText::BaseGguf,
        ] {
            v.push(ModelName(t));
            v.push(ModelDescription(t));
        }
        v
    }

    /// 見本の網羅の確認用。variant を足すとここがコンパイルエラーになる (`_ =>` を書かない)
    fn index(m: &Msg) -> usize {
        use Msg::*;
        match m {
            ErrAccessibilityDenied => 0,
            ErrMicrophoneDenied => 1,
            ErrMicrophoneMissing => 2,
            ErrAsrStopped => 3,
            ErrRuntimeMissing => 4,
            ErrVadFailed => 5,
            ErrInsertFailed => 6,
            MenuLoading(_) => 7,
            MenuOffReady => 8,
            MenuListening => 9,
            MenuError => 10,
            MenuOpenSystemSettings => 11,
            MenuSelectMicrophone => 12,
            MenuRestartAsr => 13,
            MenuOpenSetup => 14,
            MenuTurnOn => 15,
            MenuTurnOff => 16,
            MenuCompact => 17,
            MenuRestartToUpdate { .. } => 18,
            MenuSettings => 19,
            MenuQuit => 20,
            WindowSettings => 21,
            WindowSetup => 22,
            InstallingUpdate => 23,
            DevBuildWithProductionId => 24,
            CannotDeleteRuntimeAndModel => 25,
            UpdateBusy => 26,
            SwitchingModel => 27,
            DeletionInProgress => 28,
            AsrNotResponding => 29,
            AsrIsStopped => 30,
            ModelLoading => 31,
            SetupIncomplete => 32,
            ModelSelectionNotSaved { .. } => 33,
            ModelLoadFailed { .. } => 34,
            UninstallIncomplete(_) => 35,
            AppBundleUnknown => 36,
            AppTranslocated => 37,
            Internal => 38,
            OpenSystemSettingsFailed => 39,
            OpenLogsFailed => 40,
            OpenSettingsFailed => 41,
            OpenSetupFailed => 42,
            PanelFailed => 43,
            ListDevicesFailed => 44,
            UnknownModel => 45,
            RemovingModel => 46,
            OtherModelDownloading => 47,
            ModelNotDownloaded => 48,
            ModelInUse => 49,
            ModelDownloadingCannotDelete => 50,
            ModelAlreadyDownloaded => 51,
            CannotDeleteModel => 52,
            CannotSaveModelSelection => 53,
            ModelName(_) => 54,
            ModelDescription(_) => 55,
            FetchNetwork => 56,
            FetchListHttp { .. } => 57,
            ModelInfoInvalid => 58,
            FetchInterrupted => 59,
            FetchHttp { .. } => 60,
            ModelCorrupted => 61,
            ModelSaveFailed => 62,
            DiskFull => 63,
            UvLaunchFailed => 64,
            RuntimeInstallFailed => 65,
            UvMissing => 66,
            AsrServerFilesFailed => 67,
            VerifyFailed => 68,
            VerifyAudioMissing => 69,
            SetupSaveFailed => 70,
            SettingsUnknownKey { .. } => 71,
            SettingsInvalidValue { .. } => 72,
            SettingsInvalidType => 73,
            SettingsSaveFailed => 74,
            AsrContextTooLong { .. } => 75,
            VoiceCommandNoPhrase => 76,
            VoiceCommandSymbolsOnly { .. } => 77,
            VoiceCommandDuplicate { .. } => 78,
            ShortcutEmpty => 79,
            ShortcutNeedsModifier { .. } => 80,
            ShortcutInvalidModifier { .. } => 81,
            ShortcutModifierOrder { .. } => 82,
            ShortcutUnparsable { .. } => 83,
            ShortcutUnsupportedKey { .. } => 84,
            ShortcutRegisterFailed { .. } => 85,
            LoginItemNeedsMacos13 => 86,
            LoginItemNotApproved => 87,
            LoginItemEnableFailed => 88,
            LoginItemDisableFailed => 89,
            UpdateDevBuild => 90,
            UpdateLocationUnknown => 91,
            UpdateMoveToApplications => 92,
            UpdateCheckFailed => 93,
            UpdateDownloadFailed => 94,
            UpdateDevNoInstall => 95,
            UpdateChecking => 96,
            UpdateInstallFailed => 97,
            UpdateNotInstallable => 98,
            AppMenuAbout => 99,
            AppMenuServices => 100,
            AppMenuHide => 101,
            AppMenuHideOthers => 102,
            AppMenuShowAll => 103,
            AppMenuFile => 104,
            AppMenuCloseWindow => 105,
            AppMenuEdit => 106,
            AppMenuUndo => 107,
            AppMenuRedo => 108,
            AppMenuCut => 109,
            AppMenuCopy => 110,
            AppMenuPaste => 111,
            AppMenuSelectAll => 112,
            AppMenuWindow => 113,
            AppMenuMinimize => 114,
            AppMenuZoom => 115,
            AppMenuHelp => 116,
            ErrGpuUnavailable => 117,
            MenuAcceptCpu => 118,
            MenuProbeGpu => 119,
            GpuConsentRequired => 120,
            LlamaServerMissing => 121,
            LlamaServerBroken => 122,
            CpuRuntimeFailed => 123,
            ErrInsertElevated => 124,
            UninstallerMissing => 125,
            UninstallerLaunchFailed => 126,
        }
    }
    const VARIANTS: usize = 127;

    fn has_japanese(s: &str) -> bool {
        s.chars().any(|c| {
            matches!(c,
                '\u{3040}'..='\u{30FF}' // ひらがな・カタカナ
                | '\u{4E00}'..='\u{9FFF}' // 漢字
                | '\u{3000}'..='\u{303F}' // 、。「」 等
                | '\u{FF01}'..='\u{FF5E}') // 全角英数・記号
        })
    }

    #[test]
    fn every_message_has_every_locale() {
        let samples = samples();
        let mut covered = [false; VARIANTS];
        for m in &samples {
            covered[index(m)] = true;
        }
        let missing: Vec<usize> = (0..VARIANTS).filter(|i| !covered[*i]).collect();
        assert!(missing.is_empty(), "見本に無い文言 (index): {missing:?}");

        for m in &samples {
            for l in Locale::ALL {
                let t = m.text(l);
                assert!(!t.trim().is_empty(), "{m:?} ({l:?}) が空");
                assert_eq!(t, t.trim(), "{m:?} ({l:?}) の前後に空白");
            }
            let en = m.text(Locale::En);
            // 英語の辞書に日本語を置いたまま (訳し忘れ) にしない。差し込む値は ASCII の見本にしている
            assert!(!has_japanese(&en), "{m:?} の英語に日本語: {en}");
        }
    }

    #[test]
    fn values_are_embedded_in_every_locale() {
        let check = |m: Msg, values: &[&str]| {
            for l in Locale::ALL {
                let t = m.text(l);
                for v in values {
                    assert!(t.contains(v), "{m:?} ({l:?}) に {v} がない: {t}");
                }
            }
        };
        check(
            Msg::MenuRestartToUpdate {
                version: "9.8.7".into(),
            },
            &["v9.8.7"],
        );
        check(Msg::MenuLoading(Some(42)), &["42%"]);
        check(
            Msg::ModelLoadFailed {
                next: "NextModel".into(),
                prev: "PrevModel".into(),
            },
            &["NextModel", "PrevModel"],
        );
        check(
            Msg::ModelSelectionNotSaved {
                prev: "PrevModel".into(),
            },
            &["PrevModel"],
        );
        check(Msg::AsrContextTooLong { max: 1000 }, &["1000"]);
        check(
            Msg::VoiceCommandDuplicate {
                phrase: "PhraseA".into(),
                other: "PhraseB".into(),
            },
            &["PhraseA", "PhraseB"],
        );
        check(Msg::FetchHttp { status: 503 }, &["503"]);
        check(Msg::FetchListHttp { status: 404 }, &["404"]);
        check(
            Msg::ShortcutRegisterFailed {
                shortcut: "⌥ Space".into(),
            },
            &["⌥ Space"],
        );
        check(
            Msg::SettingsUnknownKey {
                key: "someKey".into(),
            },
            &["someKey"],
        );
    }

    #[test]
    fn display_and_serialize_use_current_locale() {
        // テストでは表示言語を変えないため既定の ja
        assert_eq!(current(), Locale::Ja);
        let m = Msg::ErrInsertFailed;
        assert_eq!(m.to_string(), m.text(Locale::Ja));
        assert_eq!(
            serde_json::to_value(&m).unwrap(),
            serde_json::json!(m.text(Locale::Ja))
        );
        // anyhow に入れても取り出せる
        let e = anyhow::anyhow!(Msg::UnknownModel);
        assert_eq!(e.downcast_ref::<Msg>(), Some(&Msg::UnknownModel));
        assert_eq!(e.to_string(), Msg::UnknownModel.text(Locale::Ja));
    }

    #[test]
    fn known_texts() {
        assert_eq!(Msg::MenuSettings.text(Locale::En), "Settings…");
        assert_eq!(Msg::MenuQuit.text(Locale::En), "Quit mukuchi");
        assert_eq!(Msg::MenuSettings.text(Locale::Ja), "設定を開く…");
        assert_eq!(
            Msg::UninstallIncomplete(vec![UninstallPart::Data, UninstallPart::AppBundle])
                .text(Locale::Ja),
            "削除できないものがあります: データ・アプリ本体"
        );
        assert_eq!(
            Msg::UninstallIncomplete(vec![UninstallPart::Data, UninstallPart::AppBundle])
                .text(Locale::En),
            "Some items couldn’t be deleted: data, the app"
        );
    }
}
