//! macOS: 既存の `crate::macos` (objc2) を呼ぶだけ。

use std::sync::Arc;
use std::time::Duration;

use anyhow::anyhow;
use tauri::AppHandle;

use crate::insert::InsertBackend;
use crate::macos;

pub use crate::macos::{
    accessibility_trusted, microphone_authorization, open_path, open_url, request_microphone,
    running_apps, trash, MicAuthorization,
};

pub const NAME: &str = "macos";

/// クリップボード + ⌘V (CGEvent) で入力する
pub fn inserter(app: AppHandle) -> Arc<dyn InsertBackend> {
    Arc::new(macos::MacInserter::new(move || resolve_v_keycode(&app)))
}

/// 現在のキーボード配列で ⌘V になる keycode。TIS はメインスレッド専用のため、
/// メインスレッドで調べて入力キューのスレッドで待つ (メインスレッドは入力キューを待たないので詰まらない)。
fn resolve_v_keycode(app: &AppHandle) -> u16 {
    let (tx, rx) = std::sync::mpsc::channel();
    let sent = app.run_on_main_thread(move || {
        let r = objc2::MainThreadMarker::new()
            .ok_or_else(|| anyhow!("メインスレッドではありません"))
            .and_then(macos::keyboard::command_v_keycode);
        let _ = tx.send(r);
    });
    let result = match sent {
        Ok(()) => rx
            .recv_timeout(Duration::from_millis(500))
            .map_err(|_| anyhow!("応答がありません"))
            .and_then(|r| r),
        Err(e) => Err(anyhow!("メインスレッドに送れません: {e}")),
    };
    result.unwrap_or_else(|e| {
        log::warn!("⌘V のキーを解決できないため ANSI の V を使う: {e:#}");
        macos::keyboard::ANSI_V_KEYCODE
    })
}
