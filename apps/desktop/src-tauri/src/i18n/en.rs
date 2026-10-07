//! English dictionary. `_ =>` を書かない (キーの欠落をコンパイルで落とすため)。
//! 用語は Apple の HIG・macOS の表記に合わせる (Settings…, Quit <app>, System Settings 等)

use super::{ModelText, Msg, UninstallPart};

pub(super) fn text(m: &Msg) -> String {
    use Msg::*;
    let s = |v: &str| v.to_string();
    match m {
        ErrAccessibilityDenied => s("Can’t type text without Accessibility access"),
        ErrMicrophoneDenied => s("Microphone access isn’t allowed"),
        ErrMicrophoneMissing => s("No microphone found"),
        ErrAsrStopped => s("The transcription server stopped"),
        ErrRuntimeMissing => s("The runtime and model aren’t installed"),
        ErrVadFailed => s("Can’t start speech detection"),
        ErrInsertFailed => s("Couldn’t type the text"),

        MenuLoading(Some(p)) => format!("Loading Model… {p}%"),
        MenuLoading(None) => s("Loading Model…"),
        MenuOffReady => s("Off · Model Loaded"),
        MenuListening => s("Listening"),
        MenuError => s("Error"),
        MenuOpenSystemSettings => s("Open System Settings…"),
        MenuSelectMicrophone => s("Choose Microphone…"),
        MenuRestartAsr => s("Restart Transcription Server"),
        MenuOpenSetup => s("Open Setup…"),
        MenuTurnOn => s("Turn On Voice Input"),
        MenuTurnOff => s("Turn Off Voice Input"),
        MenuCompact => s("Compact View"),
        MenuRestartToUpdate { version } => format!("Restart to Update (v{version})"),
        MenuSettings => s("Settings…"),
        MenuQuit => s("Quit mukuchi"),

        AppMenuAbout => s("About mukuchi"),
        AppMenuServices => s("Services"),
        AppMenuHide => s("Hide mukuchi"),
        AppMenuHideOthers => s("Hide Others"),
        AppMenuShowAll => s("Show All"),
        AppMenuFile => s("File"),
        AppMenuCloseWindow => s("Close Window"),
        AppMenuEdit => s("Edit"),
        AppMenuUndo => s("Undo"),
        AppMenuRedo => s("Redo"),
        AppMenuCut => s("Cut"),
        AppMenuCopy => s("Copy"),
        AppMenuPaste => s("Paste"),
        AppMenuSelectAll => s("Select All"),
        AppMenuWindow => s("Window"),
        AppMenuMinimize => s("Minimize"),
        AppMenuZoom => s("Zoom"),
        AppMenuHelp => s("Help"),
        WindowSettings => s("mukuchi Settings"),
        WindowSetup => s("mukuchi Setup"),

        InstallingUpdate => s("Installing an update"),
        DevBuildWithProductionId => {
            s("Not deleted because this development build is using the production bundle ID")
        }
        CannotDeleteRuntimeAndModel => s("Couldn’t delete the runtime and models"),
        UpdateBusy => s("Can’t update while a download or deletion is in progress"),
        SwitchingModel => s("Switching models"),
        DeletionInProgress => s("Deletion in progress"),
        AsrNotResponding => s("The transcription server isn’t responding"),
        AsrIsStopped => s("The transcription server is stopped"),
        ModelLoading => s("Loading the model. Please wait."),
        SetupIncomplete => s("Setup isn’t complete"),
        ModelSelectionNotSaved { prev } => {
            format!("Couldn’t save the model selection. Switched back to “{prev}”.")
        }
        ModelLoadFailed { next, prev } => {
            format!("Couldn’t load “{next}”. Switched back to “{prev}”.")
        }
        UninstallIncomplete(parts) => {
            let names: Vec<&str> = parts.iter().map(|p| part(*p)).collect();
            format!("Some items couldn’t be deleted: {}", names.join(", "))
        }
        AppBundleUnknown => s("Can’t uninstall because the app’s location is unknown"),
        AppTranslocated => s("mukuchi is running from a temporary location. Move it to the Applications folder, open it again, and then uninstall."),
        Internal => s("An internal error occurred"),
        OpenSystemSettingsFailed => s("Couldn’t open System Settings"),
        OpenLogsFailed => s("Couldn’t open the logs folder"),
        OpenSettingsFailed => s("Couldn’t open Settings"),
        OpenSetupFailed => s("Couldn’t open Setup"),
        PanelFailed => s("Couldn’t show the panel"),
        ListDevicesFailed => s("Couldn’t get the list of microphones"),

        UnknownModel => s("Unknown model"),
        RemovingModel => s("Deleting the model"),
        OtherModelDownloading => s("Another model is downloading"),
        ModelNotDownloaded => s("Download the model before selecting it"),
        ModelInUse => s("Can’t delete the model in use"),
        ModelDownloadingCannotDelete => {
            s("Can’t delete a model while it’s downloading. Cancel the download first.")
        }
        ModelAlreadyDownloaded => s("Already downloaded"),
        CannotDeleteModel => s("Couldn’t delete the model"),
        CannotSaveModelSelection => s("Couldn’t save the model selection"),
        ModelName(t) => s(match t {
            ModelText::Ja8bit => "Japanese (8-bit)",
            ModelText::Base17b8bit => "Standard (8-bit)",
            ModelText::JaBf16 => "Japanese (bf16)",
        }),
        ModelDescription(t) => s(match t {
            ModelText::Ja8bit => {
                "Fine-tuned for Japanese. Also recognizes English. Uses about 3 GB of memory."
            }
            ModelText::Base17b8bit => {
                "The original model without additional training. Best for English. Uses about 3 GB of memory."
            }
            ModelText::JaBf16 => {
                "The original unquantized model. Uses more disk space and memory (about 8.5 GB)."
            }
        }),

        FetchNetwork => s("Couldn’t download the model. Check your network connection and try again."),
        FetchListHttp { status } => format!("Couldn’t get the model file list (HTTP {status})"),
        ModelInfoInvalid => s("The model information is invalid"),
        FetchInterrupted => {
            s("The model download was interrupted. Check your network connection and try again.")
        }
        FetchHttp { status } => format!("Couldn’t download the model (HTTP {status})"),
        ModelCorrupted => s("The downloaded model is damaged. Try again."),
        ModelSaveFailed => s("Couldn’t save the model"),
        DiskFull => s("Not enough disk space"),
        UvLaunchFailed => s("Couldn’t start the runtime installer (uv)"),
        RuntimeInstallFailed => {
            s("Couldn’t install the runtime. Check your network connection and try again.")
        }
        UvMissing => s("The runtime installer (uv) is missing. Reinstall the app."),
        AsrServerFilesFailed => {
            s("Couldn’t extract the transcription server files. Reinstall the app.")
        }
        VerifyFailed => s("The transcription test failed. Try again."),
        VerifyAudioMissing => s("The test audio is missing. Reinstall the app."),
        SetupSaveFailed => s("Couldn’t save the setup progress"),

        SettingsUnknownKey { key } => format!("Unknown setting: {key}"),
        SettingsInvalidValue { key } => format!("Invalid value for {key}"),
        SettingsInvalidType => s("A setting has a value of the wrong type"),
        SettingsSaveFailed => s("Couldn’t save settings"),
        AsrContextTooLong { max } => {
            format!("The recognition hint must be {max} characters or fewer")
        }
        VoiceCommandNoPhrase => s("A voice command has no phrases"),
        VoiceCommandSymbolsOnly { phrase } => {
            format!("“{phrase}” can’t be used as a phrase because it contains only symbols or spaces")
        }
        VoiceCommandDuplicate { phrase, other } => {
            format!("The phrase “{phrase}” duplicates “{other}”")
        }
        ShortcutEmpty => s("The shortcut is empty"),
        ShortcutNeedsModifier { shortcut } => format!(
            "A shortcut needs at least one modifier key (Ctrl, Alt, Shift, Cmd): {shortcut}"
        ),
        ShortcutInvalidModifier { shortcut } => {
            format!("The shortcut has an invalid modifier key: {shortcut}")
        }
        ShortcutModifierOrder { shortcut } => format!(
            "Specify each modifier key once, in the order Ctrl, Alt, Shift, Cmd: {shortcut}"
        ),
        ShortcutUnparsable { shortcut } => format!("Can’t read the shortcut: {shortcut}"),
        ShortcutUnsupportedKey { key } => format!("This key can’t be used in a shortcut: {key}"),
        ShortcutRegisterFailed { shortcut } => {
            format!("Couldn’t register the shortcut “{shortcut}”. Choose a different key.")
        }
        LoginItemNeedsMacos13 => s("Opening at login requires macOS 13 or later"),
        LoginItemNotApproved => s("mukuchi isn’t allowed as a login item. Turn it on in System Settings > General > Login Items."),
        LoginItemEnableFailed => s("Couldn’t set mukuchi to open at login"),
        LoginItemDisableFailed => s("Couldn’t stop mukuchi from opening at login"),

        UpdateDevBuild => s("Development builds don’t update"),
        UpdateLocationUnknown => {
            s("Can’t update automatically because the app’s location is unknown")
        }
        UpdateMoveToApplications => {
            s("Move mukuchi to the Applications folder to enable automatic updates")
        }
        UpdateCheckFailed => s("Couldn’t check for updates"),
        UpdateDownloadFailed => s("Couldn’t download the update"),
        UpdateDevNoInstall => s("Development builds don’t install updates"),
        UpdateChecking => s("Checking for updates. Try again in a moment."),
        UpdateInstallFailed => s("Couldn’t install the update"),
        UpdateNotInstallable => s("No update is ready to install"),
    }
}

fn part(p: UninstallPart) -> &'static str {
    match p {
        UninstallPart::LoginItem => "login item",
        UninstallPart::Data => "data",
        UninstallPart::Preferences => "preferences",
        UninstallPart::Permissions => "permissions",
        UninstallPart::AppBundle => "the app",
    }
}
