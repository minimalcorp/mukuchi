//! パネル (常時表示のピル) の Windows 固有の処理: フォーカスを奪わない設定・位置・右クリックメニュー。
//!
//! フォーカスを奪わない (docs/plans/windows-plan.md U8) ための層:
//! 1. `focusable(false)` (tao が `WS_EX_NOACTIVATE` を付ける) + `WS_EX_TOOLWINDOW` (タスクバー・Alt+Tab に出さない)
//! 2. サブクラスで次を強制する。tao はウィンドウの状態を変えるたびに拡張スタイルを書き直し
//!    (`WS_EX_TOOLWINDOW` を落とす)、表示し直しでは `SW_SHOW` (アクティブ化を伴う) を使うため
//!    - `WM_STYLECHANGING`: 拡張スタイルに `WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW` を保つ
//!    - `WM_WINDOWPOSCHANGING`: `SWP_NOACTIVATE` を足す (表示・移動でアクティブにしない)
//!    - `WM_MOUSEACTIVATE`: `MA_NOACTIVATE` (クリックでアクティブにしない。WebView2 の子ウィンドウのクリックも
//!      親に問い合わせが来る)
//! 3. 右クリックメニューは `SetForegroundWindow` を呼ばずに `TrackPopupMenu` で出す
//!    (Tauri (muda) のポップアップは前面化してから出し、実測でも前面がパネルに移った)。
//!    前面化しないとメニューの外のクリックで閉じないため、開いている間だけ低レベルのフックで閉じる
//!
//! このファイルは `examples/win_spike.rs` からも `#[path]` で取り込む (実機の検証で同じコードを使うため)。
//! そのため `crate::` を参照しない。

use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::{Context, Result};
use windows::core::{HSTRING, PCWSTR};
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITORINFOEXW, MONITOR_DEFAULTTONULL,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, VK_ESCAPE, VK_LBUTTON, VK_RBUTTON,
};
use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{
    AppendMenuW, CallNextHookEx, CreatePopupMenu, DestroyMenu, EndMenu, GetClassNameW,
    GetForegroundWindow, GetSystemMetrics, GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos,
    SetWindowsHookExW, TrackPopupMenu, UnhookWindowsHookEx, WindowFromPoint, GWL_EXSTYLE,
    HC_ACTION, HHOOK, KBDLLHOOKSTRUCT, MA_NOACTIVATE, MF_CHECKED, MF_GRAYED, MF_SEPARATOR,
    MF_STRING, MSLLHOOKSTRUCT, SM_SWAPBUTTON, STYLESTRUCT, SWP_NOACTIVATE, SWP_NOOWNERZORDER,
    SWP_NOZORDER, TPM_NONOTIFY, TPM_RETURNCMD, TPM_RIGHTBUTTON, WH_KEYBOARD_LL, WH_MOUSE_LL,
    WINDOWPOS, WM_KEYDOWN, WM_KEYUP, WM_LBUTTONDOWN, WM_MBUTTONDOWN, WM_MOUSEACTIVATE,
    WM_RBUTTONDOWN, WM_STYLECHANGING, WM_WINDOWPOSCHANGING, WM_XBUTTONDOWN, WS_EX_NOACTIVATE,
    WS_EX_TOOLWINDOW,
};

/// SetWindowSubclass の識別子 (他のサブクラスと区別する任意の値)
const SUBCLASS_ID: usize = 0x6d75_6b75; // "muku"

/// GWL_EXSTYLE の WM_STYLECHANGING の wParam
const GWL_EXSTYLE_INDEX: usize = GWL_EXSTYLE.0 as isize as usize;

/// パネルに必ず付ける拡張スタイル
const PANEL_EX_STYLE: u32 = WS_EX_NOACTIVATE.0 | WS_EX_TOOLWINDOW.0;

unsafe extern "system" fn panel_subclass(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    _data: usize,
) -> LRESULT {
    match msg {
        WM_MOUSEACTIVATE => return LRESULT(MA_NOACTIVATE as isize),
        WM_STYLECHANGING if wparam.0 == GWL_EXSTYLE_INDEX => {
            // SAFETY: WM_STYLECHANGING の lParam は STYLESTRUCT を指す
            if let Some(s) = unsafe { (lparam.0 as *mut STYLESTRUCT).as_mut() } {
                s.styleNew |= PANEL_EX_STYLE;
            }
        }
        WM_WINDOWPOSCHANGING => {
            // SAFETY: WM_WINDOWPOSCHANGING の lParam は WINDOWPOS を指す
            if let Some(p) = unsafe { (lparam.0 as *mut WINDOWPOS).as_mut() } {
                p.flags |= SWP_NOACTIVATE;
            }
        }
        _ => {}
    }
    // SAFETY: 既定の処理 (次のサブクラス・元のウィンドウプロシージャ) に渡す
    unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
}

/// パネルのウィンドウがアクティブにならないようにする (作成直後に 1 回、ウィンドウのスレッドで呼ぶ)
pub fn prevent_activation(hwnd: HWND) -> Result<()> {
    // SAFETY: hwnd は呼び出し元が作ったパネル。サブクラスはウィンドウの破棄で一緒に外れる
    unsafe {
        if !SetWindowSubclass(hwnd, Some(panel_subclass), SUBCLASS_ID, 0).as_bool() {
            anyhow::bail!("パネルのサブクラス化に失敗しました");
        }
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | PANEL_EX_STYLE as isize);
    }
    Ok(())
}

/// パネルの拡張スタイル (確認・ログ用): (NOACTIVATE, TOOLWINDOW)
pub fn activation_flags(hwnd: HWND) -> (bool, bool) {
    // SAFETY: 読み出しのみ
    let ex = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } as u32;
    (ex & WS_EX_NOACTIVATE.0 != 0, ex & WS_EX_TOOLWINDOW.0 != 0)
}

/// 位置と大きさを 1 回で変える (物理 px)。2 回に分けると途中の位置で移動の通知が来るため
pub fn set_frame(hwnd: HWND, x: i32, y: i32, w: i32, h: i32) -> Result<()> {
    // SAFETY: 位置・大きさの変更のみ (Z オーダー・アクティブ状態は変えない)
    unsafe {
        SetWindowPos(
            hwnd,
            None,
            x,
            y,
            w,
            h,
            SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOOWNERZORDER,
        )
    }
    .context("パネルの位置を変えられません")
}

/// マウスの主ボタン (左右の入れ替えの設定に従う) が押されているか
pub fn primary_button_down() -> bool {
    // SAFETY: 状態の問い合わせのみ。GetAsyncKeyState は物理ボタンを返すため入れ替えを考える
    unsafe {
        let vk = if GetSystemMetrics(SM_SWAPBUTTON) != 0 {
            VK_RBUTTON
        } else {
            VK_LBUTTON
        };
        GetAsyncKeyState(i32::from(vk.0)) < 0
    }
}

/// 前面のウィンドウがあるモニターのデバイス名 (例 `\\.\DISPLAY1`)。Tauri の `Monitor::name` と同じ値
pub fn foreground_monitor_name() -> Option<String> {
    // SAFETY: 問い合わせのみ
    unsafe {
        let fg = GetForegroundWindow();
        if fg.0.is_null() {
            return None;
        }
        let m = MonitorFromWindow(fg, MONITOR_DEFAULTTONULL);
        if m.is_invalid() {
            return None;
        }
        let mut info = MONITORINFOEXW {
            monitorInfo: MONITORINFO {
                cbSize: std::mem::size_of::<MONITORINFOEXW>() as u32,
                ..Default::default()
            },
            ..Default::default()
        };
        if !GetMonitorInfoW(m, &mut info as *mut MONITORINFOEXW as *mut MONITORINFO).as_bool() {
            return None;
        }
        let len = info.szDevice.iter().position(|&c| c == 0).unwrap_or(32);
        Some(String::from_utf16_lossy(&info.szDevice[..len]))
    }
}

/// 右クリックメニューの 1 行
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PopupItem {
    Item { text: String, enabled: bool },
    Check { text: String, checked: bool },
    Separator,
}

/// メニューを出して、選ばれた項目の番号 (`items` の添字) を返す (閉じたら None)。メニューが閉じるまで戻らない。
/// `owner` はパネル (メニューの通知を受けるウィンドウ)、`(x, y)` は画面座標 (物理 px)。
/// 前面化しない (`SetForegroundWindow` を呼ばない) ため、入力先のアプリのフォーカスが残る
pub fn popup_menu(owner: HWND, items: &[PopupItem], (x, y): (i32, i32)) -> Result<Option<usize>> {
    // SAFETY: 作ったメニューは必ず破棄する。項目の ID は 1 始まり (0 は「選ばれなかった」)
    unsafe {
        let menu = CreatePopupMenu().context("メニューを作れません")?;
        let built = (|| -> Result<()> {
            for (i, item) in items.iter().enumerate() {
                let id = i + 1;
                match item {
                    PopupItem::Separator => AppendMenuW(menu, MF_SEPARATOR, 0, PCWSTR::null())?,
                    PopupItem::Item { text, enabled } => {
                        let mut flags = MF_STRING;
                        if !enabled {
                            flags |= MF_GRAYED;
                        }
                        AppendMenuW(menu, flags, id, &HSTRING::from(menu_text(text)))?
                    }
                    PopupItem::Check { text, checked } => {
                        let mut flags = MF_STRING;
                        if *checked {
                            flags |= MF_CHECKED;
                        }
                        AppendMenuW(menu, flags, id, &HSTRING::from(menu_text(text)))?
                    }
                }
            }
            Ok(())
        })();
        // 前面化しないと、メニューの外をクリックしてもメニューが閉じない (実測。メニューのループがマウスを
        // 捕まえないため)。開いている間だけ低レベルのフックで外のクリック・Esc を見て閉じる
        let hooks = MenuDismissHooks::install();
        let result = built.map(|()| {
            let r = TrackPopupMenu(
                menu,
                TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_NONOTIFY,
                x,
                y,
                None,
                owner,
                None,
            );
            let id = r.0 as usize;
            (id >= 1 && id <= items.len()).then(|| id - 1)
        });
        drop(hooks);
        let _ = DestroyMenu(menu);
        result
    }
}

/// メニューを開いている間の低レベルのマウス・キーボードのフック。メニューと同じスレッドで入れる
/// (低レベルのフックは入れたスレッドのメッセージ処理の中で呼ばれ、TrackPopupMenu のループが処理するため、
/// コールバックから EndMenu でこのスレッドのメニューを閉じられる)
struct MenuDismissHooks(Vec<HHOOK>);

impl MenuDismissHooks {
    fn install() -> Self {
        ESC_SWALLOWED.store(false, Ordering::SeqCst);
        let mut hooks = Vec::new();
        // SAFETY: コールバックは static な関数。Drop で外す
        unsafe {
            let module = GetModuleHandleW(PCWSTR::null()).ok().map(HINSTANCE::from);
            for (id, proc) in [
                (
                    WH_MOUSE_LL,
                    Some(
                        menu_mouse_hook
                            as unsafe extern "system" fn(i32, WPARAM, LPARAM) -> LRESULT,
                    ),
                ),
                (
                    WH_KEYBOARD_LL,
                    Some(
                        menu_keyboard_hook
                            as unsafe extern "system" fn(i32, WPARAM, LPARAM) -> LRESULT,
                    ),
                ),
            ] {
                match SetWindowsHookExW(id, proc, module, 0) {
                    Ok(h) => hooks.push(h),
                    Err(e) => log::warn!("メニューを閉じるためのフックを入れられません: {e}"),
                }
            }
        }
        Self(hooks)
    }
}

impl Drop for MenuDismissHooks {
    fn drop(&mut self) {
        for h in self.0.drain(..) {
            // SAFETY: install で入れたフック
            let _ = unsafe { UnhookWindowsHookEx(h) };
        }
    }
}

/// メニューのウィンドウ (クラス "#32768") の上か
fn is_menu_window(hwnd: HWND) -> bool {
    let mut buf = [0u16; 16];
    // SAFETY: 問い合わせのみ
    let n = unsafe { GetClassNameW(hwnd, &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize]) == "#32768"
}

/// メニューの外でボタンを押したら閉じる (クリックは閉じた後にそのまま押した先へ届く)
unsafe extern "system" fn menu_mouse_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32
        && matches!(
            wparam.0 as u32,
            WM_LBUTTONDOWN | WM_RBUTTONDOWN | WM_MBUTTONDOWN | WM_XBUTTONDOWN
        )
    {
        // SAFETY: WH_MOUSE_LL の lParam は MSLLHOOKSTRUCT を指す
        if let Some(m) = unsafe { (lparam.0 as *const MSLLHOOKSTRUCT).as_ref() } {
            // SAFETY: 問い合わせとこのスレッドのメニューを閉じるだけ
            if !is_menu_window(unsafe { WindowFromPoint(m.pt) }) {
                let _ = unsafe { EndMenu() };
            }
        }
    }
    // SAFETY: 次のフックに渡す
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

/// メニューを開いている間に押された Esc の keydown を止めたか (対の keyup も止めるため)
static ESC_SWALLOWED: AtomicBool = AtomicBool::new(false);

/// Esc で閉じる。メニューはキーボードのフォーカスを持たない (前面化しないため) ので、Esc は前面のアプリに
/// 届いてしまう (IME の変換中の文字を取り消す)。メニューを閉じるための Esc はここで止める。
/// keydown と keyup を対で止めるため、keydown (と押しっぱなしの繰り返し) を止め、その keyup でメニューを閉じる
/// (keydown で閉じるとフックを外した後に keyup だけが前面のアプリに届く)。開く前から押していた Esc の
/// keyup は止めない
unsafe extern "system" fn menu_keyboard_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        // SAFETY: WH_KEYBOARD_LL の lParam は KBDLLHOOKSTRUCT を指す
        if let Some(k) = unsafe { (lparam.0 as *const KBDLLHOOKSTRUCT).as_ref() } {
            if k.vkCode == u32::from(VK_ESCAPE.0) {
                match wparam.0 as u32 {
                    WM_KEYDOWN => {
                        ESC_SWALLOWED.store(true, Ordering::SeqCst);
                        return LRESULT(1);
                    }
                    WM_KEYUP if ESC_SWALLOWED.swap(false, Ordering::SeqCst) => {
                        // SAFETY: このスレッドのメニューを閉じる
                        let _ = unsafe { EndMenu() };
                        return LRESULT(1);
                    }
                    _ => {}
                }
            }
        }
    }
    // SAFETY: 次のフックに渡す
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

/// メニューの文字列では `&` が次の文字のアクセスキーの印になるため、文字として出すには `&&` にする
fn menu_text(text: &str) -> String {
    text.replace('&', "&&")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ampersand_is_escaped_in_menu_text() {
        assert_eq!(menu_text("A & B"), "A && B");
        assert_eq!(menu_text("設定を開く…"), "設定を開く…");
    }
}
