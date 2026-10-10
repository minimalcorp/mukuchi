//! Windows の OS 依存部 (docs/plans/windows-plan.md §4.1、docs/architecture.md「Windows 版」)。
//!
//! - 入力: クリップボードの全形式を退避 → テキストを置く → `SendInput` で Ctrl+V → 復元 (`clipboard.rs`・`keys.rs`)。
//!   前面が管理者として動くアプリなら UIPI で届かないため送らずにエラー (`BlockedByElevation`)
//! - 前面アプリ・起動中のアプリ: 実行ファイル名 (小文字) を識別子にする (`apps.rs`)
//! - パネル: フォーカスを奪わない設定・位置・右クリックメニュー (`panel.rs`)
//! - Alt+Space のシステムメニュー・メニューモードを出さない (`sysmenu.rs`)
//! - 権限: マイクは「設定 > プライバシーとセキュリティ > マイク」の状態をレジストリから読む。アクセシビリティは無い

use std::sync::Arc;

use anyhow::{bail, Result};
use tauri::AppHandle;
use windows::core::{HSTRING, PCWSTR};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    VIRTUAL_KEY, VK_BACK, VK_CONTROL, VK_ESCAPE, VK_LWIN, VK_MENU, VK_RETURN, VK_SHIFT, VK_TAB,
};
use windows::Win32::UI::Shell::{
    SHFileOperationW, ShellExecuteW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT,
    FO_DELETE, SHFILEOPSTRUCTW,
};
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

use crate::insert::{BlockedByElevation, FrontApp, InsertBackend};
use crate::settings::{Key, KeyCombo, Modifier};

mod apps;
mod clipboard;
mod keys;
pub mod panel;
pub mod sysmenu;

pub use apps::running_apps;

pub const NAME: &str = "windows";

// ---- 権限 -------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MicAuthorization {
    Granted,
    Denied,
    NotDetermined,
}

/// 「設定 > プライバシーとセキュリティ > マイク」の状態の置き場所 (CapabilityAccessManager)。
/// 値 `Value` が `Deny` なら拒否。上から「マイクへのアクセス」(端末全体)、「アプリにマイクへのアクセスを許可する」、
/// 「デスクトップ アプリにマイクへのアクセスを許可する」(mukuchi はパッケージ化していないデスクトップ アプリ)
const MIC_CONSENT: &str =
    r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";

/// 読んだ値から許可の状態を決める (純粋関数)。
/// どれかが Deny なら拒否。読めない (権限・壊れた値) 時は拒否とせず未確定 (実際に録音できるかは cpal のエラーで分かる)。
/// 値が無いのは既定 (許可) の状態
fn mic_authorization_from(values: &[Result<Option<String>, ()>]) -> MicAuthorization {
    if values
        .iter()
        .any(|v| matches!(v, Ok(Some(s)) if s.eq_ignore_ascii_case("Deny")))
    {
        return MicAuthorization::Denied;
    }
    if values.iter().any(|v| v.is_err()) {
        return MicAuthorization::NotDetermined;
    }
    MicAuthorization::Granted
}

/// レジストリの文字列。キー・値が無ければ Ok(None)、それ以外の失敗は Err
fn read_reg_string(
    root: &windows_registry::Key,
    path: &str,
    name: &str,
) -> Result<Option<String>, ()> {
    let not_found = |e: &windows::core::Error| {
        e.code() == windows::Win32::Foundation::ERROR_FILE_NOT_FOUND.to_hresult()
    };
    let key = match root.open(path) {
        Ok(k) => k,
        Err(e) if not_found(&e) => return Ok(None),
        Err(e) => {
            log::warn!("レジストリを読めません ({path}): {e}");
            return Err(());
        }
    };
    match key.get_string(name) {
        Ok(s) => Ok(Some(s)),
        Err(e) if not_found(&e) => Ok(None),
        Err(e) => {
            log::warn!("レジストリを読めません ({path}\\{name}): {e}");
            Err(())
        }
    }
}

pub fn microphone_authorization() -> MicAuthorization {
    let nonpackaged = format!(r"{MIC_CONSENT}\NonPackaged");
    mic_authorization_from(&[
        read_reg_string(windows_registry::LOCAL_MACHINE, MIC_CONSENT, "Value"),
        read_reg_string(windows_registry::CURRENT_USER, MIC_CONSENT, "Value"),
        read_reg_string(windows_registry::CURRENT_USER, &nonpackaged, "Value"),
    ])
}

/// Windows には許可ダイアログが無い (拒否なら設定アプリへ案内する)。
/// 状態を読めない時は許可として扱い、聞き始めを止めない (実際に録音できなければ cpal のエラーになる)
pub async fn request_microphone() -> MicAuthorization {
    match microphone_authorization() {
        MicAuthorization::Denied => MicAuthorization::Denied,
        _ => MicAuthorization::Granted,
    }
}

/// Windows にアクセシビリティの権限は無い (docs/architecture.md「インターフェース」の Permissions)
pub fn accessibility_trusted() -> bool {
    true
}

// ---- 表示言語 ---------------------------------------------------------------

/// Windows の表示言語の優先順 (例 ["ja-JP", "en-US"])。設定 > 時刻と言語 > 言語と地域の並び
pub fn preferred_ui_languages() -> Vec<String> {
    use windows::Win32::Globalization::{GetUserPreferredUILanguages, MUI_LANGUAGE_NAME};
    let mut count = 0u32;
    let mut len = 0u32;
    // SAFETY: 1 回目で長さを問い合わせ、確保した buf に読む
    unsafe {
        if GetUserPreferredUILanguages(MUI_LANGUAGE_NAME, &mut count, None, &mut len).is_err()
            || len == 0
        {
            return Vec::new();
        }
        let mut buf = vec![0u16; len as usize];
        if GetUserPreferredUILanguages(
            MUI_LANGUAGE_NAME,
            &mut count,
            Some(windows::core::PWSTR(buf.as_mut_ptr())),
            &mut len,
        )
        .is_err()
        {
            return Vec::new();
        }
        split_multi_sz(&buf)
    }
}

/// NUL 区切り・二重 NUL 終端の文字列の並び
fn split_multi_sz(buf: &[u16]) -> Vec<String> {
    buf.split(|&c| c == 0)
        .take_while(|s| !s.is_empty())
        .map(String::from_utf16_lossy)
        .collect()
}

// ---- シェル -----------------------------------------------------------------

/// 既定のアプリで開く (URL・`ms-settings:` の URI・フォルダ (エクスプローラー))
fn shell_open(target: &str) -> Result<()> {
    // SAFETY: 文字列は呼び出しの間生きている
    let r = unsafe {
        ShellExecuteW(
            None,
            &HSTRING::from("open"),
            &HSTRING::from(target),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    // 32 以下はエラー (ShellExecuteW のドキュメント)
    if r.0 as isize <= 32 {
        bail!("開けません ({}): {target}", r.0 as isize);
    }
    Ok(())
}

pub fn open_url(url: &str) -> Result<()> {
    shell_open(url)
}

/// フォルダをエクスプローラーで開く
pub fn open_path(path: &std::path::Path) -> Result<()> {
    shell_open(&path.to_string_lossy())
}

/// ごみ箱へ移す (元に戻せる。確認・進捗のダイアログは出さない)
pub fn trash(path: &std::path::Path) -> Result<()> {
    // pFrom は二重 NUL 終端の並び
    let from: Vec<u16> = path
        .as_os_str()
        .to_string_lossy()
        .encode_utf16()
        .chain([0, 0])
        .collect();
    let mut op = SHFILEOPSTRUCTW {
        wFunc: FO_DELETE,
        pFrom: PCWSTR(from.as_ptr()),
        fFlags: (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT).0 as u16,
        ..Default::default()
    };
    // SAFETY: op と from は呼び出しの間生きている
    let r = unsafe { SHFileOperationW(&mut op) };
    if r != 0 || op.fAnyOperationsAborted.as_bool() {
        bail!("ごみ箱に移せません ({r:#x}): {}", path.display());
    }
    Ok(())
}

// ---- 入力 -------------------------------------------------------------------

pub fn inserter(_app: AppHandle) -> Arc<dyn InsertBackend> {
    Arc::new(WinInserter)
}

/// 音声コマンドのキー (KeyCombo) を SendInput の仮想キーにする。`cmd` は Win キー、`option` は Alt
fn key_combo_vks(key: &KeyCombo) -> (Vec<VIRTUAL_KEY>, VIRTUAL_KEY) {
    let vk = match key.key {
        Key::Enter => VK_RETURN,
        Key::Tab => VK_TAB,
        Key::Escape => VK_ESCAPE,
        Key::Backspace => VK_BACK,
    };
    // 押す順は Ctrl・Shift・Alt・Win に固定する (同じ組み合わせなら毎回同じ並びで送る)
    let order = [
        (Modifier::Ctrl, VK_CONTROL),
        (Modifier::Shift, VK_SHIFT),
        (Modifier::Option, VK_MENU),
        (Modifier::Cmd, VK_LWIN),
    ];
    let mods = order
        .iter()
        .filter(|(m, _)| key.modifiers.contains(m))
        .map(|(_, v)| *v)
        .collect();
    (mods, vk)
}

/// 前面が管理者として動くアプリなら送らない (UIPI で届かず、失敗も返らないため)
fn ensure_reachable() -> Result<()> {
    if apps::foreground_is_elevated() {
        return Err(BlockedByElevation.into());
    }
    Ok(())
}

struct WinInserter;

impl InsertBackend for WinInserter {
    fn frontmost_app(&self) -> Option<FrontApp> {
        apps::frontmost_app()
    }

    fn is_trusted(&self) -> bool {
        accessibility_trusted()
    }

    fn paste_text(&self, text: &str) -> Result<()> {
        ensure_reachable()?;
        let r = clipboard::paste_text(text, keys::send_paste)?;
        // 文字数・内容は出さない (経過だけ)
        log::debug!(
            "貼り付け: 退避 {} 形式、読み取りまで {:?}、先読み {} (最初に読んだプロセス {:?})、復元 {}",
            r.saved_formats,
            r.rendered_after,
            r.read_before_paste,
            r.first_reader,
            r.restored
        );
        if r.rendered_after.is_none() && !r.read_before_paste {
            // 貼り付け先がクリップボードを読みに来なかった (Ctrl+V を貼り付けにしないアプリ等)
            log::info!("貼り付け先がクリップボードを読みませんでした");
        }
        Ok(())
    }

    fn send_key(&self, key: &KeyCombo) -> Result<()> {
        ensure_reachable()?;
        let (mods, vk) = key_combo_vks(key);
        keys::send_chord(&mods, vk)
    }
}

// ---- トレイ -----------------------------------------------------------------

/// タスクトレイのアイコン。型は macOS の `macos::status_icon` と同じ形 (tray.rs が同じ定義で使うため)。
/// 画像はメニューバー用のテンプレート (黒 + アルファ) をそのまま使い、タスクバーの明暗に合わせて塗る
pub mod tray {
    use anyhow::{Context, Result};

    #[derive(Clone, Copy)]
    pub struct IconPng {
        // Windows は大きい方 (@2x = 36px) だけ使う (トレイは 16〜32px で、縮小の方がきれいなため)
        #[allow(dead_code)]
        pub x1: &'static [u8],
        pub x2: &'static [u8],
    }

    #[derive(Clone, Copy)]
    pub enum StatusIcon {
        Template(IconPng),
        /// グリフ + 右上の赤い点 (エラー)。`dark` はタスクバーが暗いか (Windows では set_icon の引数で渡す)
        WithRedDot {
            png: IconPng,
            #[allow(dead_code)]
            dark: bool,
        },
    }

    /// タスクバーが暗いか (設定 > 個人用設定 > 色 の「既定の Windows モード」)。値が無ければ暗い (Windows 11 の既定)
    pub fn taskbar_is_dark() -> bool {
        windows_registry::CURRENT_USER
            .open(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize")
            .and_then(|k| k.get_u32("SystemUsesLightTheme"))
            .map(|v| v == 0)
            .unwrap_or(true)
    }

    /// macOS の systemRed (エラーの点)
    const RED: [u8; 3] = [0xFF, 0x3B, 0x30];

    /// 円の被覆率 (4x4 の標本で縁をなめらかにする)
    fn coverage(px: u32, py: u32, cx: f64, cy: f64, r: f64) -> f64 {
        let mut n = 0;
        for sy in 0..4 {
            for sx in 0..4 {
                let x = px as f64 + (sx as f64 + 0.5) / 4.0;
                let y = py as f64 + (sy as f64 + 0.5) / 4.0;
                if (x - cx).powi(2) + (y - cy).powi(2) <= r * r {
                    n += 1;
                }
            }
        }
        n as f64 / 16.0
    }

    /// テンプレート (アルファだけ意味がある RGBA) をタスクバーの明暗の色で塗り、エラーなら右上に赤い点を重ねる。
    /// 点の大きさ・位置・周りの切り抜きはメニューバー (macos/status_icon.rs) と同じ比率 (18pt 中の半径 3.5pt・縁 1.5pt)
    pub fn render(rgba: &[u8], width: u32, height: u32, dark: bool, red_dot: bool) -> Vec<u8> {
        let fg = if dark { 255u8 } else { 0u8 };
        let mut out = rgba.to_vec();
        for px in out.as_chunks_mut::<4>().0 {
            px[0] = fg;
            px[1] = fg;
            px[2] = fg;
        }
        if red_dot {
            let unit = width.min(height) as f64 / 18.0;
            let r = 3.5 * unit;
            let ring = r + 1.5 * unit;
            let (cx, cy) = (width as f64 - r, r);
            for y in 0..height {
                for x in 0..width {
                    let i = ((y * width + x) * 4) as usize;
                    let clear = coverage(x, y, cx, cy, ring);
                    let a = out[i + 3] as f64 * (1.0 - clear);
                    let dot = coverage(x, y, cx, cy, r);
                    // 赤を上に重ねる (アルファ合成)
                    let out_a = dot * 255.0 + a * (1.0 - dot);
                    for c in 0..3 {
                        let base = out[i + c] as f64 * a;
                        let v = if out_a > 0.0 {
                            (RED[c] as f64 * 255.0 * dot + base * (1.0 - dot)) / out_a
                        } else {
                            0.0
                        };
                        out[i + c] = v.round().clamp(0.0, 255.0) as u8;
                    }
                    out[i + 3] = out_a.round().clamp(0.0, 255.0) as u8;
                }
            }
        }
        out
    }

    /// 状態ごとの画像をトレイに設定する (メインスレッドで呼ぶ)
    pub fn set_icon(tray: &tauri::tray::TrayIcon, icon: StatusIcon, dark: bool) -> Result<()> {
        let (png, red_dot) = match icon {
            StatusIcon::Template(png) => (png, false),
            StatusIcon::WithRedDot { png, .. } => (png, true),
        };
        let image = tauri::image::Image::from_bytes(png.x2).context("アイコンを読めません")?;
        let (w, h) = (image.width(), image.height());
        let rgba = render(image.rgba(), w, h, dark, red_dot);
        tray.set_icon(Some(tauri::image::Image::new_owned(rgba, w, h)))
            .context("アイコンを設定できません")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mic_denied_if_any_switch_is_off() {
        let s = |v: &str| Ok(Some(v.to_string()));
        assert_eq!(
            mic_authorization_from(&[s("Allow"), s("Allow"), s("Allow")]),
            MicAuthorization::Granted
        );
        assert_eq!(
            mic_authorization_from(&[Ok(None), Ok(None), Ok(None)]),
            MicAuthorization::Granted
        );
        assert_eq!(
            mic_authorization_from(&[s("Allow"), s("Allow"), s("Deny")]),
            MicAuthorization::Denied
        );
        assert_eq!(
            mic_authorization_from(&[s("deny"), Ok(None), Err(())]),
            MicAuthorization::Denied
        );
        assert_eq!(
            mic_authorization_from(&[s("Allow"), Err(()), Ok(None)]),
            MicAuthorization::NotDetermined
        );
    }

    #[test]
    fn key_combo_maps_cmd_to_win_and_option_to_alt() {
        let k = |key, modifiers: Vec<Modifier>| KeyCombo { key, modifiers };
        assert_eq!(key_combo_vks(&k(Key::Enter, vec![])), (vec![], VK_RETURN));
        assert_eq!(
            key_combo_vks(&k(
                Key::Enter,
                vec![Modifier::Cmd, Modifier::Shift, Modifier::Ctrl]
            )),
            (vec![VK_CONTROL, VK_SHIFT, VK_LWIN], VK_RETURN)
        );
        assert_eq!(
            key_combo_vks(&k(Key::Backspace, vec![Modifier::Option])),
            (vec![VK_MENU], VK_BACK)
        );
        assert_eq!(key_combo_vks(&k(Key::Tab, vec![])).1, VK_TAB);
        assert_eq!(key_combo_vks(&k(Key::Escape, vec![])).1, VK_ESCAPE);
    }

    #[test]
    fn multi_sz_splits_until_double_nul() {
        let buf: Vec<u16> = "ja-JP\0en-US\0\0x".encode_utf16().collect();
        assert_eq!(split_multi_sz(&buf), vec!["ja-JP", "en-US"]);
        assert!(split_multi_sz(&[0, 0]).is_empty());
    }

    #[test]
    fn tray_icon_is_recolored_and_gets_a_red_dot() {
        // 36x36 の全面不透明 (アルファ 255) のテンプレート
        let (w, h) = (36u32, 36u32);
        let rgba = [0u8, 0, 0, 255].repeat((w * h) as usize);
        let light = tray::render(&rgba, w, h, false, false);
        assert!(light
            .as_chunks::<4>()
            .0
            .iter()
            .all(|p| *p == [0, 0, 0, 255]));
        let dark = tray::render(&rgba, w, h, true, false);
        assert!(dark
            .as_chunks::<4>()
            .0
            .iter()
            .all(|p| *p == [255, 255, 255, 255]));
        let err = tray::render(&rgba, w, h, true, true);
        let at = |x: u32, y: u32| &err[((y * w + x) * 4) as usize..][..4];
        // 点の中心 (右上から半径 7px) は赤
        assert_eq!(at(29, 7), [0xFF, 0x3B, 0x30, 255]);
        // 点の周りの縁は切り抜かれて透明
        assert_eq!(at(29, 15)[3], 0);
        // 左下は元のまま
        assert_eq!(at(2, 33), [255, 255, 255, 255]);
    }
}
