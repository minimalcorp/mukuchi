//! ログイン時に起動 (settings.launchAtLogin)。
//!
//! `SMAppService.mainAppService` (macOS 13+) でアプリ本体をログイン項目に登録する。
//! tauri-plugin-autostart (auto-launch 0.5) の macOS 実装は `~/Library/LaunchAgents/<名前>.plist` を置く
//! LaunchAgent 方式か、System Events への AppleScript 方式のみで、前者はアプリ外にファイルを残し
//! 後者は自動化の許可ダイアログが出るため使わない。SMAppService の登録はシステムの
//! Background Task Management に記録され、「システム設定 > 一般 > ログイン項目」に表示される。
//!
//! 開発ビルドでは起動時に自動で登録・解除しない (開発中のバイナリを利用者の環境に黙って登録しないため)。
//! 設定画面で明示的に切り替えた時だけ登録・解除する。

use anyhow::{bail, Result};

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
pub fn set_enabled(enabled: bool) -> Result<()> {
    use objc2_service_management::SMAppService;
    if !available() {
        bail!("ログイン時の起動には macOS 13 以降が必要です");
    }
    // SAFETY: クラスの存在を確認済み。register/unregister は NSError を返す同期 API
    let service = unsafe { SMAppService::mainAppService() };
    let result = if enabled {
        unsafe { service.registerAndReturnError() }
    } else {
        unsafe { service.unregisterAndReturnError() }
    };
    match result {
        Ok(()) => {
            log::info!(
                "ログイン項目を{}: {:?}",
                if enabled { "登録" } else { "解除" },
                status()
            );
            Ok(())
        }
        // 登録されていないものの解除は成功扱い
        Err(_) if !enabled && status() == Status::NotRegistered => Ok(()),
        Err(e) => {
            log::warn!(
                "ログイン項目の{}に失敗: {} (code {})",
                if enabled { "登録" } else { "解除" },
                e.localizedDescription(),
                e.code()
            );
            bail!(
                "ログイン時の起動を{}できません",
                if enabled { "設定" } else { "解除" }
            )
        }
    }
}

/// 起動時に設定とログイン項目の状態を揃える (本番ビルドのみ)。
///
/// - 設定が ON で未登録 (初回・再インストール後): 登録する
/// - 設定が ON でも、利用者がシステム設定でオフにした (RequiresApproval) 場合は登録し直さず、
///   設定を OFF に揃える (利用者の選択を上書きしない)。戻り値 `Some(false)` で知らせる
/// - 設定が OFF で登録済み: 解除する
///
/// セットアップ完了前は何もしない (導入途中のアプリを登録しない)。
pub fn reconcile(launch_at_login: bool, setup_completed: bool) -> Option<bool> {
    if cfg!(debug_assertions) || !setup_completed {
        return None;
    }
    match (launch_at_login, status()) {
        (true, Status::NotRegistered | Status::NotFound) => {
            if let Err(e) = set_enabled(true) {
                log::warn!("{e:#}");
            }
            None
        }
        (true, Status::RequiresApproval) => Some(false),
        (false, Status::Enabled) => {
            if let Err(e) = set_enabled(false) {
                log::warn!("{e:#}");
            }
            None
        }
        _ => None,
    }
}
