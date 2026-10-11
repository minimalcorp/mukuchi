//! キー入力の送信 (Windows: SendInput)。
//!
//! このファイルは `examples/win_spike.rs` からも `#[path]` で取り込む (実機の検証で同じコードを使うため)。
//! そのため `crate::` を参照しない (KeyCombo からの変換は mod.rs)。

use anyhow::{bail, Result};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, MapVirtualKeyW, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT,
    KEYBD_EVENT_FLAGS, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, MAPVK_VK_TO_VSC, VIRTUAL_KEY,
    VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT, VK_V,
};

/// 利用者が押したままにしていると送るキーに混ざる修飾キー
const MODIFIERS: [VIRTUAL_KEY; 5] = [VK_SHIFT, VK_CONTROL, VK_MENU, VK_LWIN, VK_RWIN];

/// E0 の付く (拡張) キー。付けないと別のキー (例: 左 Win が無いキー) として届くことがある
fn is_extended(vk: VIRTUAL_KEY) -> bool {
    matches!(vk, VK_LWIN | VK_RWIN)
}

fn key_input(vk: VIRTUAL_KEY, up: bool) -> INPUT {
    let mut flags = KEYBD_EVENT_FLAGS(0);
    if up {
        flags |= KEYEVENTF_KEYUP;
    }
    if is_extended(vk) {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    // スキャンコードも入れる (仮想キーではなくスキャンコードを見るアプリ・リモートデスクトップのため)
    // SAFETY: 引数は値のみ
    let scan = unsafe { MapVirtualKeyW(u32::from(vk.0), MAPVK_VK_TO_VSC) } as u16;
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: scan,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

/// 送るキーの並び (純粋関数。テスト用に分ける)。
/// 修飾キーを押す → 利用者が押したままの他の修飾キーを離す → キーを押して離す → 修飾キーを逆順に離す。
/// 押したままの修飾キーは「修飾キーを押した後」に離す (Alt を単独で押して離した扱いになると
/// 前面アプリのメニューバーが選択状態になるため)
pub fn chord_sequence(
    modifiers: &[VIRTUAL_KEY],
    key: VIRTUAL_KEY,
    held: &[VIRTUAL_KEY],
) -> Vec<(VIRTUAL_KEY, bool)> {
    let mut seq: Vec<(VIRTUAL_KEY, bool)> = modifiers.iter().map(|m| (*m, false)).collect();
    seq.extend(
        held.iter()
            .filter(|h| !modifiers.contains(h))
            .map(|h| (*h, true)),
    );
    seq.push((key, false));
    seq.push((key, true));
    seq.extend(modifiers.iter().rev().map(|m| (*m, true)));
    seq
}

/// 物理的に押されている修飾キー
fn held_modifiers() -> Vec<VIRTUAL_KEY> {
    MODIFIERS
        .into_iter()
        // SAFETY: キーの状態の問い合わせのみ。最上位ビットが押下中
        .filter(|vk| unsafe { GetAsyncKeyState(i32::from(vk.0)) } < 0)
        .collect()
}

/// 修飾キー + キーを 1 回の SendInput で送る (利用者の入力と混ざらないよう 1 回にまとめる)。
/// UIPI (前面が管理者権限のアプリ) で届かない時も成功を返すため、呼び出し側で事前に確かめる
pub fn send_chord(modifiers: &[VIRTUAL_KEY], key: VIRTUAL_KEY) -> Result<()> {
    let inputs: Vec<INPUT> = chord_sequence(modifiers, key, &held_modifiers())
        .into_iter()
        .map(|(vk, up)| key_input(vk, up))
        .collect();
    // SAFETY: inputs は有効な INPUT の配列
    let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent as usize != inputs.len() {
        bail!(
            "キー入力を送れません ({sent}/{}): {}",
            inputs.len(),
            windows::core::Error::from_thread()
        );
    }
    Ok(())
}

/// Ctrl+V (貼り付け)。V の仮想キーは配列によらず貼り付けになる (アプリは仮想キーで判定する)
pub fn send_paste() -> Result<()> {
    send_chord(&[VK_CONTROL], VK_V)
}

/// どのキーにも割り当てのない仮想キー (0xE8)。AutoHotkey の「メニューマスク」と同じ値
const VK_MENU_MASK: VIRTUAL_KEY = VIRTUAL_KEY(0xE8);

/// Alt・Win を押したままなら、割り当てのないキーを 1 回押して離す。押したかを返す。
///
/// RegisterHotKey は Space 等の keydown だけを奪い、Alt・Win の keydown・keyup は前面のアプリに届く。
/// 前面のアプリには「Alt (Win) を単独で押して離した」と見え、Alt はウィンドウのメニューモード
/// (タイトルバーのシステムメニューが選択された状態。続くキー入力・貼り付けをメニューが奪う)、Win は
/// スタートメニューになる (実測: Alt を Space より先に離すとメニューモードに入った)。
/// 間に別のキーを挟めば単独の押下ではなくなる。ショートカットを受けた直後 (修飾キーを離す前) に呼ぶ
pub fn send_menu_mask_if_held() -> Result<bool> {
    let held = held_modifiers();
    if !held
        .iter()
        .any(|vk| matches!(*vk, VK_MENU | VK_LWIN | VK_RWIN))
    {
        return Ok(false);
    }
    let inputs = [
        key_input(VK_MENU_MASK, false),
        key_input(VK_MENU_MASK, true),
    ];
    // SAFETY: inputs は有効な INPUT の配列
    let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent as usize != inputs.len() {
        bail!(
            "キー入力を送れません ({sent}/{}): {}",
            inputs.len(),
            windows::core::Error::from_thread()
        );
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::UI::Input::KeyboardAndMouse::VK_RETURN;

    #[test]
    fn chord_releases_held_modifiers_after_pressing_ours() {
        let seq = chord_sequence(&[VK_CONTROL], VK_V, &[VK_MENU, VK_CONTROL]);
        assert_eq!(
            seq,
            vec![
                (VK_CONTROL, false),
                (VK_MENU, true),
                (VK_V, false),
                (VK_V, true),
                (VK_CONTROL, true),
            ]
        );
    }

    #[test]
    fn chord_releases_modifiers_in_reverse() {
        let seq = chord_sequence(&[VK_CONTROL, VK_SHIFT], VK_RETURN, &[]);
        assert_eq!(
            seq,
            vec![
                (VK_CONTROL, false),
                (VK_SHIFT, false),
                (VK_RETURN, false),
                (VK_RETURN, true),
                (VK_SHIFT, true),
                (VK_CONTROL, true),
            ]
        );
    }

    #[test]
    fn win_keys_are_extended() {
        assert!(is_extended(VK_LWIN));
        assert!(!is_extended(VK_CONTROL));
    }
}
