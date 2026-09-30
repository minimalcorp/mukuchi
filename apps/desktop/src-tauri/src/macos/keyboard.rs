//! 現在のキーボード配列で ⌘V になる物理キーの解決。
//!
//! cjpais/Handy (MIT License, Copyright (c) 2025 CJ Pais) の `src-tauri/src/input.rs` の
//! `resolve_command_v_keycode` を元にしている。変更点: 戻り値を `anyhow::Result` にし、
//! 見つからない場合の既定値 (ANSI の V) の扱いを呼び出し側に寄せた。
//!
//! Dvorak 等では ANSI の V (keycode 9) が別の文字になり、⌘V が貼り付けにならないため、
//! 配列から「⌘を押しながらで v になるキー」を探す。
//! TIS の API はメインスレッドでしか呼べない (他スレッドからだと macOS 14 以降で落ちる)。

use std::ffi::c_void;

use anyhow::{bail, Result};
use objc2::MainThreadMarker;

type TisInputSourceRef = *const c_void;
type CfDataRef = *const c_void;
type CfStringRef = *const c_void;

/// kVK_ANSI_V。配列を取得できない場合の既定値
pub const ANSI_V_KEYCODE: u16 = 9;
const KEYCODE_COUNT: u16 = 128;
const UC_KEY_ACTION_DISPLAY: u16 = 3;
const UC_KEY_TRANSLATE_NO_DEAD_KEYS_MASK: u32 = 1;
/// Carbon の cmdKey (bit 8) を 8 ビット右にずらした値 (UCKeyTranslate の modifierKeyState の形式)。
/// ⌘付きで引くのは、非ラテン配列の多くが ⌘ショートカットだけ ANSI 相当に切り替えるため
const COMMAND_MODIFIER_STATE: u32 = 1;

#[link(name = "Carbon", kind = "framework")]
unsafe extern "C" {
    fn TISCopyCurrentKeyboardLayoutInputSource() -> TisInputSourceRef;
    fn TISGetInputSourceProperty(input_source: TisInputSourceRef, key: CfStringRef) -> CfDataRef;
    static kTISPropertyUnicodeKeyLayoutData: CfStringRef;
    #[allow(clippy::too_many_arguments)]
    fn UCKeyTranslate(
        key_layout: *const u8,
        virtual_key_code: u16,
        key_action: u16,
        modifier_key_state: u32,
        keyboard_type: u32,
        key_translate_options: u32,
        dead_key_state: *mut u32,
        max_string_length: usize,
        actual_string_length: *mut usize,
        unicode_string: *mut u16,
    ) -> i32;
    fn LMGetKbdType() -> u8;
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFDataGetBytePtr(data: CfDataRef) -> *const u8;
    fn CFRelease(value: *const c_void);
}

struct InputSource(TisInputSourceRef);

impl Drop for InputSource {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: Copy 規則で得た参照を1回だけ解放する
            unsafe { CFRelease(self.0) };
        }
    }
}

/// 現在の配列で ⌘ を押しながら `v` になる keycode を返す。メインスレッドで呼ぶ。
pub fn command_v_keycode(_mtm: MainThreadMarker) -> Result<u16> {
    // SAFETY: メインスレッドで呼んでいる (MainThreadMarker)。戻り値は InputSource が解放する
    let source = InputSource(unsafe { TISCopyCurrentKeyboardLayoutInputSource() });
    if source.0.is_null() {
        bail!("現在のキーボード配列を取得できません");
    }
    // SAFETY: source を保持している間は property も有効。定数は Carbon が定義する
    let data = unsafe { TISGetInputSourceProperty(source.0, kTISPropertyUnicodeKeyLayoutData) };
    if data.is_null() {
        bail!("キーボード配列に Unicode の配列情報がありません");
    }
    // SAFETY: data は source が所有する CFData で、走査の間は解放されない
    let layout = unsafe { CFDataGetBytePtr(data) };
    if layout.is_null() {
        bail!("キーボード配列の情報が空です");
    }
    // SAFETY: 引数のない問い合わせ
    let keyboard_type = unsafe { LMGetKbdType() } as u32;
    let found = (0..KEYCODE_COUNT).find(|&code| {
        let mut dead = 0u32;
        let mut chars = [0u16; 4];
        let mut len = 0usize;
        // SAFETY: layout は有効な UCKeyboardLayout。出力先はすべて宣言した大きさのローカル変数
        let status = unsafe {
            UCKeyTranslate(
                layout,
                code,
                UC_KEY_ACTION_DISPLAY,
                COMMAND_MODIFIER_STATE,
                keyboard_type,
                UC_KEY_TRANSLATE_NO_DEAD_KEYS_MASK,
                &mut dead,
                chars.len(),
                &mut len,
                chars.as_mut_ptr(),
            )
        };
        status == 0 && len == 1 && chars[0] == u16::from(b'v')
    });
    match found {
        Some(code) => Ok(code),
        None => bail!("現在の配列に ⌘V になるキーがありません"),
    }
}
