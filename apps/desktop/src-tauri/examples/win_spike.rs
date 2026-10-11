//! Windows のリスク先行の検証 (docs/plans/windows-plan.md Phase 2a)。実機で手動実行する。
//!
//! ```text
//! cargo run --example win_spike -- drive        # 全項目 (メモ帳を開いて自動で操作し、結果を表示)
//! cargo run --example win_spike -- panel [tauri-menu] [nosub] [focusable]  # パネルだけ (drive が子プロセスとして起動する)
//! ```
//!
//! 1. パネルがフォーカスを奪わない (U8): クリック・ドラッグ・右クリックで前面アプリ・フォーカス・IME の変換中の文字が変わらないか
//! 2. 日本語 IME オンでの貼り付け (U7): 化けない・二重にならない。変換中の文字がある時の挙動を記録
//! 3. クリップボードの復元 (U7): 全形式 (テキスト・画像・ファイル・独自形式) が戻るか、履歴 (Win+V) に残らないか
//!
//! 入力先は自分で作ったファイルを開いたメモ帳だけ。利用者のクリップボードは最初に退避して最後に戻す。
//! 入力した文字・クリップボードの中身は表示しない (一致したかだけ表示する)。
//! 貼り付け・キー送信・パネルの設定はアプリ本体と同じコード (`src/platform/windows/{clipboard,keys,panel}.rs`) を使う。
//! 右クリックメニューは本体と同じ「前面化しない TrackPopupMenu」と、対照として Tauri (muda) の popup_menu を試す。

#[cfg(not(windows))]
fn main() {}

#[cfg(windows)]
fn main() {
    spike::main();
}

#[cfg(windows)]
#[path = "../src/platform/windows/clipboard.rs"]
#[allow(dead_code)]
mod clipboard;

#[cfg(windows)]
#[path = "../src/platform/windows/keys.rs"]
#[allow(dead_code)]
mod keys;

#[cfg(windows)]
#[path = "../src/platform/windows/panel.rs"]
#[allow(dead_code)]
mod panel_win;

#[cfg(windows)]
mod spike {
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Child, Command, Stdio};
    use std::sync::atomic::{AtomicIsize, Ordering};
    use std::sync::mpsc;
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    use anyhow::{anyhow, bail, Context, Result};
    use windows::core::{w, BOOL, PCWSTR, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, LPARAM, POINT, RECT, WPARAM};
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
    };
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
    use windows::Win32::UI::HiDpi::{
        SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_LEFTDOWN,
        MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP,
        MOUSEEVENTF_VIRTUALDESK, MOUSEINPUT, MOUSE_EVENT_FLAGS, VIRTUAL_KEY, VK_A, VK_CONTROL,
        VK_DELETE, VK_ESCAPE, VK_IME_ON, VK_K, VK_KANJI, VK_RETURN, VK_S, VK_X,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumChildWindows, EnumWindows, FindWindowW, GetClassNameW, GetCursorPos,
        GetForegroundWindow, GetGUIThreadInfo, GetMessageW, GetSystemMetrics, GetWindowLongPtrW,
        GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible, PostMessageW,
        SendMessageTimeoutW, SetCursorPos, SetForegroundWindow, GUITHREADINFO, GWL_EXSTYLE, MSG,
        SMTO_ABORTIFHUNG, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
        SM_YVIRTUALSCREEN, WINEVENT_OUTOFCONTEXT, WM_CANCELMODE, WM_CLOSE, WM_GETTEXT,
        WM_GETTEXTLENGTH,
    };

    use super::{clipboard, keys};

    const DIR: &str = r"C:\mukuchi-spike\p2a";
    const EVENT_SYSTEM_FOREGROUND: u32 = 0x0003;

    pub fn main() {
        let args: Vec<String> = std::env::args().collect();
        let r = match args.get(1).map(String::as_str) {
            Some("panel") => panel::run(PanelMode {
                tauri_menu: args.iter().any(|a| a == "tauri-menu"),
                nosub: args.iter().any(|a| a == "nosub"),
                focusable: args.iter().any(|a| a == "focusable"),
            }),
            Some("drive") => drive(false),
            Some("ime") => drive(true),
            _ => Err(anyhow!(
                "usage: win_spike drive | panel [tauri-menu] [nosub] [focusable]"
            )),
        };
        if let Err(e) = r {
            eprintln!("ERROR: {e:#}");
            std::process::exit(1);
        }
    }

    // ---- ウィンドウ・入力の補助 -------------------------------------------------

    fn class_name(h: HWND) -> String {
        let mut buf = [0u16; 128];
        let n = unsafe { GetClassNameW(h, &mut buf) };
        String::from_utf16_lossy(&buf[..n.max(0) as usize])
    }

    fn title(h: HWND) -> String {
        let mut buf = [0u16; 512];
        let n = unsafe { GetWindowTextW(h, &mut buf) };
        String::from_utf16_lossy(&buf[..n.max(0) as usize])
    }

    fn pid_of(h: HWND) -> u32 {
        let mut pid = 0;
        unsafe { GetWindowThreadProcessId(h, Some(&mut pid)) };
        pid
    }

    fn exe_of(pid: u32) -> String {
        unsafe {
            let Ok(p) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                return "?".into();
            };
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            let r = QueryFullProcessImageNameW(
                p,
                PROCESS_NAME_WIN32,
                PWSTR(buf.as_mut_ptr()),
                &mut len,
            );
            let _ = CloseHandle(p);
            if r.is_err() {
                return "?".into();
            }
            let path = String::from_utf16_lossy(&buf[..len as usize]);
            path.rsplit('\\').next().unwrap_or("?").to_lowercase()
        }
    }

    fn describe(h: HWND) -> String {
        if h.0.is_null() {
            return "(none)".into();
        }
        format!("{:?} {} [{}]", h.0, class_name(h), exe_of(pid_of(h)))
    }

    /// 前面のスレッドのフォーカス・キャレット
    fn gui_info(h: HWND) -> (HWND, HWND) {
        let tid = unsafe { GetWindowThreadProcessId(h, None) };
        let mut gi = GUITHREADINFO {
            cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
            ..Default::default()
        };
        if unsafe { GetGUIThreadInfo(tid, &mut gi) }.is_err() {
            return (HWND::default(), HWND::default());
        }
        (gi.hwndFocus, gi.hwndCaret)
    }

    fn send_inputs(inputs: &[INPUT]) {
        unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
    }

    /// 入力先 (自分で開いたメモ帳)。キー・マウスを送る前に前面がこれか確かめ、違えば中止する
    /// (利用者が操作を始めた・別のウィンドウが前面に来た時に、他のアプリへ入力しないため)
    static TARGET: AtomicIsize = AtomicIsize::new(0);

    fn guard() -> Result<()> {
        let fg = unsafe { GetForegroundWindow() };
        if fg.0 as isize != TARGET.load(Ordering::SeqCst) {
            bail!(
                "前面がメモ帳ではないため中止します (前面: {})",
                describe(fg)
            );
        }
        Ok(())
    }

    fn key(vk: VIRTUAL_KEY) -> Result<()> {
        guard()?;
        keys::send_chord(&[], vk)?;
        std::thread::sleep(Duration::from_millis(60));
        Ok(())
    }

    fn chord(mods: &[VIRTUAL_KEY], vk: VIRTUAL_KEY) -> Result<()> {
        guard()?;
        keys::send_chord(mods, vk)?;
        std::thread::sleep(Duration::from_millis(60));
        Ok(())
    }

    fn paste(text: &str) -> Result<clipboard::PasteReport> {
        guard()?;
        clipboard::paste_text(text, keys::send_paste)
    }

    fn mouse(flags: MOUSE_EVENT_FLAGS, x: i32, y: i32) {
        // 仮想スクリーン全体を 0..65535 に正規化した絶対座標
        let (vx, vy, vw, vh) = unsafe {
            (
                GetSystemMetrics(SM_XVIRTUALSCREEN),
                GetSystemMetrics(SM_YVIRTUALSCREEN),
                GetSystemMetrics(SM_CXVIRTUALSCREEN),
                GetSystemMetrics(SM_CYVIRTUALSCREEN),
            )
        };
        let nx = ((x - vx) as i64 * 65535 / (vw - 1).max(1) as i64) as i32;
        let ny = ((y - vy) as i64 * 65535 / (vh - 1).max(1) as i64) as i32;
        send_inputs(&[INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx: nx,
                    dy: ny,
                    mouseData: 0,
                    dwFlags: flags
                        | MOUSEEVENTF_MOVE
                        | MOUSEEVENTF_ABSOLUTE
                        | MOUSEEVENTF_VIRTUALDESK,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }]);
    }

    /// 前面を確かめずにクリックする (前面が移った後の後始末用。クリック先は自分のウィンドウに限る)
    fn mouse_click(x: i32, y: i32) {
        mouse(MOUSE_EVENT_FLAGS(0), x, y);
        std::thread::sleep(Duration::from_millis(80));
        mouse(MOUSEEVENTF_LEFTDOWN, x, y);
        std::thread::sleep(Duration::from_millis(80));
        mouse(MOUSEEVENTF_LEFTUP, x, y);
    }

    fn keys_input(vk: VIRTUAL_KEY, up: bool) -> INPUT {
        use windows::Win32::UI::Input::KeyboardAndMouse::{
            INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
        };
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: 0,
                    dwFlags: if up {
                        KEYEVENTF_KEYUP
                    } else {
                        KEYBD_EVENT_FLAGS(0)
                    },
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    /// メモ帳を前面に戻す (SetForegroundWindow が拒まれたらメモ帳のタイトルバーをクリックする)
    fn refocus(notepad: HWND) {
        if unsafe { GetForegroundWindow() } == notepad {
            return;
        }
        // 前面化の制限を外すため Alt を押して離してから SetForegroundWindow (tao と同じ方法)
        send_inputs(&[
            keys_input(VIRTUAL_KEY(0x12), false),
            keys_input(VIRTUAL_KEY(0x12), true),
        ]);
        let _ = unsafe { SetForegroundWindow(notepad) };
        std::thread::sleep(Duration::from_millis(300));
        if unsafe { GetForegroundWindow() } != notepad {
            let r = window_rect(notepad);
            mouse_click((r.left + r.right) / 2, r.top + 12);
            std::thread::sleep(Duration::from_millis(300));
        }
        println!(
            "  (メモ帳を前面に戻した: {})",
            unsafe { GetForegroundWindow() } == notepad
        );
    }

    fn click(x: i32, y: i32) -> Result<()> {
        guard()?;
        mouse(MOUSE_EVENT_FLAGS(0), x, y);
        std::thread::sleep(Duration::from_millis(80));
        mouse(MOUSEEVENTF_LEFTDOWN, x, y);
        std::thread::sleep(Duration::from_millis(80));
        mouse(MOUSEEVENTF_LEFTUP, x, y);
        Ok(())
    }

    fn right_click(x: i32, y: i32) -> Result<()> {
        guard()?;
        mouse(MOUSE_EVENT_FLAGS(0), x, y);
        std::thread::sleep(Duration::from_millis(80));
        mouse(MOUSEEVENTF_RIGHTDOWN, x, y);
        std::thread::sleep(Duration::from_millis(80));
        mouse(MOUSEEVENTF_RIGHTUP, x, y);
        Ok(())
    }

    fn drag(x: i32, y: i32, dx: i32, dy: i32) -> Result<()> {
        guard()?;
        mouse(MOUSE_EVENT_FLAGS(0), x, y);
        std::thread::sleep(Duration::from_millis(80));
        mouse(MOUSEEVENTF_LEFTDOWN, x, y);
        std::thread::sleep(Duration::from_millis(80));
        for i in 1..=20 {
            mouse(MOUSE_EVENT_FLAGS(0), x + dx * i / 20, y + dy * i / 20);
            std::thread::sleep(Duration::from_millis(20));
        }
        std::thread::sleep(Duration::from_millis(100));
        mouse(MOUSEEVENTF_LEFTUP, x + dx, y + dy);
        Ok(())
    }

    fn window_rect(h: HWND) -> RECT {
        let mut r = RECT::default();
        let _ = unsafe { GetWindowRect(h, &mut r) };
        r
    }

    /// 可視のトップレベルでタイトルに `needle` を含むもの
    fn find_window(needle: &str) -> Option<HWND> {
        struct Ctx<'a> {
            needle: &'a str,
            found: Option<HWND>,
        }
        unsafe extern "system" fn cb(h: HWND, l: LPARAM) -> BOOL {
            let ctx = unsafe { &mut *(l.0 as *mut Ctx) };
            if unsafe { IsWindowVisible(h) }.as_bool() && title(h).contains(ctx.needle) {
                ctx.found = Some(h);
                return BOOL(0);
            }
            BOOL(1)
        }
        let mut ctx = Ctx {
            needle,
            found: None,
        };
        let _ = unsafe { EnumWindows(Some(cb), LPARAM(&mut ctx as *mut Ctx as isize)) };
        ctx.found
    }

    /// メモ帳の編集領域 (旧: Edit、Windows 11: RichEditD2DPT)
    fn find_editor(top: HWND) -> Option<HWND> {
        unsafe extern "system" fn cb(h: HWND, l: LPARAM) -> BOOL {
            let out = unsafe { &mut *(l.0 as *mut Option<HWND>) };
            let c = class_name(h);
            if c == "Edit" || c.starts_with("RichEdit") {
                *out = Some(h);
                return BOOL(0);
            }
            BOOL(1)
        }
        let mut out = None;
        let _ =
            unsafe { EnumChildWindows(Some(top), Some(cb), LPARAM(&mut out as *mut _ as isize)) };
        out
    }

    fn editor_text(edit: HWND) -> String {
        unsafe {
            let mut len = 0usize;
            let _ = SendMessageTimeoutW(
                edit,
                WM_GETTEXTLENGTH,
                WPARAM(0),
                LPARAM(0),
                SMTO_ABORTIFHUNG,
                1000,
                Some(&mut len),
            );
            let mut buf = vec![0u16; len + 1];
            let mut got = 0usize;
            let _ = SendMessageTimeoutW(
                edit,
                WM_GETTEXT,
                WPARAM(buf.len()),
                LPARAM(buf.as_mut_ptr() as isize),
                SMTO_ABORTIFHUNG,
                1000,
                Some(&mut got),
            );
            String::from_utf16_lossy(&buf[..got.min(len)])
        }
    }

    // ---- 前面の変化の監視 (WinEvent) -------------------------------------------

    static FG_LOG: Mutex<Vec<(Instant, usize)>> = Mutex::new(Vec::new());

    unsafe extern "system" fn on_foreground(
        _hook: HWINEVENTHOOK,
        _event: u32,
        hwnd: HWND,
        _id_object: i32,
        _id_child: i32,
        _thread: u32,
        _time: u32,
    ) {
        if let Ok(mut l) = FG_LOG.lock() {
            l.push((Instant::now(), hwnd.0 as usize));
        }
    }

    fn start_foreground_monitor() {
        std::thread::spawn(|| unsafe {
            let hook = SetWinEventHook(
                EVENT_SYSTEM_FOREGROUND,
                EVENT_SYSTEM_FOREGROUND,
                None,
                Some(on_foreground),
                0,
                0,
                WINEVENT_OUTOFCONTEXT,
            );
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {}
            let _ = UnhookWinEvent(hook);
        });
    }

    fn foreground_events_since(t: Instant) -> Vec<usize> {
        FG_LOG
            .lock()
            .map(|l| {
                l.iter()
                    .filter(|(at, _)| *at >= t)
                    .map(|(_, h)| *h)
                    .collect()
            })
            .unwrap_or_default()
    }

    // ---- 検証用のクリップボードの内容 -------------------------------------------

    unsafe fn put(format: u32, bytes: &[u8]) -> Result<()> {
        let h = unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes.len()) }?;
        let p = unsafe { GlobalLock(h) };
        unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), p as *mut u8, bytes.len()) };
        let _ = unsafe { GlobalUnlock(h) };
        unsafe { SetClipboardData(format, Some(HANDLE(h.0))) }?;
        Ok(())
    }

    /// テキスト・画像 (CF_DIB 2x2)・ファイル (CF_HDROP)・独自形式を置く (利用者がコピーした内容の代わり)
    fn put_mixed_clipboard(file: &str) -> Result<()> {
        unsafe {
            OpenClipboard(None)?;
            let r = (|| -> Result<()> {
                EmptyClipboard()?;
                let text: Vec<u8> = "ORIGINAL テキスト"
                    .encode_utf16()
                    .chain([0])
                    .flat_map(|u| u.to_le_bytes())
                    .collect();
                put(13, &text)?;
                // BITMAPINFOHEADER (40 バイト) + 2x2 32bpp
                let mut dib = Vec::new();
                for v in [40i32, 2, 2] {
                    dib.extend(v.to_le_bytes());
                }
                dib.extend(1u16.to_le_bytes());
                dib.extend(32u16.to_le_bytes());
                dib.extend([0u8; 24]);
                dib.extend([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 9, 9, 9, 255]);
                put(8, &dib)?;
                // DROPFILES { pFiles=20, pt, fNC, fWide=1 } + パスの並び (二重 NUL)
                let mut drop = Vec::new();
                drop.extend(20u32.to_le_bytes());
                drop.extend([0u8; 12]);
                drop.extend(1u32.to_le_bytes());
                for u in file.encode_utf16().chain([0, 0]) {
                    drop.extend(u.to_le_bytes());
                }
                put(15, &drop)?;
                let custom = RegisterClipboardFormatW(w!("MukuchiSpikeFormat"));
                put(custom, &[1, 2, 3, 4, 5])?;
                // 検証用の内容を利用者のクリップボードの履歴に残さない
                for name in [
                    w!("ExcludeClipboardContentFromMonitorProcessing"),
                    w!("CanIncludeInClipboardHistory"),
                    w!("CanUploadToCloudClipboard"),
                ] {
                    put(RegisterClipboardFormatW(name), &0u32.to_le_bytes())?;
                }
                Ok(())
            })();
            let _ = CloseClipboard();
            r
        }
    }

    /// 2 つの退避の内容が全形式で同じか (違う形式の番号を返す)
    fn diff_snapshots(a: &clipboard::Snapshot, b: &clipboard::Snapshot) -> Vec<String> {
        let mut out = Vec::new();
        for (f, _) in a.summary() {
            if a.bytes_of(f) != b.bytes_of(f) {
                out.push(format!(
                    "{f}{}",
                    clipboard::format_name(f)
                        .map(|n| format!("({n})"))
                        .unwrap_or_default()
                ));
            }
        }
        for (f, _) in b.summary() {
            if a.bytes_of(f).is_none() {
                out.push(format!(
                    "+{f}{}",
                    clipboard::format_name(f)
                        .map(|n| format!("({n})"))
                        .unwrap_or_default()
                ));
            }
        }
        out
    }

    fn describe_snapshot(s: &clipboard::Snapshot) -> String {
        s.summary()
            .iter()
            .map(|(f, n)| {
                format!(
                    "{f}{}:{n}B",
                    clipboard::format_name(*f)
                        .map(|n| format!("({n})"))
                        .unwrap_or_default()
                )
            })
            .collect::<Vec<_>>()
            .join(" ")
    }

    // ---- クリップボードの履歴 (Win+V) ------------------------------------------

    /// 履歴の件数と、`needle` と同じテキストの項目があるか (中身は表示しない)
    fn history_contains(needle: &str) -> Result<(usize, bool)> {
        let needle = needle.to_string();
        in_sta(move || history_contains_sta(&needle))
    }

    /// WinRT のクリップボードの API は STA でしか作れないため、STA のスレッドで呼ぶ
    fn in_sta<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
        std::thread::spawn(move || {
            use windows::Win32::System::Com::{
                CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED,
            };
            unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()? };
            let r = f();
            unsafe { CoUninitialize() };
            r
        })
        .join()
        .map_err(|_| anyhow!("スレッドが落ちました"))?
    }

    fn history_contains_sta(needle: &str) -> Result<(usize, bool)> {
        use windows::ApplicationModel::DataTransfer::{Clipboard, StandardDataFormats};
        let res = Clipboard::GetHistoryItemsAsync()?.join()?;
        let items = res.Items()?;
        let n = items.Size()? as usize;
        let mut found = false;
        for i in 0..n.min(20) {
            let item = items.GetAt(i as u32)?;
            let content = item.Content()?;
            if content.Contains(&StandardDataFormats::Text()?)? {
                let t = content.GetTextAsync()?.join()?;
                if t == needle {
                    found = true;
                }
            }
        }
        Ok((n, found))
    }

    // ---- 本体 ------------------------------------------------------------------

    struct Panel {
        child: Child,
        lines: mpsc::Receiver<String>,
        hwnd: HWND,
        button: (i32, i32),
        grip: (i32, i32),
    }

    /// パネルの作り方 (本体と同じ / 対照)
    #[derive(Debug, Clone, Copy, Default)]
    pub struct PanelMode {
        /// 右クリックを Tauri 標準の popup_menu (muda) で出す
        pub tauri_menu: bool,
        /// サブクラスを付けない
        pub nosub: bool,
        /// focusable(true) (WS_EX_NOACTIVATE を付けない)
        pub focusable: bool,
    }

    impl Panel {
        fn spawn(mode: PanelMode) -> Result<Self> {
            let exe = std::env::current_exe()?;
            let mut cmd = Command::new(exe);
            cmd.arg("panel");
            for (on, arg) in [
                (mode.tauri_menu, "tauri-menu"),
                (mode.nosub, "nosub"),
                (mode.focusable, "focusable"),
            ] {
                if on {
                    cmd.arg(arg);
                }
            }
            let mut child = cmd.stdout(Stdio::piped()).spawn()?;
            let out = child.stdout.take().context("stdout")?;
            let (tx, rx) = mpsc::channel();
            std::thread::spawn(move || {
                for line in BufReader::new(out).lines().map_while(Result::ok) {
                    let _ = tx.send(line);
                }
            });
            let deadline = Instant::now() + Duration::from_secs(60);
            loop {
                let line = rx
                    .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                    .context("パネルが起動しません")?;
                if let Some(rest) = line.strip_prefix("READY ") {
                    let v: Vec<i64> = rest
                        .split_whitespace()
                        .filter_map(|s| s.split('=').nth(1)?.parse().ok())
                        .collect();
                    let [hwnd, bx, by, gx, gy] = v[..] else {
                        bail!("READY の形式: {line}");
                    };
                    return Ok(Self {
                        child,
                        lines: rx,
                        hwnd: HWND(hwnd as *mut _),
                        button: (bx as i32, by as i32),
                        grip: (gx as i32, gy as i32),
                    });
                }
                println!("  panel: {line}");
            }
        }

        fn drain(&self) -> Vec<String> {
            self.lines.try_iter().collect()
        }
    }

    impl Drop for Panel {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    struct Restore {
        clip: Option<clipboard::Snapshot>,
        cursor: POINT,
    }

    impl Drop for Restore {
        fn drop(&mut self) {
            if let Some(s) = self.clip.take() {
                match restore_snapshot(&s) {
                    Ok(()) => println!("利用者のクリップボードを戻しました ({} 形式)", s.len()),
                    Err(e) => println!("!! 利用者のクリップボードを戻せません: {e:#}"),
                }
            }
            let _ = unsafe { SetCursorPos(self.cursor.x, self.cursor.y) };
        }
    }

    fn restore_snapshot(s: &clipboard::Snapshot) -> Result<()> {
        clipboard::restore_snapshot(s)
    }

    /// 除外の形式を付けずにテキストだけ置く (対照実験)
    fn put_plain_text(text: &str) -> Result<()> {
        unsafe {
            OpenClipboard(None)?;
            let r = (|| -> Result<()> {
                EmptyClipboard()?;
                let bytes: Vec<u8> = text
                    .encode_utf16()
                    .chain([0])
                    .flat_map(|u| u.to_le_bytes())
                    .collect();
                put(13, &bytes)
            })();
            let _ = CloseClipboard();
            r
        }
    }

    /// 前面がメモ帳のままか。前面の変化 (WinEvent) のうちパネル自身のもの (表示時に出ることがある。
    /// GetForegroundWindow はメモ帳のまま) は参考として分けて出す。フォーカス・キャレットの hwnd は参考
    /// (Windows 11 のメモ帳は内部のウィンドウが入れ替わるため、比較が判定に使えない)
    fn check_fg(label: &str, notepad: HWND, panel: HWND, t: Instant) -> bool {
        let fg = unsafe { GetForegroundWindow() };
        let (focus, caret) = gui_info(fg);
        let (own, others): (Vec<usize>, Vec<usize>) = foreground_events_since(t)
            .into_iter()
            .partition(|h| *h == panel.0 as usize);
        let ok = fg == notepad && others.is_empty();
        println!(
            "  [{}] {label}: 前面={} 前面の変化={:?} (パネル自身のイベント {} 件、参考: フォーカス={} キャレット={:?})",
            if ok { "OK" } else { "NG" },
            describe(fg),
            others
                .iter()
                .map(|h| describe(HWND(*h as *mut _)))
                .collect::<Vec<_>>(),
            own.len(),
            describe(focus),
            caret.0
        );
        ok
    }

    /// 文字キー x を送り、メモ帳に入ったか (パネルの WebView に入っていないか) を確かめる。U8 の本質の確認
    fn key_goes_to_notepad(label: &str, editor: HWND, panel: &Panel) -> Result<bool> {
        let _ = panel.drain();
        let before = editor_text(editor);
        key(VK_X)?;
        std::thread::sleep(Duration::from_millis(300));
        let after = editor_text(editor);
        let panel_keys: Vec<String> = panel
            .drain()
            .into_iter()
            .filter(|l| l.starts_with("KEY"))
            .collect();
        let ok = after.chars().count() == before.chars().count() + 1
            && after.ends_with('x')
            && panel_keys.is_empty();
        println!(
            "  [{}] {label} の直後のキー入力: メモ帳に入った={} パネルが受けたキー={:?}",
            if ok { "OK" } else { "NG" },
            after.chars().count() == before.chars().count() + 1,
            panel_keys
        );
        Ok(ok)
    }

    /// IME をオン (`on`) / オフにする。ka+Enter が「か」になるか (オン) で状態を確かめ、違えば半角/全角
    /// (VK_OEM_AUTO) で切り替える。この PC の IME は VK_IME_ON・VK_KANJI に反応しなかった (`ime` で切り分け)
    fn set_ime(editor: HWND, on: bool) -> Result<bool> {
        for _ in 0..3 {
            clear_editor()?;
            key(VK_K)?;
            key(VK_A)?;
            key(VK_RETURN)?;
            std::thread::sleep(Duration::from_millis(300));
            let is_on = editor_text(editor) == "か";
            clear_editor()?;
            if is_on == on {
                return Ok(true);
            }
            key(VK_OEM_AUTO)?;
            std::thread::sleep(Duration::from_millis(400));
        }
        println!(
            "  !! IME を{}にできません",
            if on { "オン" } else { "オフ" }
        );
        Ok(false)
    }

    fn ensure_ime_on(editor: HWND) -> Result<bool> {
        set_ime(editor, true)
    }

    /// IME をオンにする方法の切り分け (結果の本文を表示する。検証用の文字だけ)
    fn ime_diag(notepad: HWND, editor: HWND) -> Result<()> {
        use windows::Win32::UI::Input::KeyboardAndMouse::GetKeyboardLayout;
        let tid = unsafe { GetWindowThreadProcessId(notepad, None) };
        let (focus, _) = gui_info(notepad);
        let ftid = unsafe { GetWindowThreadProcessId(focus, None) };
        println!(
            "キーボード配列: メモ帳のスレッド {:?} / フォーカスのスレッド {:?}",
            unsafe { GetKeyboardLayout(tid) }.0,
            unsafe { GetKeyboardLayout(ftid) }.0
        );
        // 半角/全角キーは日本語キーボードでは VK_OEM_AUTO / VK_OEM_ENLW (スキャンコード 0x29)。
        // VK_KANJI は Alt+` で出る。IME によって反応するキーが違うため順に試す
        let strategies: [(&str, &dyn Fn() -> Result<()>); 6] = [
            ("VK_IME_ON", &|| key(VK_IME_ON)),
            ("VK_KANJI", &|| key(VK_KANJI)),
            ("VK_OEM_AUTO (半角/全角)", &|| key(VIRTUAL_KEY(0xF3))),
            ("VK_OEM_ENLW (半角/全角)", &|| key(VIRTUAL_KEY(0xF4))),
            ("スキャンコード 0x29 だけ", &|| {
                guard()?;
                scan_only(0x29);
                Ok(())
            }),
            ("Alt+`", &|| chord(&[VIRTUAL_KEY(0x12)], VIRTUAL_KEY(0xC0))),
        ];
        for (name, f) in strategies {
            clear_editor()?;
            f()?;
            std::thread::sleep(Duration::from_millis(500));
            key(VK_K)?;
            key(VK_A)?;
            key(VK_RETURN)?;
            std::thread::sleep(Duration::from_millis(400));
            println!("  {name}: ka+Enter → {:?}", editor_text(editor));
        }
        clear_editor()?;
        let _ = set_ime(editor, false);
        Ok(())
    }

    const VK_OEM_AUTO: VIRTUAL_KEY = VIRTUAL_KEY(0xF3);

    /// 仮想キーなしでスキャンコードだけ送る
    fn scan_only(scan: u16) {
        use windows::Win32::UI::Input::KeyboardAndMouse::{
            INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE,
        };
        let mk = |up: bool| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(0),
                    wScan: scan,
                    dwFlags: if up {
                        KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP
                    } else {
                        KEYEVENTF_SCANCODE
                    },
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        send_inputs(&[mk(false), mk(true)]);
        std::thread::sleep(Duration::from_millis(60));
    }

    /// パネルを右クリックしてメニューを出し、メニューの外のクリックで閉じる。
    /// 閉じなければ WM_CANCELMODE で閉じる。`at` はパネルを動かした量 (物理 px)
    fn right_click_and_dismiss(notepad: HWND, panel: &Panel, at: (i32, i32)) -> Result<()> {
        let t = Instant::now();
        right_click(panel.grip.0 + at.0, panel.grip.1 + at.1)?;
        std::thread::sleep(Duration::from_millis(800));
        let menu = find_menu_window();
        check_fg("右クリック (メニュー表示中)", notepad, panel.hwnd, t);
        println!(
            "  メニューのウィンドウ: {}",
            menu.map(describe).unwrap_or("なし".into())
        );
        // メニューの外 (パネルのボタン。メニューはクリック位置から右下に開く) をクリックする。
        // メモ帳をクリックすると、それ自体がフォーカス・変換に影響するため使わない
        mouse_click(panel.button.0 + at.0, panel.button.1 + at.1);
        std::thread::sleep(Duration::from_millis(500));
        let closed_by_click = find_menu_window().is_none();
        if !closed_by_click {
            let _ = unsafe { PostMessageW(Some(panel.hwnd), WM_CANCELMODE, WPARAM(0), LPARAM(0)) };
            std::thread::sleep(Duration::from_millis(500));
        }
        println!(
            "  [{}] メニューの外のクリックで閉じた={} (閉じた後のメニュー: {}) panel: {:?}",
            if closed_by_click { "OK" } else { "NG" },
            closed_by_click,
            find_menu_window().map(describe).unwrap_or("なし".into()),
            panel.drain()
        );
        check_fg("右クリック (メニューを閉じた後)", notepad, panel.hwnd, t);
        Ok(())
    }

    fn drive(ime_only: bool) -> Result<()> {
        unsafe {
            let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        }
        let mut cursor = POINT::default();
        unsafe { GetCursorPos(&mut cursor) }?;
        // 最初に利用者のクリップボードを退避する (最後に Drop で戻す)
        let user_clip = clipboard::snapshot().context("利用者のクリップボードを退避できません")?;
        println!("利用者のクリップボードを退避 ({} 形式)", user_clip.len());
        let _restore = Restore {
            clip: Some(user_clip),
            cursor,
        };

        if unsafe { FindWindowW(w!("Notepad"), PCWSTR::null()) }.is_ok() {
            bail!("メモ帳が既に開いています。利用者の書類に触れないよう中止します");
        }
        // Windows 11 のメモ帳はセッション (開いていたタブ) を LocalState に残し、次の起動で復元する。
        // 検証の前に無かったものは最後に消す (利用者が次にメモ帳を開いた時に検証のタブを出さない)
        let notepad_state: Vec<std::path::PathBuf> = std::env::var_os("LOCALAPPDATA")
            .map(|d| {
                let base = std::path::Path::new(&d)
                    .join(r"Packages\Microsoft.WindowsNotepad_8wekyb3d8bbwe\LocalState");
                ["TabState", "WindowState"]
                    .iter()
                    .map(|n| base.join(n))
                    .filter(|p| !p.exists())
                    .collect()
            })
            .unwrap_or_default();
        std::fs::create_dir_all(DIR)?;
        let file = format!(r"{DIR}\mukuchi-spike-target.txt");
        std::fs::write(&file, "")?;
        let _ = Command::new("notepad.exe").arg(&file).spawn()?;
        let deadline = Instant::now() + Duration::from_secs(15);
        let notepad = loop {
            if let Some(h) = find_window("mukuchi-spike-target") {
                break h;
            }
            if Instant::now() > deadline {
                bail!("メモ帳のウィンドウが見つかりません");
            }
            std::thread::sleep(Duration::from_millis(200));
        };
        std::thread::sleep(Duration::from_millis(1500));
        let fg = unsafe { GetForegroundWindow() };
        println!("メモ帳: {} 前面={}", describe(notepad), describe(fg));
        if fg != notepad {
            bail!("メモ帳が前面になりません (前面: {})", describe(fg));
        }
        TARGET.store(notepad.0 as isize, Ordering::SeqCst);
        let editor = find_editor(notepad).context("メモ帳の編集領域が見つかりません")?;
        println!("編集領域: {}", class_name(editor));
        let result = if ime_only {
            ime_diag(notepad, editor)
        } else {
            drive_with(notepad, editor)
        };
        // 自分で開いたメモ帳だけを閉じる (内容を消して保存してから閉じ、保存の確認を出さない)
        refocus(notepad);
        let saved = clear_editor().and_then(|_| chord(&[VK_CONTROL], VK_S));
        std::thread::sleep(Duration::from_millis(500));
        if let Err(e) = saved {
            println!(
                "メモ帳を空にして保存できません ({e:#})。閉じる時に保存の確認が出ることがあります"
            );
        }
        let _ = unsafe { PostMessageW(Some(notepad), WM_CLOSE, WPARAM(0), LPARAM(0)) };
        std::thread::sleep(Duration::from_secs(2));
        if unsafe { FindWindowW(w!("Notepad"), PCWSTR::null()) }.is_err() {
            for p in &notepad_state {
                if p.exists() && std::fs::remove_dir_all(p).is_ok() {
                    println!(
                        "検証で作られたメモ帳のセッションを消しました: {}",
                        p.display()
                    );
                }
            }
        }
        result
    }

    fn clear_editor() -> Result<()> {
        chord(&[VK_CONTROL], VK_A)?;
        key(VK_DELETE)?;
        std::thread::sleep(Duration::from_millis(150));
        Ok(())
    }

    fn drive_with(notepad: HWND, editor: HWND) -> Result<()> {
        start_foreground_monitor();
        std::thread::sleep(Duration::from_millis(200));
        let (focus0, _) = gui_info(notepad);
        println!("フォーカス: {}", describe(focus0));

        // ---- 1. パネル ----
        // 本体の方式 → 対照: 右クリックを Tauri 標準 (muda) → 対照: サブクラスなし → 対照: focusable(true)
        // (最後は WS_EX_NOACTIVATE も無い普通のウィンドウ。検証の仕組みがフォーカスの移動を検出できることの確認)
        let variants = [
            (
                "本体と同じ (NOACTIVATE + サブクラス + 前面化しない TrackPopupMenu)",
                PanelMode::default(),
            ),
            (
                "対照: 右クリックが Tauri 標準の popup_menu (muda)",
                PanelMode {
                    tauri_menu: true,
                    ..Default::default()
                },
            ),
            (
                "対照: サブクラスなし (tao の WS_EX_NOACTIVATE だけ)",
                PanelMode {
                    nosub: true,
                    ..Default::default()
                },
            ),
            (
                "対照: focusable(true) (NOACTIVATE もサブクラスもなし)",
                PanelMode {
                    nosub: true,
                    focusable: true,
                    ..Default::default()
                },
            ),
        ];
        for (name, mode) in variants {
            println!("\n== 1. パネル: {name} ==");
            let t = Instant::now();
            let panel = Panel::spawn(mode)?;
            std::thread::sleep(Duration::from_millis(1500));
            let ex = unsafe { GetWindowLongPtrW(panel.hwnd, GWL_EXSTYLE) };
            println!(
                "  パネル {} exstyle={ex:#x} NOACTIVATE={} TOOLWINDOW={} TOPMOST={}",
                describe(panel.hwnd),
                ex & 0x0800_0000 != 0,
                ex & 0x80 != 0,
                ex & 0x8 != 0
            );
            check_fg("パネルの表示", notepad, panel.hwnd, t);
            refocus(notepad);
            if mode.focusable {
                // 対照はクリックで前面が移ることだけ確かめる (前面が移るため以降のキー入力の確認はしない)
                let t = Instant::now();
                mouse_click(panel.button.0, panel.button.1);
                std::thread::sleep(Duration::from_millis(600));
                check_fg("クリック", notepad, panel.hwnd, t);
                println!("  panel: {:?}", panel.drain());
                refocus(notepad);
                drop(panel);
                std::thread::sleep(Duration::from_millis(500));
                continue;
            }

            // (a) IME オフ: 操作の直後に打ったキーがメモ帳に入るか
            set_ime(editor, false)?;
            clear_editor()?;
            let mut at = (0, 0);
            let t = Instant::now();
            click(panel.button.0, panel.button.1)?;
            std::thread::sleep(Duration::from_millis(600));
            check_fg("クリック", notepad, panel.hwnd, t);
            println!("  panel: {:?}", panel.drain());
            key_goes_to_notepad("クリック", editor, &panel)?;
            refocus(notepad);

            let before = window_rect(panel.hwnd);
            let t = Instant::now();
            drag(panel.grip.0, panel.grip.1, 120, -40)?;
            at = (at.0 + 120, at.1 - 40);
            std::thread::sleep(Duration::from_millis(800));
            let after = window_rect(panel.hwnd);
            check_fg("ドラッグ", notepad, panel.hwnd, t);
            println!(
                "  移動: ({}, {}) → ({}, {})  panel: {:?}",
                before.left,
                before.top,
                after.left,
                after.top,
                panel.drain()
            );
            key_goes_to_notepad("ドラッグ", editor, &panel)?;
            refocus(notepad);

            right_click_and_dismiss(notepad, &panel, at)?;
            if mode.tauri_menu {
                // 対照は前面がパネルに移る (NG として記録済み)。キー入力の確認のためにメモ帳へ戻す
                refocus(notepad);
            }
            key_goes_to_notepad("右クリック", editor, &panel)?;
            refocus(notepad);
            let text = editor_text(editor);
            println!("  (メモ帳の本文: {:?})", text);

            // (b) IME オンで変換中の文字 (ka → か) がある間にパネルを操作し、変換中の文字が残るか。
            // i を足して (かい)、Esc で取り消す。変換中のまま残っていれば全部消えて空、
            // 確定されていれば「か」が残る、キーがパネルに行っていれば i が届かない。
            // 操作ごとに分け、操作なし (検証の仕組みの確認) も行う。右クリックのメニューは Esc で閉じる
            // (メニューの外のクリックはメモ帳のクリックになり、それ自体が変換を確定させうるため)
            if !mode.tauri_menu && ensure_ime_on(editor)? {
                // 変換中かどうかは、操作の後に Esc を 2 回押した時の本文の変わり方で見る。
                // Esc の効き方は IME によるため、「操作なし (変換中のまま)」と「Enter で確定した後」を基準に取り、
                // 操作の後の変わり方が前者と同じ (後者と違う) なら変換中の文字が保たれたとみなす
                let mut reference: Option<Vec<String>> = None;
                let mut committed: Option<Vec<String>> = None;
                for op in [
                    "確定済み (Enter)",
                    "操作なし",
                    "クリック",
                    "ドラッグ",
                    "右クリック → Esc で閉じる",
                    "右クリック → 外のクリックで閉じる",
                ] {
                    clear_editor()?;
                    key(VK_K)?;
                    key(VK_A)?;
                    std::thread::sleep(Duration::from_millis(300));
                    let t = Instant::now();
                    match op {
                        "確定済み (Enter)" => key(VK_RETURN)?,
                        "クリック" => click(panel.button.0 + at.0, panel.button.1 + at.1)?,
                        "ドラッグ" => {
                            let d = if at.0 == 0 { (120, -40) } else { (-120, 40) };
                            drag(panel.grip.0 + at.0, panel.grip.1 + at.1, d.0, d.1)?;
                            at = (at.0 + d.0, at.1 + d.1);
                        }
                        "右クリック → Esc で閉じる" | "右クリック → 外のクリックで閉じる" =>
                        {
                            right_click(panel.grip.0 + at.0, panel.grip.1 + at.1)?;
                            std::thread::sleep(Duration::from_millis(800));
                            let shown = find_menu_window().is_some();
                            if op.contains("Esc") {
                                key(VK_ESCAPE)?;
                            } else {
                                mouse_click(panel.button.0 + at.0, panel.button.1 + at.1);
                            }
                            std::thread::sleep(Duration::from_millis(400));
                            println!(
                                "    メニュー: 表示={shown} 閉じた={}",
                                find_menu_window().is_none()
                            );
                        }
                        _ => {}
                    }
                    std::thread::sleep(Duration::from_millis(600));
                    let fg_ok = check_fg(op, notepad, panel.hwnd, t);
                    let mut seq = vec![editor_text(editor)];
                    for _ in 0..2 {
                        key(VK_ESCAPE)?;
                        std::thread::sleep(Duration::from_millis(300));
                        seq.push(editor_text(editor));
                    }
                    match op {
                        "確定済み (Enter)" => {
                            println!("    基準 (確定済み): Esc ごとの本文 {seq:?}");
                            committed = Some(seq);
                        }
                        "操作なし" => {
                            println!("    基準 (変換中): Esc ごとの本文 {seq:?}");
                            reference = Some(seq);
                        }
                        _ => {
                            let same = reference.as_ref() == Some(&seq);
                            let distinguishable = reference != committed;
                            println!(
                                "  [{}] 変換中の文字が保たれた ({op}): Esc ごとの本文 {seq:?} (基準と同じ={same}、基準が確定済みと区別できる={distinguishable}) panel: {:?}",
                                if same && fg_ok && distinguishable { "OK" } else { "NG" },
                                panel.drain()
                            );
                        }
                    }
                    refocus(notepad);
                }
                clear_editor()?;
                set_ime(editor, false)?;
            }
            clear_editor()?;
            drop(panel);
            std::thread::sleep(Duration::from_millis(500));
        }

        // ---- 2. IME オンでの貼り付け ----
        println!("\n== 2. IME オンでの貼り付け ==");
        let ime = ensure_ime_on(editor)?;
        println!("  IME オン: {ime}");
        put_mixed_clipboard(&format!(r"{DIR}\mukuchi-spike-target.txt"))?;
        let original = clipboard::snapshot()?;
        println!("  元の内容 (検証用): {}", describe_snapshot(&original));
        let samples = [
            "貼り付けの確認です。",
            "Mixed 英数字 123 と記号「」、改行\r\nの２行目",
            "絵文字👍と結合文字が̈",
        ];
        for s in samples {
            clear_editor()?;
            let r = paste(s)?;
            std::thread::sleep(Duration::from_millis(300));
            let got = editor_text(editor);
            // Edit は改行を \r\n で持つ。RichEdit は \r だけのことがあるのでそろえて比べる
            let norm = |t: &str| t.replace("\r\n", "\n").replace('\r', "\n");
            let after = clipboard::snapshot()?;
            let diff = diff_snapshots(&original, &after);
            println!(
                "  [{}] {} 文字: 一致={} (入力 {} 文字) 読み取りまで={:?} 先読み={} (最初に読んだ: {}) 復元={} 復元の差={:?}",
                if norm(&got) == norm(s) && diff.is_empty() { "OK" } else { "NG" },
                s.chars().count(),
                norm(&got) == norm(s),
                got.chars().count(),
                r.rendered_after,
                r.read_before_paste,
                r.first_reader.map(exe_of).unwrap_or_default(),
                r.restored,
                diff
            );
        }

        // 変換中の文字がある状態での貼り付け (観察)
        clear_editor()?;
        key(VK_K)?;
        key(VK_A)?;
        std::thread::sleep(Duration::from_millis(300));
        let r = paste("ABC")?;
        std::thread::sleep(Duration::from_millis(400));
        let during = editor_text(editor);
        key(VK_ESCAPE)?;
        key(VK_ESCAPE)?;
        std::thread::sleep(Duration::from_millis(300));
        let after_esc = editor_text(editor);
        println!(
            "  (観察) 変換中 (ka) に貼り付け: 直後の本文 {:?} → Esc 後 {:?} 読み取りまで={:?}",
            during, after_esc, r.rendered_after
        );
        clear_editor()?;
        set_ime(editor, false)?;

        // ---- 2b. 復元の失敗 (他がクリップボードを開いたまま) と、他のアプリのコピーが待たされないか ----
        println!("\n== 2b. 復元できない時・他のアプリのコピー ==");
        for (hold, label) in [
            (Duration::from_millis(2500), "2.5 秒 (裏の再試行で戻る想定)"),
            (
                Duration::from_millis(12000),
                "12 秒 (裏の再試行も尽きる想定)",
            ),
        ] {
            put_mixed_clipboard(&format!(r"{DIR}\mukuchi-spike-target.txt"))?;
            let original = clipboard::snapshot()?;
            clear_editor()?;
            let holder = std::thread::spawn(move || unsafe {
                // 貼り付けの送信の後・復元の前に開いて、そのまま持つ
                std::thread::sleep(Duration::from_millis(120));
                let opened = OpenClipboard(None).is_ok();
                std::thread::sleep(hold);
                if opened {
                    let _ = CloseClipboard();
                }
                opened
            });
            let r = paste("保持中の貼り付け")?;
            let opened = holder.join().unwrap_or(false);
            let pasted = editor_text(editor);
            if hold.as_secs() < 5 {
                std::thread::sleep(Duration::from_millis(1500));
            }
            let t = Instant::now();
            let after = clipboard::snapshot()?;
            let read_ms = t.elapsed().as_millis();
            let diff = diff_snapshots(&original, &after);
            let text = after
                .bytes_of(13)
                .map(|b| {
                    let u: Vec<u16> = b
                        .as_chunks::<2>()
                        .0
                        .iter()
                        .map(|c| u16::from_le_bytes(*c))
                        .collect();
                    String::from_utf16_lossy(&u)
                        .trim_end_matches('\0')
                        .to_string()
                })
                .unwrap_or_default();
            let restored_late = diff.is_empty();
            let fallback_text = text == "保持中の貼り付け";
            println!(
                "  [{}] 他が {label} 開いたまま: 保持できた={opened} 貼り付け={} すぐ戻した={} 裏で戻す={} → 後で元に戻った={restored_late} / 戻らず貼ったテキストが読める={fallback_text} (読み取り {read_ms}ms) 差={:?}",
                if (restored_late || fallback_text) && read_ms < 1000 { "OK" } else { "NG" },
                pasted == "保持中の貼り付け",
                r.restored,
                r.restore_deferred,
                if restored_late { vec![] } else { diff }
            );
        }
        // 他のアプリ (PowerShell の Set-Clipboard) のコピーが、所有者 (このアプリ) のせいで待たされないか
        clear_editor()?;
        put_mixed_clipboard(&format!(r"{DIR}\mukuchi-spike-target.txt"))?;
        let r = paste("コピーの待ちの確認")?;
        let out = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-Command",
                "(Measure-Command { Set-Clipboard -Value 'mukuchi-spike-copy' }).TotalMilliseconds",
            ])
            .output()?;
        let ms: f64 = String::from_utf8_lossy(&out.stdout)
            .trim()
            .parse()
            .unwrap_or(-1.0);
        println!(
            "  [{}] 復元後に他のプロセスがコピー: Set-Clipboard {ms:.0}ms (復元={})",
            if (0.0..500.0).contains(&ms) {
                "OK"
            } else {
                "NG"
            },
            r.restored
        );
        delete_history_text("mukuchi-spike-copy");
        clear_editor()?;

        // ---- 3. 履歴 (Win+V) ----
        // 利用者がコピーした内容の代わりに、除外の形式なしのテキストを置く (履歴に 1 件載る)。
        // その後の貼り付けで、貼り付けたテキストも、戻した元の内容 (の重複) も履歴に増えないことを確かめる
        println!("\n== 3. クリップボードの履歴 ==");
        let pid = std::process::id();
        let orig = format!("mukuchi-spike-orig-{pid}");
        let marker = format!("mukuchi-spike-{pid}");
        put_plain_text(&orig)?;
        std::thread::sleep(Duration::from_millis(1500));
        let (n0, orig_in_history) = history_contains(&orig)?;
        let r = paste(&marker)?;
        std::thread::sleep(Duration::from_millis(1500));
        let (n1, found1) = history_contains(&marker)?;
        println!(
            "  [{}] 貼り付けたテキスト・戻した内容が履歴に増えない: 前 {n0} 件 → 後 {n1} 件、貼り付けたテキストを含む={found1} 復元={} (対照: 除外なしの元の内容は履歴に載った={orig_in_history})",
            if !found1 && n1 == n0 { "OK" } else { "NG" },
            r.restored
        );
        clear_editor()?;
        // 検証で履歴に載せたもの (載ってしまったもの) を消す
        delete_history_text(&orig);
        if found1 {
            delete_history_text(&marker);
        }
        Ok(())
    }

    /// 対照実験で履歴に載せたテキストを消す (利用者の履歴に残さない)
    fn delete_history_text(needle: &str) {
        let needle = needle.to_string();
        let r = in_sta(move || delete_history_text_sta(&needle).map_err(Into::into));
        if let Err(e) = r {
            println!("  !! 検証のテキストを履歴から消せません: {e}");
        }
    }

    fn delete_history_text_sta(needle: &str) -> windows::core::Result<()> {
        use windows::ApplicationModel::DataTransfer::{Clipboard, StandardDataFormats};
        let res = Clipboard::GetHistoryItemsAsync()?.join()?;
        let items = res.Items()?;
        for i in 0..items.Size()? {
            let item = items.GetAt(i)?;
            let c = item.Content()?;
            if c.Contains(&StandardDataFormats::Text()?)? && c.GetTextAsync()?.join()? == needle {
                Clipboard::DeleteItemFromHistory(&item)?;
            }
        }
        Ok(())
    }

    fn find_menu_window() -> Option<HWND> {
        let h = unsafe { FindWindowW(w!("#32768"), PCWSTR::null()) }.ok()?;
        unsafe { IsWindowVisible(h) }.as_bool().then_some(h)
    }

    // ---- パネル (Tauri) ----------------------------------------------------------

    mod panel {
        use super::*;
        use tauri::menu::{Menu, MenuItem};
        use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
        use windows::Win32::UI::WindowsAndMessaging::{
            SetWindowLongPtrW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
        };

        const HTML: &str = r#"<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:transparent;overflow:hidden;font:14px sans-serif;user-select:none}
#pill{position:absolute;left:10px;top:10px;width:300px;height:64px;border-radius:32px;background:#222;color:#fff}
#btn{position:absolute;left:8px;top:8px;width:48px;height:48px;border-radius:24px;border:0;background:#e44}
#label{position:absolute;left:70px;top:22px}
</style></head><body><div id="pill"><button id="btn"></button><span id="label">spike</span></div><script>
const inv=(c,a)=>window.__TAURI_INTERNALS__.invoke(c,a);
const log=m=>inv('spike_log',{msg:m});
let n=0, dragged=false;
document.getElementById('btn').addEventListener('click',e=>{ if(dragged){dragged=false;return;} n++; log('CLICK '+n+' focus='+document.hasFocus()); });
document.addEventListener('pointerdown',e=>{ if(e.button!==0)return; dragged=false; const sx=e.clientX, sy=e.clientY;
  const mv=ev=>{ if(Math.hypot(ev.clientX-sx,ev.clientY-sy)<4)return; dragged=true; off(); inv('plugin:window|start_dragging',{label:'panel'}).then(()=>log('DRAG started'),err=>log('DRAG error '+err)); };
  const off=()=>{window.removeEventListener('pointermove',mv);window.removeEventListener('pointerup',off);};
  window.addEventListener('pointermove',mv); window.addEventListener('pointerup',off); });
document.addEventListener('contextmenu',e=>{ e.preventDefault(); inv('spike_menu',{x:e.clientX,y:e.clientY}); });
window.addEventListener('focus',()=>log('window focus'));
document.addEventListener('keydown',e=>log('KEY '+e.key));
log('loaded');
</script></body></html>"#;

        /// ページを返すだけの HTTP サーバー (devUrl に使う。IPC は devUrl のページにだけ許可されるため)
        fn serve() -> Result<String> {
            let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
            let addr = listener.local_addr()?;
            std::thread::spawn(move || {
                for mut s in listener.incoming().map_while(Result::ok) {
                    let mut buf = [0u8; 2048];
                    let _ = std::io::Read::read(&mut s, &mut buf);
                    let _ = write!(
                        s,
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{HTML}",
                        HTML.len()
                    );
                }
            });
            Ok(format!("http://{addr}/"))
        }

        static TAURI_MENU: std::sync::atomic::AtomicBool =
            std::sync::atomic::AtomicBool::new(false);

        #[tauri::command]
        fn spike_log(msg: String) {
            println!("{msg}");
            let _ = std::io::stdout().flush();
        }

        #[tauri::command]
        fn spike_menu(window: tauri::WebviewWindow, x: f64, y: f64) {
            if TAURI_MENU.load(std::sync::atomic::Ordering::SeqCst) {
                let app = window.app_handle();
                let items = (|| -> tauri::Result<Menu<tauri::Wry>> {
                    let a = MenuItem::with_id(app, "a", "項目 1", true, None::<&str>)?;
                    let b = MenuItem::with_id(app, "b", "項目 2", true, None::<&str>)?;
                    Menu::with_items(app, &[&a, &b])
                })();
                match items {
                    Ok(menu) => {
                        let r = window.popup_menu_at(&menu, tauri::LogicalPosition::new(x, y));
                        println!("MENU tauri closed {r:?}");
                    }
                    Err(e) => println!("MENU error {e}"),
                }
                let _ = std::io::stdout().flush();
                return;
            }
            let Ok(hwnd) = window.hwnd() else { return };
            let scale = window.scale_factor().unwrap_or(1.0);
            let pos = window.inner_position().unwrap_or_default();
            let at = (pos.x + (x * scale) as i32, pos.y + (y * scale) as i32);
            let hwnd_v = hwnd.0 as isize;
            let _ = window.run_on_main_thread(move || {
                let items = [
                    crate::panel_win::PopupItem::Item {
                        text: "項目 1".into(),
                        enabled: true,
                    },
                    crate::panel_win::PopupItem::Separator,
                    crate::panel_win::PopupItem::Check {
                        text: "項目 2".into(),
                        checked: true,
                    },
                ];
                let r = crate::panel_win::popup_menu(HWND(hwnd_v as *mut _), &items, at);
                println!("MENU raw closed {r:?}");
                let _ = std::io::stdout().flush();
            });
        }

        pub fn run(mode: PanelMode) -> Result<()> {
            let PanelMode {
                tauri_menu,
                nosub,
                focusable,
            } = mode;
            TAURI_MENU.store(tauri_menu, std::sync::atomic::Ordering::SeqCst);
            let url = serve()?;
            let mut context = tauri::generate_context!();
            context.config_mut().build.dev_url = Some(url.parse()?);
            tauri::Builder::default()
                .invoke_handler(tauri::generate_handler![spike_log, spike_menu])
                .setup(move |app| {
                    let w = WebviewWindowBuilder::new(
                        app,
                        "panel",
                        WebviewUrl::App("index.html".into()),
                    )
                    .title("mukuchi spike panel")
                    // アプリ本体のデータ (%LOCALAPPDATA%\<ID>\EBWebView) に触れない
                    .data_directory(std::env::temp_dir().join("mukuchi-spike-webview"))
                    .inner_size(320.0, 84.0)
                    .position(900.0, 600.0)
                    .decorations(false)
                    .transparent(true)
                    .shadow(false)
                    .resizable(false)
                    .always_on_top(true)
                    .skip_taskbar(true)
                    .focusable(focusable)
                    .focused(false)
                    // 本体と同じく、隠して作ってから表示する (後からの show は SW_SHOW を使うため、
                    // その表示でもアクティブにならないことを確かめる)
                    .visible(false)
                    .build()?;
                    let hwnd = w.hwnd()?;
                    if focusable {
                        // 対照: 何も付けない普通のウィンドウ
                    } else if nosub {
                        unsafe {
                            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
                            SetWindowLongPtrW(
                                hwnd,
                                GWL_EXSTYLE,
                                ex | (WS_EX_NOACTIVATE.0 | WS_EX_TOOLWINDOW.0) as isize,
                            );
                        }
                    } else {
                        crate::panel_win::prevent_activation(hwnd)?;
                    }
                    std::thread::sleep(Duration::from_millis(300));
                    w.show()?;
                    let scale = w.scale_factor()?;
                    let pos = w.outer_position()?;
                    // ボタンの中心 (CSS 10+8+24) とピルの右側 (ボタンの外)
                    let at = |cx: f64, cy: f64| {
                        (pos.x + (cx * scale) as i32, pos.y + (cy * scale) as i32)
                    };
                    let (bx, by) = at(42.0, 42.0);
                    let (gx, gy) = at(250.0, 42.0);
                    println!(
                        "READY hwnd={} bx={bx} by={by} gx={gx} gy={gy}",
                        hwnd.0 as isize
                    );
                    let _ = std::io::stdout().flush();
                    Ok(())
                })
                .run(context)?;
            Ok(())
        }
    }
}
