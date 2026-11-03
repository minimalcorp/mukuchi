//! TCC (マイク・アクセシビリティ) の状態取得・許可要求・システム設定を開く。
//! Windows はマイクのみ (アクセシビリティは常に true。docs/architecture.md「Windows 版」)。

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::platform::{self, MicAuthorization};
use crate::settings::Settings;

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
    /// サウンドの入力 (マイクの音が届かない時 (Phase::NoInput) の案内)
    SoundInput,
}

/// `settings` は開く先を選ぶのに使う (Windows の SoundInput。macOS では使わない)
#[cfg(target_os = "macos")]
pub fn open_system_settings(pane: Pane, _settings: &Settings) -> Result<()> {
    let anchor = match pane {
        Pane::Microphone => "Privacy_Microphone",
        Pane::Accessibility => "Privacy_Accessibility",
        // Apple が用意している API で開く (URL スキームは公開されていないため)
        Pane::LoginItems => return crate::autostart::open_login_items_settings(),
        // サウンドはプライバシーとは別の拡張。`?input` は Apple の公開文書に無いアンカー
        // (docs/architecture.md の open_system_settings。効かなくてもサウンドの設定は開く)
        Pane::SoundInput => {
            return platform::open_url(
                "x-apple.systempreferences:com.apple.Sound-Settings.extension?input",
            )
        }
    };
    platform::open_url(&format!(
        "x-apple.systempreferences:com.apple.preference.security?{anchor}"
    ))
}

/// 「設定」アプリの該当ページ (docs/architecture.md の open_system_settings)
#[cfg(target_os = "windows")]
pub fn open_system_settings(pane: Pane, settings: &Settings) -> Result<()> {
    let uri = match pane {
        Pane::Microphone => "ms-settings:privacy-microphone",
        // アクセシビリティの権限は無く、フロントエンドも出さない。呼ばれても何もしない
        Pane::Accessibility => return Ok(()),
        Pane::LoginItems => return crate::autostart::open_login_items_settings(),
        Pane::SoundInput => sound_input_uri(settings.input_device_id.is_some()),
    };
    platform::open_url(uri)
}

/// Windows の SoundInput の開く先。既定のマイク (システム既定) を使っている時はその入力デバイスのプロパティ
/// (音量・ミュートを直せる)、マイクを選んでいる時はサウンドの一覧 (既定のプロパティを開くと別の機器になるため)
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn sound_input_uri(device_selected: bool) -> &'static str {
    if device_selected {
        "ms-settings:sound"
    } else {
        "ms-settings:sound-defaultinputproperties"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pane_names() {
        let p: Pane = serde_json::from_str("\"sound_input\"").unwrap();
        assert_eq!(p, Pane::SoundInput);
        let p: Pane = serde_json::from_str("\"login_items\"").unwrap();
        assert_eq!(p, Pane::LoginItems);
    }

    #[test]
    fn windows_sound_input_uri() {
        assert_eq!(
            sound_input_uri(false),
            "ms-settings:sound-defaultinputproperties"
        );
        assert_eq!(sound_input_uri(true), "ms-settings:sound");
    }
}
