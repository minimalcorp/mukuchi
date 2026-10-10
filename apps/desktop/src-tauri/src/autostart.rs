//! ログイン時に起動 (settings.launchAtLogin)。
//!
//! `SMAppService.mainAppService` (macOS 13+) でアプリ本体をログイン項目に登録する。
//! tauri-plugin-autostart (auto-launch 0.5) の macOS 実装は `~/Library/LaunchAgents/<名前>.plist` を置く
//! LaunchAgent 方式か、System Events への AppleScript 方式のみで、前者はアプリ外にファイルを残し
//! 後者は自動化の許可ダイアログが出るため使わない。SMAppService の登録はシステムの
//! Background Task Management に記録され、「システム設定 > 一般 > ログイン項目」に表示される。
//!
//! 開発ビルドでは、起動時の取り込み (`reconcile`) とセットアップ完了時の登録をしない
//! (開発中のバイナリを利用者の環境に黙って登録しないため)。設定画面で明示的に切り替えた時だけ登録・解除する。
//!
//! Windows は HKCU の `Software\Microsoft\Windows\CurrentVersion\Run` に実行ファイルを登録する
//! (管理者権限が要らず、「設定 > アプリ > スタートアップ」とタスク マネージャーに出る)。そこで利用者がオフにした状態は
//! `Explorer\StartupApproved\Run` の同じ名前の値に記録されるため、それを「承認待ち」(RequiresApproval) として読む。
//! 取り込み・登録・解除の考え方は Mac と同じ。

use anyhow::bail;
use anyhow::Result;

use crate::i18n::Msg;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
// NotFound・Unsupported は macOS (SMAppService) のみ
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub enum Status {
    NotRegistered,
    Enabled,
    /// 登録済みだが、利用者がシステム設定でオフにした (承認待ち)
    RequiresApproval,
    NotFound,
    /// SMAppService が使えない (macOS 13 未満)
    Unsupported,
}

#[cfg(target_os = "macos")]
fn available() -> bool {
    // macOS 13 未満にはクラスがない。無いクラスへのメッセージ送信で落ちないよう先に確かめる
    objc2::runtime::AnyClass::get(c"SMAppService").is_some()
}

#[cfg(target_os = "macos")]
pub fn status() -> Status {
    use objc2_service_management::{SMAppService, SMAppServiceStatus};
    if !available() {
        return Status::Unsupported;
    }
    // SAFETY: クラスの存在を確認済み。mainAppService/status は引数のないプロパティの読み出し
    let s = unsafe { SMAppService::mainAppService().status() };
    match s {
        SMAppServiceStatus::Enabled => Status::Enabled,
        SMAppServiceStatus::RequiresApproval => Status::RequiresApproval,
        SMAppServiceStatus::NotFound => Status::NotFound,
        _ => Status::NotRegistered,
    }
}

/// ログイン項目に登録・解除する。
///
/// 登録は、呼び出し後の `status` が `Enabled` になった時だけ成功とする。SDK のヘッダ
/// (ServiceManagement.framework/Headers/SMAppService.h, macOS SDK 27.0) によると、利用者が
/// システム設定でオフにした項目の status は `RequiresApproval` で、その状態で register すると
/// `kSMErrorLaunchDeniedByUser` になるか、登録できても実行はされない。登録済みなら
/// `kSMErrorAlreadyRegistered` を返すため、エラーの有無ではなく status で判定する。
/// 承認待ちの項目は解除しない (解除するとシステム設定の一覧から消え、利用者がオンにできなくなるため)
#[cfg(target_os = "macos")]
pub fn set_enabled(enabled: bool) -> Result<()> {
    use objc2_service_management::SMAppService;
    if !available() {
        bail!(Msg::LoginItemNeedsMacos13);
    }
    let action = if enabled { "登録" } else { "解除" };
    // SAFETY: クラスの存在を確認済み。register/unregister は NSError を返す同期 API
    let service = unsafe { SMAppService::mainAppService() };
    let result = if enabled {
        unsafe { service.registerAndReturnError() }
    } else {
        unsafe { service.unregisterAndReturnError() }
    };
    if let Err(e) = &result {
        log::info!(
            "ログイン項目の{action}でエラー: {} (code {})",
            e.localizedDescription(),
            e.code()
        );
    }
    let after = status();
    log::info!("ログイン項目の{action}後の状態: {after:?}");
    match (enabled, after) {
        (true, Status::Enabled) => Ok(()),
        (true, Status::RequiresApproval) => bail!(Msg::LoginItemNotApproved),
        (true, _) => bail!(Msg::LoginItemEnableFailed),
        // 登録されていないものの解除 (kSMErrorJobNotFound) も成功扱い
        (false, Status::NotRegistered | Status::NotFound) => Ok(()),
        (false, _) => bail!(Msg::LoginItemDisableFailed),
    }
}

/// システム設定の「ログイン項目」を開く。
#[cfg(target_os = "macos")]
pub fn open_login_items_settings() -> Result<()> {
    use objc2_service_management::SMAppService;
    if !available() {
        bail!(Msg::LoginItemNeedsMacos13);
    }
    // SAFETY: クラスの存在を確認済み。引数のないクラスメソッド
    unsafe { SMAppService::openSystemSettingsLoginItems() };
    Ok(())
}

/// Windows の登録先 (HKCU)。値の名前は本番と開発ビルドで分ける (開発中のバイナリの登録で本番の登録を上書きしない)。
/// アンインストーラー (NSIS) も同じ名前の値を消す (docs/architecture.md「Windows 版」)
#[cfg(target_os = "windows")]
mod win {
    pub const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    pub const APPROVED: &str =
        r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
    pub const NAME: &str = if cfg!(debug_assertions) {
        "mukuchi-dev"
    } else {
        "mukuchi"
    };

    /// StartupApproved\Run の値 (12 バイト。先頭が状態) が「無効」か。
    /// 先頭バイトの偶数 (02・06 等) は有効、奇数 (03・07 等) は利用者がオフにした状態 (タスク マネージャー・設定)。
    /// 値が無い・読めない時は有効 (登録しただけの状態) とみなす
    pub fn approved_disabled(value: Option<&[u8]>) -> bool {
        value.and_then(|v| v.first()).is_some_and(|b| b & 1 == 1)
    }

    /// Run に書く値 (実行ファイルのパスを引用符で囲む。空白を含むパスのため)
    pub fn command_line(exe: &std::path::Path) -> String {
        format!("\"{}\"", exe.display())
    }
}

#[cfg(target_os = "windows")]
fn is_not_found(e: &windows::core::Error) -> bool {
    e.code() == windows::Win32::Foundation::ERROR_FILE_NOT_FOUND.to_hresult()
}

#[cfg(target_os = "windows")]
pub fn status() -> Status {
    use windows_registry::CURRENT_USER;
    let registered = match CURRENT_USER
        .open(win::RUN)
        .and_then(|k| k.get_string(win::NAME))
    {
        Ok(_) => true,
        Err(e) if is_not_found(&e) => false,
        Err(e) => {
            log::warn!("スタートアップの登録を読めません: {e}");
            false
        }
    };
    if !registered {
        return Status::NotRegistered;
    }
    let approved = CURRENT_USER
        .open(win::APPROVED)
        .and_then(|k| k.get_value(win::NAME))
        .ok();
    if win::approved_disabled(approved.as_deref()) {
        Status::RequiresApproval
    } else {
        Status::Enabled
    }
}

/// スタートアップに登録・解除する。登録は Run に書き、`status` が Enabled になった時だけ成功とする
/// (利用者が設定・タスク マネージャーでオフにしていれば RequiresApproval のまま。その選択はアプリから上書きしない)。
/// 解除は Run と StartupApproved の両方の値を消す (アンインストール後に一覧へ残さないため)
#[cfg(target_os = "windows")]
pub fn set_enabled(enabled: bool) -> Result<()> {
    use windows_registry::CURRENT_USER;
    let action = if enabled { "登録" } else { "解除" };
    let result: windows::core::Result<()> = if enabled {
        std::env::current_exe()
            .map_err(|e| {
                log::warn!("実行ファイルの場所が分かりません: {e}");
                windows::core::Error::from(windows::Win32::Foundation::E_FAIL)
            })
            .and_then(|exe| {
                CURRENT_USER
                    .create(win::RUN)?
                    .set_string(win::NAME, win::command_line(&exe))
            })
    } else {
        let remove = |path: &str| match CURRENT_USER
            .open(path)
            .and_then(|k| k.remove_value(win::NAME))
        {
            Err(e) if !is_not_found(&e) => Err(e),
            _ => Ok(()),
        };
        remove(win::RUN).and(remove(win::APPROVED))
    };
    if let Err(e) = &result {
        log::info!("スタートアップの{action}でエラー: {e}");
    }
    let after = status();
    log::info!("スタートアップの{action}後の状態: {after:?}");
    match (enabled, after) {
        (true, Status::Enabled) => Ok(()),
        (true, Status::RequiresApproval) => bail!(Msg::LoginItemNotApproved),
        (true, _) => bail!(Msg::LoginItemEnableFailed),
        (false, Status::NotRegistered) => Ok(()),
        (false, _) => bail!(Msg::LoginItemDisableFailed),
    }
}

/// 「設定 > アプリ > スタートアップ」を開く
#[cfg(target_os = "windows")]
pub fn open_login_items_settings() -> Result<()> {
    crate::platform::open_url("ms-settings:startupapps")
}

/// 起動時に、システム設定での利用者の変更を設定 (launchAtLogin) に取り込む (本番ビルドのみ)。
///
/// 起動時には登録・解除をしない。launchAtLogin は「利用者がアプリで選び、登録が有効になった」ことを表し
/// (有効にならなければ保存しない)、登録・解除するのは利用者の操作 (設定の切り替え・セットアップ完了) の時だけ。
/// そのため起動時に登録と食い違っていれば、それはアプリの外 (システム設定) での利用者の変更であり、
/// 設定の方を合わせる。status だけから推測して登録し直すと、オフにした利用者の選択を上書きしてしまう。
/// - 設定 ON で Enabled 以外 (オフにされた RequiresApproval・一覧から消された NotRegistered 等): 設定を OFF に
/// - 設定 OFF で Enabled (承認待ちだった項目をシステム設定でオンにした): 設定を ON に
///
/// セットアップ完了前・SMAppService が使えない場合は何もしない。戻り値は合わせるべき設定値。
pub fn reconcile(launch_at_login: bool, setup_completed: bool) -> Option<bool> {
    if cfg!(debug_assertions) || !setup_completed {
        return None;
    }
    reconciled(launch_at_login, status())
}

fn reconciled(launch_at_login: bool, status: Status) -> Option<bool> {
    match status {
        Status::Unsupported => None,
        Status::Enabled => (!launch_at_login).then_some(true),
        _ => launch_at_login.then_some(false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reconcile_follows_system_without_registering() {
        // 設定 ON でもシステム設定でオフ・削除されていれば設定を OFF に (登録し直さない)
        assert_eq!(reconciled(true, Status::RequiresApproval), Some(false));
        assert_eq!(reconciled(true, Status::NotRegistered), Some(false));
        assert_eq!(reconciled(true, Status::NotFound), Some(false));
        assert_eq!(reconciled(true, Status::Enabled), None);
        // システム設定でオンにされたら設定を ON に
        assert_eq!(reconciled(false, Status::Enabled), Some(true));
        assert_eq!(reconciled(false, Status::RequiresApproval), None);
        assert_eq!(reconciled(false, Status::NotRegistered), None);
        assert_eq!(reconciled(true, Status::Unsupported), None);
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn startup_approved_odd_first_byte_is_disabled() {
        assert!(!win::approved_disabled(None));
        assert!(!win::approved_disabled(Some(&[])));
        assert!(!win::approved_disabled(Some(&[
            0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
        ])));
        assert!(!win::approved_disabled(Some(&[0x06, 0, 0, 0])));
        assert!(win::approved_disabled(Some(&[
            0x03, 0x8a, 0x1f, 0, 0, 0, 0, 0, 0, 0, 0, 0
        ])));
        assert!(win::approved_disabled(Some(&[0x07])));
        assert_eq!(
            win::command_line(std::path::Path::new(r"C:\Users\a b\mukuchi.exe")),
            r#""C:\Users\a b\mukuchi.exe""#
        );
    }
}
