//! 前面アプリ・起動中のアプリ (Windows)。
//!
//! アプリの識別子 (`FrontApp.bundle_id`・`excludedApps[].bundleId`) は実行ファイル名の小文字 (例 `notepad.exe`)。
//! 表示名は実行ファイルのバージョン情報の `FileDescription` (無ければ実行ファイル名)。
//! ストアアプリ (UWP) の前面ウィンドウは ApplicationFrameHost.exe の枠なので、中の子ウィンドウの
//! プロセス (本体) を見る。

use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::{Mutex, OnceLock};

use windows::core::{BOOL, HSTRING, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, LPARAM};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::Security::{
    GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TokenIntegrityLevel,
    TOKEN_MANDATORY_LABEL, TOKEN_QUERY,
};
use windows::Win32::Storage::FileSystem::{
    GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW,
};
use windows::Win32::System::Threading::{
    GetCurrentProcess, GetCurrentProcessId, OpenProcess, OpenProcessToken,
    QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumChildWindows, EnumWindows, GetClassNameW, GetForegroundWindow, GetWindow,
    GetWindowLongPtrW, GetWindowTextLengthW, GetWindowThreadProcessId, IsWindowVisible,
    GWL_EXSTYLE, GW_OWNER, WS_EX_TOOLWINDOW,
};

use crate::insert::FrontApp;

/// ストアアプリの枠のプロセス
const FRAME_HOST: &str = "applicationframehost.exe";

/// 実行ファイルのパス → 表示名 (バージョン情報の読み取りは毎回だと遅いため覚えておく)
fn name_cache() -> &'static Mutex<HashMap<String, String>> {
    static CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn pid_of(hwnd: HWND) -> u32 {
    let mut pid = 0;
    // SAFETY: 問い合わせのみ
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    pid
}

/// 開いたプロセスのハンドル (Drop で閉じる)
struct Process(HANDLE);

impl Process {
    fn open(pid: u32) -> windows::core::Result<Self> {
        // SAFETY: 問い合わせだけの権限で開く (他のユーザー・管理者のプロセスでも開けることが多い)
        unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.map(Self)
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        // SAFETY: open で得たハンドル
        let _ = unsafe { CloseHandle(self.0) };
    }
}

/// プロセスの実行ファイルのフルパス
fn image_path(pid: u32) -> Option<String> {
    let p = Process::open(pid).ok()?;
    let mut buf = vec![0u16; 32 * 1024];
    let mut len = buf.len() as u32;
    // SAFETY: buf の長さを len で渡す
    unsafe {
        QueryFullProcessImageNameW(p.0, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len)
    }
    .ok()?;
    Some(String::from_utf16_lossy(&buf[..len as usize]))
}

/// パスから識別子 (実行ファイル名の小文字)
pub fn exe_id(path: &str) -> String {
    path.rsplit(['\\', '/'])
        .next()
        .unwrap_or(path)
        .to_lowercase()
}

/// 表示名の候補にする言語・コードページ (バージョン情報の Translation が無い時)
const FALLBACK_TRANSLATIONS: [(u16, u16); 3] =
    [(0x0409, 0x04B0), (0x0409, 0x04E4), (0x0411, 0x04B0)];

/// バージョン情報の FileDescription
fn file_description(path: &str) -> Option<String> {
    let wpath = HSTRING::from(path);
    // SAFETY: 確保した buf にバージョン情報を読み、VerQueryValueW が返す buf 内のポインタだけを読む
    unsafe {
        let size = GetFileVersionInfoSizeW(&wpath, None);
        if size == 0 {
            return None;
        }
        let mut buf = vec![0u8; size as usize];
        GetFileVersionInfoW(&wpath, None, size, buf.as_mut_ptr() as *mut c_void).ok()?;
        let block = buf.as_ptr() as *const c_void;

        let mut translations: Vec<(u16, u16)> = Vec::new();
        let mut p: *mut c_void = std::ptr::null_mut();
        let mut len = 0u32;
        if VerQueryValueW(
            block,
            &HSTRING::from("\\VarFileInfo\\Translation"),
            &mut p,
            &mut len,
        )
        .as_bool()
            && !p.is_null()
        {
            let n = len as usize / 4;
            let words = std::slice::from_raw_parts(p as *const u16, n * 2);
            translations.extend(
                words
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .map(|[lang, cp]| (*lang, *cp)),
            );
        }
        translations.extend(FALLBACK_TRANSLATIONS);
        for (lang, cp) in translations {
            let key = HSTRING::from(format!(
                "\\StringFileInfo\\{lang:04x}{cp:04x}\\FileDescription"
            ));
            let mut p: *mut c_void = std::ptr::null_mut();
            let mut len = 0u32;
            if VerQueryValueW(block, &key, &mut p, &mut len).as_bool() && !p.is_null() && len > 0 {
                let s = std::slice::from_raw_parts(p as *const u16, len as usize);
                let s = String::from_utf16_lossy(s);
                let s = s.trim_end_matches('\0').trim();
                if !s.is_empty() {
                    return Some(s.to_string());
                }
            }
        }
        None
    }
}

/// 表示名 (FileDescription、無ければ拡張子を除いた実行ファイル名)
fn display_name(path: &str) -> String {
    let mut cache = name_cache().lock().unwrap_or_else(|p| p.into_inner());
    if let Some(n) = cache.get(path) {
        return n.clone();
    }
    let name = file_description(path).unwrap_or_else(|| fallback_name(path));
    cache.insert(path.to_string(), name.clone());
    name
}

/// 実行ファイル名から拡張子を除いたもの (表示名が取れない時)
fn fallback_name(path: &str) -> String {
    let file = path.rsplit(['\\', '/']).next().unwrap_or(path);
    match file.rsplit_once('.') {
        Some((stem, ext)) if ext.eq_ignore_ascii_case("exe") && !stem.is_empty() => stem.into(),
        _ => file.into(),
    }
}

/// ストアアプリの枠なら中の本体のプロセス
fn content_pid(hwnd: HWND, pid: u32) -> u32 {
    let is_frame = image_path(pid).is_some_and(|p| exe_id(&p) == FRAME_HOST);
    if !is_frame {
        return pid;
    }
    struct Ctx {
        frame_pid: u32,
        found: Option<u32>,
    }
    unsafe extern "system" fn cb(h: HWND, l: LPARAM) -> BOOL {
        // SAFETY: l は下の ctx を指す
        let ctx = unsafe { &mut *(l.0 as *mut Ctx) };
        let pid = pid_of(h);
        if pid != ctx.frame_pid && pid != 0 {
            ctx.found = Some(pid);
            return BOOL(0);
        }
        BOOL(1)
    }
    let mut ctx = Ctx {
        frame_pid: pid,
        found: None,
    };
    // SAFETY: コールバックは列挙の間だけ ctx を使う
    let _ =
        unsafe { EnumChildWindows(Some(hwnd), Some(cb), LPARAM(&mut ctx as *mut Ctx as isize)) };
    ctx.found.unwrap_or(pid)
}

fn app_of_window(hwnd: HWND) -> Option<(u32, FrontApp)> {
    let pid = content_pid(hwnd, pid_of(hwnd));
    let path = image_path(pid)?;
    Some((
        pid,
        FrontApp {
            name: display_name(&path),
            bundle_id: Some(exe_id(&path)),
        },
    ))
}

pub fn frontmost_app() -> Option<FrontApp> {
    // SAFETY: 問い合わせのみ
    let fg = unsafe { GetForegroundWindow() };
    if fg.0.is_null() {
        return None;
    }
    app_of_window(fg).map(|(_, a)| a)
}

/// タスクバーに出るような通常のウィンドウか
fn is_app_window(h: HWND) -> bool {
    // SAFETY: 問い合わせのみ
    unsafe {
        if !IsWindowVisible(h).as_bool() || GetWindowTextLengthW(h) == 0 {
            return false;
        }
        if GetWindow(h, GW_OWNER).is_ok_and(|o| !o.0.is_null()) {
            return false;
        }
        let ex = GetWindowLongPtrW(h, GWL_EXSTYLE) as u32;
        if ex & WS_EX_TOOLWINDOW.0 != 0 {
            return false;
        }
        // 隠れたストアアプリ・別の仮想デスクトップのウィンドウは cloaked
        let mut cloaked = 0u32;
        if DwmGetWindowAttribute(
            h,
            DWMWA_CLOAKED,
            &mut cloaked as *mut u32 as *mut c_void,
            std::mem::size_of::<u32>() as u32,
        )
        .is_ok()
            && cloaked != 0
        {
            return false;
        }
        let mut class = [0u16; 64];
        let n = GetClassNameW(h, &mut class);
        let class = String::from_utf16_lossy(&class[..n.max(0) as usize]);
        // デスクトップ・タスクバー
        !matches!(
            class.as_str(),
            "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd"
        )
    }
}

/// 起動中のアプリ (入力しないアプリの候補)。可視のトップレベルウィンドウを持つもの (自分を除く)
pub fn running_apps() -> Vec<FrontApp> {
    unsafe extern "system" fn cb(h: HWND, l: LPARAM) -> BOOL {
        // SAFETY: l は下の windows を指す
        let out = unsafe { &mut *(l.0 as *mut Vec<HWND>) };
        if is_app_window(h) {
            out.push(h);
        }
        BOOL(1)
    }
    let mut windows: Vec<HWND> = Vec::new();
    // SAFETY: コールバックは列挙の間だけ windows を使う
    let _ = unsafe { EnumWindows(Some(cb), LPARAM(&mut windows as *mut Vec<HWND> as isize)) };
    // SAFETY: 問い合わせのみ
    let own = unsafe { GetCurrentProcessId() };
    let mut out: Vec<FrontApp> = windows
        .into_iter()
        .filter_map(app_of_window)
        .filter(|(pid, _)| *pid != own)
        .map(|(_, a)| a)
        .collect();
    // 同じアプリの複数のウィンドウは 1 つにする
    out.sort_by(|a, b| a.bundle_id.cmp(&b.bundle_id));
    out.dedup_by(|a, b| a.bundle_id == b.bundle_id);
    out.sort_by_key(|a| a.name.to_lowercase());
    out
}

// ---- 管理者として動いているアプリ (UIPI) ----------------------------------------

/// プロセスの整合性レベル (SECURITY_MANDATORY_*_RID)。読めなければ None
fn integrity_level(process: HANDLE) -> Option<u32> {
    // SAFETY: 開いたトークンは閉じる。GetTokenInformation は必要な長さを問い合わせてから読む
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(process, TOKEN_QUERY, &mut token).ok()?;
        let token = Process(token);
        let mut len = 0u32;
        let _ = GetTokenInformation(token.0, TokenIntegrityLevel, None, 0, &mut len);
        if len == 0 {
            return None;
        }
        // TOKEN_MANDATORY_LABEL はポインタを含むため 8 バイト境界の領域に読む
        let mut buf = vec![0u64; (len as usize).div_ceil(8)];
        GetTokenInformation(
            token.0,
            TokenIntegrityLevel,
            Some(buf.as_mut_ptr() as *mut c_void),
            len,
            &mut len,
        )
        .ok()?;
        let label = &*(buf.as_ptr() as *const TOKEN_MANDATORY_LABEL);
        let sid = label.Label.Sid;
        let count = *GetSidSubAuthorityCount(sid);
        if count == 0 {
            return None;
        }
        Some(*GetSidSubAuthority(sid, u32::from(count) - 1))
    }
}

/// 前面のアプリがこのアプリより高い整合性レベル (管理者として実行) で動いているか。
/// その場合 SendInput は UIPI で届かず、失敗も返らない (SendInput のドキュメント) ため、送る前に確かめる。
/// 前面のプロセスを開けない・レベルを読めない時も高いとみなす (同じレベルなら開けるため)
pub fn foreground_is_elevated() -> bool {
    // SAFETY: 問い合わせのみ
    let fg = unsafe { GetForegroundWindow() };
    if fg.0.is_null() {
        return false;
    }
    let pid = pid_of(fg);
    // SAFETY: 自分のプロセスの疑似ハンドル (閉じなくてよい)
    let Some(own) = integrity_level(unsafe { GetCurrentProcess() }) else {
        return false;
    };
    let other = Process::open(pid).ok().and_then(|p| integrity_level(p.0));
    is_higher(own, other)
}

/// 前面のレベル (読めなければ None) が自分より高いか
fn is_higher(own: u32, other: Option<u32>) -> bool {
    other.is_none_or(|o| o > own)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exe_id_is_lowercase_file_name() {
        assert_eq!(exe_id(r"C:\Windows\System32\NOTEPAD.EXE"), "notepad.exe");
        assert_eq!(exe_id("Code.exe"), "code.exe");
        assert_eq!(exe_id(r"C:\a/b\Slack.exe"), "slack.exe");
    }

    #[test]
    fn fallback_name_drops_exe_extension() {
        assert_eq!(fallback_name(r"C:\x\Foo.exe"), "Foo");
        assert_eq!(fallback_name(r"C:\x\Foo.EXE"), "Foo");
        assert_eq!(fallback_name(r"C:\x\foo.bar"), "foo.bar");
        assert_eq!(fallback_name(".exe"), ".exe");
    }

    #[test]
    fn higher_integrity_or_unknown_is_elevated() {
        // 0x2000 = Medium, 0x3000 = High, 0x4000 = System
        assert!(!is_higher(0x2000, Some(0x2000)));
        assert!(!is_higher(0x2000, Some(0x1000)));
        assert!(is_higher(0x2000, Some(0x3000)));
        assert!(is_higher(0x2000, None));
        assert!(!is_higher(0x3000, Some(0x3000)));
    }

    /// 実機で動くこと (結果は環境による): 自分のプロセスの表示名が取れる
    #[test]
    fn current_exe_has_a_name() {
        let exe = std::env::current_exe().unwrap();
        let path = exe.to_string_lossy();
        assert!(!display_name(&path).is_empty());
        assert!(exe_id(&path).ends_with(".exe"));
    }

    /// 実機の確認用 (手動実行: `cargo test -- --ignored running_apps_smoke --nocapture`)。
    /// 利用者のアプリ名は出さず、件数と形だけ確かめる
    #[test]
    #[ignore]
    fn running_apps_smoke() {
        let apps = running_apps();
        println!("起動中のアプリ: {} 件", apps.len());
        for a in &apps {
            assert!(!a.name.is_empty());
            let id = a.bundle_id.as_deref().unwrap();
            assert_eq!(id, id.to_lowercase());
            assert!(id.ends_with(".exe"), "{id}");
        }
        let mut ids: Vec<_> = apps.iter().map(|a| a.bundle_id.clone()).collect();
        ids.dedup();
        assert_eq!(ids.len(), apps.len(), "同じアプリが重複");
        println!("前面のアプリ: {}", frontmost_app().is_some());
        println!("前面が管理者: {}", foreground_is_elevated());
    }
}
