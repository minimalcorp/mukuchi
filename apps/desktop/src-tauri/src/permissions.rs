//! TCC (マイク・アクセシビリティ) の状態取得・許可要求・システム設定を開く。
//! Windows はマイクのみ (アクセシビリティは常に true。docs/architecture.md「Windows 版」)。

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::platform::{self, MicAuthorization};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MicrophoneStatus {
    Granted,
    Denied,
    NotDetermined,
}

impl From<MicAuthorization> for MicrophoneStatus {
    fn from(m: MicAuthorization) -> Self {
        match m {
            MicAuthorization::Granted => Self::Granted,
            MicAuthorization::Denied => Self::Denied,
            MicAuthorization::NotDetermined => Self::NotDetermined,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Permissions {
    pub microphone: MicrophoneStatus,
    pub accessibility: bool,
}

pub fn current() -> Permissions {
    Permissions {
        microphone: platform::microphone_authorization().into(),
        accessibility: platform::accessibility_trusted(),
    }
}

pub async fn request_microphone() -> Permissions {
    platform::request_microphone().await;
    current()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Pane {
    Microphone,
    Accessibility,
    /// 一般 > ログイン項目 (ログイン項目の承認待ちからの復旧)
    LoginItems,
}

#[cfg(target_os = "macos")]
pub fn open_system_settings(pane: Pane) -> Result<()> {
    let anchor = match pane {
        Pane::Microphone => "Privacy_Microphone",
        Pane::Accessibility => "Privacy_Accessibility",
        // Apple が用意している API で開く (URL スキームは公開されていないため)
        Pane::LoginItems => return crate::autostart::open_login_items_settings(),
    };
    platform::open_url(&format!(
        "x-apple.systempreferences:com.apple.preference.security?{anchor}"
    ))
}

/// 「設定」アプリの該当ページ (docs/architecture.md の open_system_settings)
#[cfg(target_os = "windows")]
pub fn open_system_settings(pane: Pane) -> Result<()> {
    let uri = match pane {
        Pane::Microphone => "ms-settings:privacy-microphone",
        // アクセシビリティの権限は無く、フロントエンドも出さない。呼ばれても何もしない
        Pane::Accessibility => return Ok(()),
        Pane::LoginItems => return crate::autostart::open_login_items_settings(),
    };
    platform::open_url(uri)
}
