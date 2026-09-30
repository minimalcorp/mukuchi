//! macOS API の呼び出し (objc2)。unsafe はこのモジュールに閉じ込める。

pub mod activation;
pub mod keyboard;
pub mod screen;
pub mod status_icon;

use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2_app_kit::{
    NSApplicationActivationPolicy, NSPasteboard, NSPasteboardItem, NSPasteboardTypeString,
    NSPasteboardWriting, NSWorkspace,
};
use objc2_core_graphics::{
    CGEvent, CGEventFlags, CGEventSource, CGEventSourceStateID, CGEventTapLocation,
};
use objc2_foundation::{NSArray, NSData, NSString, NSURL};

use crate::insert::{FrontApp, InsertBackend};
use crate::settings::{Key, KeyCombo, Modifier};

// ---- 権限 -------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MicAuthorization {
    Granted,
    Denied,
    NotDetermined,
}

pub fn microphone_authorization() -> MicAuthorization {
    use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};
    // SAFETY: AVMediaTypeAudio は AVFoundation が定義する定数。リンク済みなら常に有効
    let Some(media) = (unsafe { AVMediaTypeAudio }) else {
        return MicAuthorization::Denied;
    };
    // SAFETY: media type に Audio を渡すのは API の想定どおり (Video/Audio 以外は例外)
    let status = unsafe { AVCaptureDevice::authorizationStatusForMediaType(media) };
    match status {
        AVAuthorizationStatus::Authorized => MicAuthorization::Granted,
        AVAuthorizationStatus::NotDetermined => MicAuthorization::NotDetermined,
        // Restricted (MDM等) も利用者から見れば「許可されていない」
        _ => MicAuthorization::Denied,
    }
}

/// マイクの許可ダイアログを出し、結果を待つ。すでに決定済みなら即座に返る。
pub async fn request_microphone() -> MicAuthorization {
    use objc2_av_foundation::{AVCaptureDevice, AVMediaTypeAudio};
    if microphone_authorization() != MicAuthorization::NotDetermined {
        return microphone_authorization();
    }
    // SAFETY: 上と同じ
    let Some(media) = (unsafe { AVMediaTypeAudio }) else {
        return MicAuthorization::Denied;
    };
    let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
    let tx = std::sync::Mutex::new(Some(tx));
    {
        // RcBlock は Send でないため await をまたがないようスコープを閉じる
        // (AVFoundation 側がコピーして保持するので、こちらの参照は呼び出し後に解放してよい)
        let block = block2::RcBlock::new(move |granted: objc2::runtime::Bool| {
            if let Some(tx) = tx.lock().ok().and_then(|mut t| t.take()) {
                let _ = tx.send(granted.as_bool());
            }
        });
        // SAFETY: completionHandler は任意のキューから1回呼ばれる。block は Send なデータのみ保持する
        unsafe { AVCaptureDevice::requestAccessForMediaType_completionHandler(media, &block) };
    }
    // ダイアログは利用者の操作待ちのため時間制限を設けない
    let _ = rx.await;
    microphone_authorization()
}

pub fn accessibility_trusted() -> bool {
    // SAFETY: 引数のない問い合わせ関数
    unsafe { objc2_application_services::AXIsProcessTrusted() }
}

pub fn open_url(url: &str) -> Result<()> {
    let ns = NSURL::URLWithString(&NSString::from_str(url))
        .with_context(|| format!("URLが不正: {url}"))?;
    if NSWorkspace::sharedWorkspace().openURL(&ns) {
        Ok(())
    } else {
        Err(anyhow!("開けませんでした: {url}"))
    }
}

/// Finder でフォルダを開く (パスに空白等があってもよいよう file URL を正しく作る)
pub fn open_path(path: &std::path::Path) -> Result<()> {
    let s = path.to_str().context("パスが UTF-8 ではありません")?;
    let url = NSURL::fileURLWithPath(&NSString::from_str(s));
    if NSWorkspace::sharedWorkspace().openURL(&url) {
        Ok(())
    } else {
        Err(anyhow!("開けませんでした: {}", path.display()))
    }
}

/// ゴミ箱に入れる (アンインストールでアプリ本体に使う。rm と違い利用者が取り戻せる)
pub fn trash(path: &std::path::Path) -> Result<()> {
    let s = path.to_str().context("パスが UTF-8 ではありません")?;
    let url = NSURL::fileURLWithPath(&NSString::from_str(s));
    objc2_foundation::NSFileManager::defaultManager()
        .trashItemAtURL_resultingItemURL_error(&url, None)
        .map_err(|e| {
            anyhow!(
                "ゴミ箱に入れられません: {} ({})",
                path.display(),
                e.localizedDescription()
            )
        })
}

// ---- アプリ -----------------------------------------------------------------

pub fn frontmost_app() -> Option<FrontApp> {
    let app = NSWorkspace::sharedWorkspace().frontmostApplication()?;
    Some(FrontApp {
        name: app
            .localizedName()
            .map(|s| s.to_string())
            .unwrap_or_default(),
        bundle_id: app.bundleIdentifier().map(|s| s.to_string()),
    })
}

/// Dock に表示される通常のアプリ (入力しないアプリの候補)
pub fn running_apps() -> Vec<FrontApp> {
    let apps = NSWorkspace::sharedWorkspace().runningApplications();
    let mut out: Vec<FrontApp> = apps
        .iter()
        .filter(|a| a.activationPolicy() == NSApplicationActivationPolicy::Regular)
        .filter_map(|a| {
            Some(FrontApp {
                name: a.localizedName()?.to_string(),
                bundle_id: Some(a.bundleIdentifier()?.to_string()),
            })
        })
        .collect();
    out.sort_by_key(|a| a.name.to_lowercase());
    out.dedup_by(|a, b| a.bundle_id == b.bundle_id);
    out
}

// ---- 入力 -------------------------------------------------------------------

/// ⌘V を送ってから、貼り付け先がクリップボードを読み終えるまで待つ時間。
/// 短すぎると復元後の内容が貼り付けられる (Handy は 60ms。Electron 系の遅いアプリに備えて長め)
const PASTE_SETTLE: Duration = Duration::from_millis(200);
/// クリップボードを書き換えてから ⌘V を送るまでの待ち
const BEFORE_PASTE: Duration = Duration::from_millis(30);

const KEYCODE_RETURN: u16 = 36;
const KEYCODE_TAB: u16 = 48;
const KEYCODE_DELETE: u16 = 51;
const KEYCODE_ESCAPE: u16 = 53;

/// クリップボード履歴アプリに一時データとして扱わせるための型 (nspasteboard.org の慣例)
const TRANSIENT_TYPE: &str = "org.nspasteboard.TransientType";
const AUTO_GENERATED_TYPE: &str = "org.nspasteboard.AutoGeneratedType";

pub struct MacInserter {
    /// 現在のキーボード配列で ⌘V になる keycode を返す (TIS はメインスレッド専用のため呼び出し側が中継する)
    resolve_v_keycode: Box<dyn Fn() -> u16 + Send + Sync>,
}

impl MacInserter {
    pub fn new(resolve_v_keycode: impl Fn() -> u16 + Send + Sync + 'static) -> Self {
        Self {
            resolve_v_keycode: Box::new(resolve_v_keycode),
        }
    }
}

impl InsertBackend for MacInserter {
    fn frontmost_app(&self) -> Option<FrontApp> {
        frontmost_app()
    }

    fn is_trusted(&self) -> bool {
        accessibility_trusted()
    }

    fn paste_text(&self, text: &str) -> Result<()> {
        // 書き込む項目を先に作る。ここで失敗しても利用者のクリップボードには触れていない
        let item = NSPasteboardItem::new();
        // SAFETY: NSPasteboardTypeString は AppKit が定義する定数
        let string_type = unsafe { NSPasteboardTypeString };
        if !item.setString_forType(&NSString::from_str(text), string_type) {
            anyhow::bail!("クリップボードに文字列を設定できません");
        }
        let empty = NSData::new();
        for t in [TRANSIENT_TYPE, AUTO_GENERATED_TYPE] {
            item.setData_forType(&empty, &NSString::from_str(t));
        }
        let objects: Retained<NSArray<ProtocolObject<dyn NSPasteboardWriting>>> =
            NSArray::from_retained_slice(&[ProtocolObject::from_retained(item)]);
        let v_keycode = (self.resolve_v_keycode)();

        let pb = NSPasteboard::generalPasteboard();
        let saved = snapshot_pasteboard(&pb);
        pb.clearContents();
        if !pb.writeObjects(&objects) {
            restore_pasteboard(&pb, &saved);
            anyhow::bail!("クリップボードに書き込めません");
        }
        let our_change = pb.changeCount();

        std::thread::sleep(BEFORE_PASTE);
        let posted = post_key(v_keycode, CGEventFlags::MaskCommand);
        std::thread::sleep(PASTE_SETTLE);

        // 待っている間に利用者や他アプリがクリップボードを変えた場合は、そちらを優先して復元しない
        if pb.changeCount() == our_change {
            restore_pasteboard(&pb, &saved);
        } else {
            log::info!("クリップボードが他で変更されたため復元しない");
        }
        posted
    }

    fn send_key(&self, key: &KeyCombo) -> Result<()> {
        let code = match key.key {
            Key::Enter => KEYCODE_RETURN,
            Key::Tab => KEYCODE_TAB,
            Key::Escape => KEYCODE_ESCAPE,
            Key::Backspace => KEYCODE_DELETE,
        };
        let mut flags = CGEventFlags::empty();
        for m in &key.modifiers {
            flags |= match m {
                Modifier::Cmd => CGEventFlags::MaskCommand,
                Modifier::Shift => CGEventFlags::MaskShift,
                Modifier::Option => CGEventFlags::MaskAlternate,
                Modifier::Ctrl => CGEventFlags::MaskControl,
            };
        }
        post_key(code, flags)
    }
}

/// キーを押して離す。修飾キーはイベントのフラグで指定する
/// (利用者が物理的に押している修飾キーの影響を受けないよう、フラグを明示的に上書きする)。
fn post_key(code: u16, flags: CGEventFlags) -> Result<()> {
    let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState);
    for down in [true, false] {
        let ev = CGEvent::new_keyboard_event(source.as_deref(), code, down)
            .context("キーイベントを作成できません")?;
        CGEvent::set_flags(Some(&ev), flags);
        CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&ev));
        std::thread::sleep(Duration::from_millis(5));
    }
    Ok(())
}

/// クリップボードの全項目・全形式 (画像やファイル参照も含む) を退避する。
type PasteboardSnapshot = Vec<Vec<(Retained<NSString>, Retained<NSData>)>>;

fn snapshot_pasteboard(pb: &NSPasteboard) -> PasteboardSnapshot {
    let Some(items) = pb.pasteboardItems() else {
        return Vec::new();
    };
    items
        .iter()
        .map(|item| {
            item.types()
                .iter()
                .filter_map(|t| {
                    let data = item.dataForType(&t)?;
                    Some((t, data))
                })
                .collect()
        })
        .collect()
}

fn restore_pasteboard(pb: &NSPasteboard, saved: &PasteboardSnapshot) {
    pb.clearContents();
    if saved.is_empty() {
        return;
    }
    let items: Vec<Retained<ProtocolObject<dyn NSPasteboardWriting>>> = saved
        .iter()
        .map(|types| {
            let item = NSPasteboardItem::new();
            for (t, data) in types {
                item.setData_forType(data, t);
            }
            ProtocolObject::from_retained(item)
        })
        .collect();
    let array = NSArray::from_retained_slice(&items);
    if !pb.writeObjects(&array) {
        log::warn!("クリップボードの復元に失敗");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 前面アプリに実際に貼り付けるため手動実行のみ:
    /// テキストエディット等を前面にして `cargo test -- --ignored paste_restores_clipboard`
    #[test]
    #[ignore]
    fn paste_restores_clipboard() {
        let pb = NSPasteboard::generalPasteboard();
        pb.clearContents();
        // SAFETY: AppKit の定数
        let t = unsafe { NSPasteboardTypeString };
        pb.setString_forType(&NSString::from_str("ORIGINAL"), t);
        MacInserter::new(|| keyboard::ANSI_V_KEYCODE)
            .paste_text("貼り付けテスト")
            .unwrap();
        let after = pb.stringForType(t).map(|s| s.to_string());
        assert_eq!(after.as_deref(), Some("ORIGINAL"));
    }
}
