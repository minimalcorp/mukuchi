//! Alt+Space (ショートカットの既定) でウィンドウのシステムメニュー (元のサイズに戻す・移動・閉じる) を出さない。
//!
//! 実測 (Windows 11、WebView2) で出たのは 2 つ:
//! 1. ショートカットの記録中 (`set_shortcut_suspended(true)`。登録を外している) に設定・セットアップで
//!    Alt+Space を押すと、フロントエンドの keydown の `preventDefault` に関わらずシステムメニューが開く
//!    (WebView2 の外、ホストのウィンドウが `WM_SYSCOMMAND`/`SC_KEYMENU` を受けて開く)。
//!    → 記録中だけ、設定・セットアップのウィンドウで Space による `SC_KEYMENU` を捨てる。
//!    記録していない時は Alt+Space のメニューを残す (Windows の標準の操作のため)
//! 2. 登録済みでも、Alt を Space より先に離すと前面のウィンドウがメニューモードに入る (Alt の単独押下に見える)。
//!    → ショートカットを受けた時に `keys::send_menu_mask_if_held` で割り当てのないキーを挟む

use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::Result;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::Input::KeyboardAndMouse::VK_SPACE;
use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{SC_KEYMENU, WM_SYSCOMMAND};

/// SetWindowSubclass の識別子 (パネルの "muku" と別の値)
const SUBCLASS_ID: usize = 0x6d75_6b6d; // "mukm"

/// ショートカットの記録中か (記録中だけ Alt+Space のメニューを止める)
static RECORDING: AtomicBool = AtomicBool::new(false);

pub fn set_recording(recording: bool) {
    RECORDING.store(recording, Ordering::SeqCst);
}

/// 捨てる `WM_SYSCOMMAND` か (純粋関数)。wParam の下位 4 ビットは OS が使うため除いて比べる。
/// lParam はメニューを開いたキーの文字 (Alt だけで開いた時は 0。それは止めない)
fn is_space_keymenu(wparam: usize, lparam: isize, recording: bool) -> bool {
    recording && (wparam & 0xFFF0) == SC_KEYMENU as usize && lparam == VK_SPACE.0 as isize
}

unsafe extern "system" fn subclass(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    _data: usize,
) -> LRESULT {
    if msg == WM_SYSCOMMAND
        && is_space_keymenu(wparam.0, lparam.0, RECORDING.load(Ordering::SeqCst))
    {
        return LRESULT(0);
    }
    // SAFETY: 既定の処理 (次のサブクラス・元のウィンドウプロシージャ) に渡す
    unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
}

/// 設定・セットアップのウィンドウに付ける (作成直後に 1 回、ウィンドウのスレッド = メインスレッドで呼ぶ)
pub fn guard_window(hwnd: HWND) -> Result<()> {
    // SAFETY: サブクラスはウィンドウの破棄で一緒に外れる
    if !unsafe { SetWindowSubclass(hwnd, Some(subclass), SUBCLASS_ID, 0) }.as_bool() {
        anyhow::bail!("ウィンドウのサブクラス化に失敗しました");
    }
    Ok(())
}

/// ショートカットを受けた時に呼ぶ (メインスレッド。修飾キーを離す前に挟むため、他の処理より先に)
pub fn on_hotkey_pressed() {
    match super::keys::send_menu_mask_if_held() {
        Ok(true) => log::debug!("修飾キーの単独押下にならないようキーを挟みました"),
        Ok(false) => {}
        Err(e) => log::warn!("修飾キーの単独押下を防げません: {e:#}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_space_keymenu_while_recording_is_dropped() {
        let sc = SC_KEYMENU as usize;
        assert!(is_space_keymenu(sc, 0x20, true));
        // 下位 4 ビットは OS が使う
        assert!(is_space_keymenu(sc | 0x3, 0x20, true));
        // 記録していない時は残す
        assert!(!is_space_keymenu(sc, 0x20, false));
        // Alt だけ (メニューバー) ・ Alt+文字 (アクセスキー) は止めない
        assert!(!is_space_keymenu(sc, 0, true));
        assert!(!is_space_keymenu(sc, 'f' as isize, true));
        // 他のシステムコマンド (閉じる 0xF060) は止めない
        assert!(!is_space_keymenu(0xF060, 0x20, true));
    }
}
