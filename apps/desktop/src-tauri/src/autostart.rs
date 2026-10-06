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

use anyhow::{bail, Result};

use crate::i18n::Msg;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    NotRegistered,
    Enabled,
    /// 登録済みだが、利用者がシステム設定でオフにした (承認待ち)
    RequiresApproval,
    NotFound,
    /// SMAppService が使えない (macOS 13 未満)
    Unsupported,
}

fn available() -> bool {
    // macOS 13 未満にはクラスがない。無いクラスへのメッセージ送信で落ちないよう先に確かめる
    objc2::runtime::AnyClass::get(c"SMAppService").is_some()
}

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
pub fn open_login_items_settings() -> Result<()> {
    use objc2_service_management::SMAppService;
    if !available() {
        bail!(Msg::LoginItemNeedsMacos13);
    }
    // SAFETY: クラスの存在を確認済み。引数のないクラスメソッド
    unsafe { SMAppService::openSystemSettingsLoginItems() };
    Ok(())
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
}
