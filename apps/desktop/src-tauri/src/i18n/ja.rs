//! 日本語の辞書。`_ =>` を書かない (キーの欠落をコンパイルで落とすため)

use super::{ModelText, Msg, UninstallPart};

pub(super) fn text(m: &Msg) -> String {
    use Msg::*;
    let s = |v: &str| v.to_string();
    match m {
        ErrAccessibilityDenied => s("アクセシビリティが許可されていないため入力できません"),
        ErrMicrophoneDenied => s("マイクが許可されていません"),
        ErrMicrophoneMissing => s("マイクが見つかりません"),
        ErrAsrStopped => s("文字起こしサーバーが停止しました"),
        ErrRuntimeMissing => s("実行環境とモデルが導入されていません"),
        ErrVadFailed => s("発話検出を開始できません"),
        ErrInsertFailed => s("入力に失敗しました"),
        ErrInsertElevated => s("管理者として実行中のアプリには入力できません"),
        ErrGpuUnavailable => s("GPU を使えないため文字起こしを開始できません"),

        MenuLoading(Some(p)) => format!("モデルを読み込んでいます… {p}%"),
        MenuLoading(None) => s("モデルを読み込んでいます…"),
        MenuOffReady => s("オフ・モデル読み込み済み"),
        MenuListening => s("聞いています"),
        MenuError => s("エラー"),
        // Windows の「設定」はアプリの設定 (MenuSettings) と紛れるため Windows を付ける
        MenuOpenSystemSettings if cfg!(target_os = "windows") => s("Windows の設定を開く…"),
        MenuOpenSystemSettings => s("システム設定を開く…"),
        MenuSelectMicrophone => s("マイクを選択…"),
        MenuRestartAsr => s("文字起こしサーバーを再起動"),
        MenuAcceptCpu => s("CPU で続ける…"),
        MenuProbeGpu => s("GPU を再検出"),
        MenuOpenSetup => s("セットアップを開く…"),
        MenuTurnOn => s("音声入力をオン"),
        MenuTurnOff => s("音声入力をオフ"),
        MenuCompact => s("コンパクト表示"),
        MenuRestartToUpdate { version } => format!("再起動してアップデート (v{version})"),
        MenuSettings => s("設定を開く…"),
        MenuQuit => s("mukuchi を終了"),

        AppMenuAbout => s("mukuchi について"),
        AppMenuServices => s("サービス"),
        AppMenuHide => s("mukuchi を隠す"),
        AppMenuHideOthers => s("ほかを隠す"),
        AppMenuShowAll => s("すべてを表示"),
        AppMenuFile => s("ファイル"),
        AppMenuCloseWindow => s("ウインドウを閉じる"),
        AppMenuEdit => s("編集"),
        AppMenuUndo => s("取り消す"),
        AppMenuRedo => s("やり直す"),
        AppMenuCut => s("カット"),
        AppMenuCopy => s("コピー"),
        AppMenuPaste => s("ペースト"),
        AppMenuSelectAll => s("すべてを選択"),
        AppMenuWindow => s("ウインドウ"),
        AppMenuMinimize => s("しまう"),
        AppMenuZoom => s("拡大/縮小"),
        AppMenuHelp => s("ヘルプ"),
        WindowSettings => s("mukuchi 設定"),
        WindowSetup => s("mukuchi セットアップ"),

        InstallingUpdate => s("アップデートをインストールしています"),
        DevBuildWithProductionId => {
            s("開発ビルドを本番のバンドルIDで実行しているため削除しません")
        }
        CannotDeleteRuntimeAndModel => s("実行環境とモデルを削除できません"),
        UpdateBusy => s("ダウンロード・削除の実行中は更新できません"),
        SwitchingModel => s("モデルを切り替え中です"),
        DeletionInProgress => s("削除を実行中です"),
        AsrNotResponding => s("文字起こしサーバーが応答しません"),
        AsrIsStopped => s("文字起こしサーバーが停止しています"),
        ModelLoading => s("モデルを読み込んでいます。しばらくお待ちください"),
        SetupIncomplete => s("セットアップが完了していません"),
        ModelSelectionNotSaved { prev } => {
            format!("モデルの選択を保存できません。「{prev}」に戻しました")
        }
        ModelLoadFailed { next, prev } => {
            format!("「{next}」を読み込めませんでした。「{prev}」に戻しました")
        }
        UninstallIncomplete(parts) => {
            let names: Vec<&str> = parts.iter().map(|p| part(*p)).collect();
            format!("削除できないものがあります: {}", names.join("・"))
        }
        AppBundleUnknown => s("アプリ本体の場所が分からないため、アンインストールできません"),
        UninstallerMissing => s("アンインストーラーが見つからないため、アンインストールできません。Windows の設定 > アプリ > インストールされているアプリ から mukuchi をアンインストールしてください"),
        UninstallerLaunchFailed => s("アンインストーラーを起動できません"),
        AppTranslocated => s("アプリが一時的な場所から実行されています。mukuchi を「アプリケーション」フォルダに移動して開き直してから、もう一度アンインストールしてください"),
        Internal => s("内部エラーが発生しました"),
        OpenSystemSettingsFailed => s("システム設定を開けません"),
        OpenLogsFailed => s("ログのフォルダを開けません"),
        OpenSettingsFailed => s("設定を開けません"),
        OpenSetupFailed => s("セットアップを開けません"),
        PanelFailed => s("パネルを表示できません"),
        ListDevicesFailed => s("マイクの一覧を取得できません"),

        UnknownModel => s("不明なモデルです"),
        RemovingModel => s("モデルを削除しています"),
        OtherModelDownloading => s("他のモデルをダウンロード中です"),
        ModelNotDownloaded => s("ダウンロードが済んでいないモデルは選べません"),
        ModelInUse => s("使用中のモデルは削除できません"),
        ModelDownloadingCannotDelete => {
            s("ダウンロード中のモデルは削除できません。中止してください")
        }
        ModelAlreadyDownloaded => s("ダウンロード済みです"),
        CannotDeleteModel => s("モデルを削除できません"),
        CannotSaveModelSelection => s("モデルの選択を保存できません"),
        ModelName(t) => s(match t {
            ModelText::Ja8bit => "日本語 (8bit)",
            ModelText::Base17b8bit => "標準 (8bit)",
            ModelText::JaBf16 => "日本語 (bf16)",
            ModelText::JaGguf => "日本語 (8bit)",
            ModelText::BaseGguf => "標準 (8bit)",
        }),
        ModelDescription(t) => s(match t {
            ModelText::Ja8bit => {
                "日本語向けに追加学習したモデル。英語も認識できる。メモリの使用量は約3GB"
            }
            ModelText::Base17b8bit => {
                "追加学習をしていない元のモデル。英語に向く。メモリの使用量は約3GB"
            }
            ModelText::JaBf16 => {
                "量子化していない元のモデル。容量とメモリの使用量 (約8.5GB) が大きい"
            }
            ModelText::JaGguf => "日本語向けに追加学習したモデル。英語も認識できる",
            ModelText::BaseGguf => "追加学習をしていない元のモデル。英語に向く",
        }),

        FetchNetwork => {
            s("モデルを取得できません。ネットワーク接続を確認して再試行してください")
        }
        FetchListHttp { status } => format!("モデルの一覧を取得できません (HTTP {status})"),
        ModelInfoInvalid => s("モデルの情報が不正です"),
        FetchInterrupted => s(
            "モデルの取得が中断されました。ネットワーク接続を確認して再試行してください",
        ),
        FetchHttp { status } => format!("モデルを取得できません (HTTP {status})"),
        ModelCorrupted => s("ダウンロードしたモデルが壊れています。再試行してください"),
        ModelSaveFailed => s("モデルを保存できません"),
        DiskFull => s("ディスクの空き容量が足りません"),
        UvLaunchFailed => s("実行環境の導入ツール (uv) を起動できません"),
        RuntimeInstallFailed => {
            s("実行環境の導入に失敗しました。ネットワーク接続を確認して再試行してください")
        }
        UvMissing => s("実行環境の導入ツール (uv) が見つかりません。アプリを入れ直してください"),
        AsrServerFilesFailed => {
            s("文字起こしサーバーの同梱ファイルを展開できません。アプリを入れ直してください")
        }
        VerifyFailed => s("文字起こしの動作確認に失敗しました。再試行してください"),
        VerifyAudioMissing => s("検証用の音声が見つかりません。アプリを入れ直してください"),
        GpuConsentRequired => {
            s("GPU が見つかりません。CPU で続けるには、CPU での実行に同意してください")
        }
        LlamaServerMissing => s(
            "文字起こしエンジン (llama-server) が見つかりません。アプリを入れ直してください",
        ),
        LlamaServerBroken => s("文字起こしエンジンを起動できません。アプリを入れ直してください"),
        CpuRuntimeFailed => s(
            "CPU 版の文字起こしエンジンを導入できません。ネットワーク接続を確認して再試行してください",
        ),
        SetupSaveFailed => s("セットアップの状態を保存できません"),

        SettingsUnknownKey { key } => format!("未知の設定キー: {key}"),
        SettingsInvalidValue { key } => format!("{key} が不正です"),
        SettingsInvalidType => s("設定の値の型が正しくありません"),
        SettingsSaveFailed => s("設定を保存できません"),
        AsrContextTooLong { max } => format!("認識のヒントは{max}文字以内にしてください"),
        VoiceCommandNoPhrase => s("言い方が入力されていない音声コマンドがあります"),
        VoiceCommandSymbolsOnly { phrase } => {
            format!("「{phrase}」は記号や空白だけのため言い方に使えません")
        }
        VoiceCommandDuplicate { phrase, other } => {
            format!("言い方「{phrase}」が「{other}」と重複しています")
        }
        ShortcutEmpty => s("ショートカットが空です"),
        ShortcutNeedsModifier { shortcut } => format!(
            "ショートカットには修飾キー (Ctrl・Alt・Shift・Cmd) が1つ以上必要です: {shortcut}"
        ),
        ShortcutInvalidModifier { shortcut } => {
            format!("ショートカットの修飾キーが不正です: {shortcut}")
        }
        ShortcutModifierOrder { shortcut } => format!(
            "ショートカットの修飾キーは Ctrl・Alt・Shift・Cmd の順に1回ずつ指定します: {shortcut}"
        ),
        ShortcutUnparsable { shortcut } => format!("ショートカットを解釈できません: {shortcut}"),
        ShortcutUnsupportedKey { key } => format!("ショートカットのキーに使えません: {key}"),
        ShortcutRegisterFailed { shortcut } => format!(
            "ショートカット「{shortcut}」を登録できませんでした。別のキーに変更してください"
        ),
        LoginItemNeedsMacos13 => s("ログイン時の起動には macOS 13 以降が必要です"),
        LoginItemNotApproved if cfg!(target_os = "windows") => s("スタートアップで無効になっています。設定の「アプリ > スタートアップ」で mukuchi をオンにしてください"),
        LoginItemNotApproved => s("ログイン項目が許可されていません。システム設定の「一般 > ログイン項目」で mukuchi をオンにしてください"),
        LoginItemEnableFailed => s("ログイン時の起動を設定できません"),
        LoginItemDisableFailed => s("ログイン時の起動を解除できません"),

        UpdateDevBuild => s("開発ビルドではアップデートしません"),
        UpdateLocationUnknown => s("アプリの場所が分からないため自動でアップデートできません"),
        UpdateMoveToApplications => {
            s("アプリケーションフォルダに移動すると自動でアップデートできます")
        }
        UpdateCheckFailed => s("アップデートを確認できませんでした"),
        UpdateDownloadFailed => s("アップデートをダウンロードできませんでした"),
        UpdateDevNoInstall => s("開発ビルドではインストールしません"),
        UpdateChecking => {
            s("アップデートを確認しています。しばらくしてからもう一度お試しください")
        }
        UpdateInstallFailed => s("アップデートをインストールできませんでした"),
        UpdateNotInstallable => s("インストールできるアップデートがありません"),
    }
}

fn part(p: UninstallPart) -> &'static str {
    match p {
        UninstallPart::LoginItem => "ログイン項目",
        UninstallPart::Data => "データ",
        UninstallPart::Preferences => "設定",
        UninstallPart::Permissions => "権限の設定",
        UninstallPart::AppBundle => "アプリ本体",
    }
}
