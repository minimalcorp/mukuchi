//! クリップボード経由の入力 (Windows): 全形式の退避 → テキストを置く → 貼り付け → 復元。
//!
//! - 退避は全形式 (テキスト・画像・ファイル (CF_HDROP)・アプリ独自の登録形式)。GDI のハンドルの形式
//!   (CF_BITMAP 等) は複製できないため除くが、OS が同じ内容を CF_DIB 等で合成して列挙するのでそちらで残る
//! - 置くテキストには履歴 (Win+V)・クラウド同期・クリップボード監視アプリから外す形式を付ける
//!   (<https://learn.microsoft.com/windows/win32/dataxchg/clipboard-formats#cloud-clipboard-and-clipboard-history-formats>)
//! - テキストは遅延レンダリング (`SetClipboardData(CF_UNICODETEXT, NULL)`) で置き、貼り付け先が読みに来た
//!   (`WM_RENDERFORMAT`) ことを確かめてから戻す。固定の待ちだけだと遅いアプリで復元後の内容が貼られるため
//! - 所有者ウィンドウはメッセージを処理し続ける専用のスレッドに置く。戻せない時 (他のアプリが開いたまま) は
//!   間を空けて再試行し、それでも駄目なら裏で戻し続け、その間も読みに来たアプリには置いたテキストを渡す
//!
//! このファイルは `examples/win_spike.rs` からも `#[path]` で取り込む (実機の検証で同じコードを使うため)。
//! そのため `crate::` を参照しない。

use std::sync::{mpsc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::Graphics::Gdi::HENHMETAFILE;
use windows::Win32::Graphics::Gdi::{DeleteEnhMetaFile, GetEnhMetaFileBits, SetEnhMetaFileBits};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, EnumClipboardFormats, GetClipboardData,
    GetClipboardFormatNameW, GetClipboardOwner, GetOpenClipboardWindow, OpenClipboard,
    RegisterClipboardFormatW, SetClipboardData,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Memory::{
    GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE,
};
use windows::Win32::System::Ole::{
    CF_BITMAP, CF_DSPBITMAP, CF_DSPENHMETAFILE, CF_DSPMETAFILEPICT, CF_ENHMETAFILE, CF_GDIOBJFIRST,
    CF_GDIOBJLAST, CF_METAFILEPICT, CF_OWNERDISPLAY, CF_PALETTE, CF_PRIVATEFIRST, CF_PRIVATELAST,
    CF_UNICODETEXT,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, GetWindowThreadProcessId,
    RegisterClassW, TranslateMessage, HWND_MESSAGE, MSG, WINDOW_EX_STYLE, WINDOW_STYLE,
    WM_RENDERFORMAT, WNDCLASSW,
};

/// テキストを置いてから Ctrl+V を送るまでの待ち (Mac と同じ)
const BEFORE_PASTE: Duration = Duration::from_millis(30);
/// 貼り付け先が読みに来るのを待つ上限。これを過ぎたら読まれなかったとみなして戻す
/// (Ctrl+V を貼り付けにしないアプリで、次の入力を長く止めないため)
const MAX_RENDER_WAIT: Duration = Duration::from_millis(1000);
/// 読みに来た後、貼り付け先がクリップボードを閉じるまでの猶予
/// (同じ読み取りの中で別の形式 (CF_TEXT 等の合成) も読むため。閉じていなければさらに待つ)
const AFTER_RENDER: Duration = Duration::from_millis(50);
/// Ctrl+V の前に他のアプリ (監視アプリ等) が読んでしまい、貼り付け先の読み取りを検知できない時の固定の待ち
/// (Mac の PASTE_SETTLE と同じ)
const FALLBACK_SETTLE: Duration = Duration::from_millis(200);
/// 貼り付け先がクリップボードを開いたままの時に待つ上限
const MAX_CLOSE_WAIT: Duration = Duration::from_millis(500);
/// OpenClipboard の再試行 (他のアプリが開いていると失敗する)
const OPEN_RETRIES: u32 = 20;
const OPEN_RETRY_INTERVAL: Duration = Duration::from_millis(10);

/// 退避した 1 形式
#[derive(Clone)]
enum Data {
    /// HGLOBAL の中身
    Global(Vec<u8>),
    /// CF_ENHMETAFILE (ハンドルではなく中身のバイト列で持つ)
    EnhMetaFile(Vec<u8>),
}

#[derive(Clone)]
struct Item {
    format: u32,
    data: Data,
}

/// クリップボードの退避した内容 (空のこともある)
#[derive(Clone)]
pub struct Snapshot {
    items: Vec<Item>,
}

impl Snapshot {
    /// 退避した形式の数 (検証・ログ用)
    pub fn len(&self) -> usize {
        self.items.len()
    }

    /// 形式ごとの (番号, バイト数) (検証 (examples/win_spike.rs) 用)
    #[allow(dead_code)]
    pub fn summary(&self) -> Vec<(u32, usize)> {
        self.items
            .iter()
            .map(|i| match &i.data {
                Data::Global(b) | Data::EnhMetaFile(b) => (i.format, b.len()),
            })
            .collect()
    }

    /// 形式ごとの中身 (検証 (examples/win_spike.rs) 用: 復元の前後で同じか比べる)
    #[allow(dead_code)]
    pub fn bytes_of(&self, format: u32) -> Option<&[u8]> {
        self.items
            .iter()
            .find(|i| i.format == format)
            .map(|i| match &i.data {
                Data::Global(b) | Data::EnhMetaFile(b) => b.as_slice(),
            })
    }
}

/// 開いている間だけ存在する (Drop で閉じる)
struct Open;

impl Open {
    fn new(owner: Option<HWND>) -> Result<Self> {
        let mut last = None;
        for _ in 0..OPEN_RETRIES {
            // SAFETY: owner は自スレッドのウィンドウか None
            match unsafe { OpenClipboard(owner) } {
                Ok(()) => return Ok(Self),
                Err(e) => last = Some(e),
            }
            std::thread::sleep(OPEN_RETRY_INTERVAL);
        }
        Err(anyhow!(
            "クリップボードを開けません (他のアプリが使用中): {}",
            last.map(|e| e.to_string()).unwrap_or_default()
        ))
    }
}

impl Drop for Open {
    fn drop(&mut self) {
        // SAFETY: Open::new で開いたものを閉じる
        if let Err(e) = unsafe { CloseClipboard() } {
            log::warn!("クリップボードを閉じられません: {e}");
        }
    }
}

/// 複製しない形式。GDI のハンドル・プライベートな形式は中身を HGLOBAL として読めない。
/// OLE の "DataObject" "Ole Private Data" はコピー元のプロセスの OLE オブジェクトを指すため、
/// バイト列として戻すと古いオブジェクトを参照させてしまう (中身の形式は別に列挙されるのでそちらで残る)
fn skip_format(format: u32) -> bool {
    let f = |c: windows::Win32::System::Ole::CLIPBOARD_FORMAT| u32::from(c.0);
    [
        f(CF_BITMAP),
        f(CF_PALETTE),
        f(CF_METAFILEPICT),
        f(CF_OWNERDISPLAY),
        f(CF_DSPBITMAP),
        f(CF_DSPMETAFILEPICT),
        f(CF_DSPENHMETAFILE),
    ]
    .contains(&format)
        || (f(CF_PRIVATEFIRST)..=f(CF_PRIVATELAST)).contains(&format)
        || (f(CF_GDIOBJFIRST)..=f(CF_GDIOBJLAST)).contains(&format)
        || matches!(
            format_name(format).as_deref(),
            Some("DataObject" | "Ole Private Data")
        )
}

/// 登録形式の名前 (標準の形式は None)
pub fn format_name(format: u32) -> Option<String> {
    if format < 0xC000 {
        return None;
    }
    let mut buf = [0u16; 256];
    // SAFETY: buf は書き込み可能な領域
    let n = unsafe { GetClipboardFormatNameW(format, &mut buf) };
    (n > 0).then(|| String::from_utf16_lossy(&buf[..n as usize]))
}

/// 全形式を退避する。開いている間に他のアプリの遅延レンダリングが走るため、時間がかかることがある
pub fn snapshot() -> Result<Snapshot> {
    let _open = Open::new(None)?;
    // SAFETY: クリップボードを開いている間だけ列挙・取得する
    unsafe { snapshot_open() }
}

/// # Safety
/// クリップボードを開いている間に呼ぶこと
unsafe fn snapshot_open() -> Result<Snapshot> {
    let mut items = Vec::new();
    let mut format = 0;
    loop {
        format = unsafe { EnumClipboardFormats(format) };
        if format == 0 {
            break;
        }
        if skip_format(format) {
            continue;
        }
        // 取得できない形式 (遅延レンダリングの失敗等) は飛ばす。全体の退避は止めない
        let Ok(handle) = (unsafe { GetClipboardData(format) }) else {
            continue;
        };
        if handle.is_invalid() {
            continue;
        }
        let data = if format == u32::from(CF_ENHMETAFILE.0) {
            let hemf = HENHMETAFILE(handle.0);
            let size = unsafe { GetEnhMetaFileBits(hemf, None) } as usize;
            if size == 0 {
                continue;
            }
            let mut buf = vec![0u8; size];
            if unsafe { GetEnhMetaFileBits(hemf, Some(&mut buf)) } as usize != size {
                continue;
            }
            Data::EnhMetaFile(buf)
        } else {
            match unsafe { read_global(HGLOBAL(handle.0)) } {
                Some(b) => Data::Global(b),
                None => continue,
            }
        };
        items.push(Item { format, data });
    }
    Ok(Snapshot { items })
}

/// HGLOBAL の中身を複製する (HGLOBAL でないハンドルなら None)
///
/// # Safety
/// クリップボードから取得した有効なハンドルであること
unsafe fn read_global(h: HGLOBAL) -> Option<Vec<u8>> {
    let size = unsafe { GlobalSize(h) };
    if size == 0 {
        return None;
    }
    let p = unsafe { GlobalLock(h) };
    if p.is_null() {
        return None;
    }
    // SAFETY: GlobalLock が返した領域は GlobalSize バイト読める
    let bytes = unsafe { std::slice::from_raw_parts(p as *const u8, size) }.to_vec();
    let _ = unsafe { GlobalUnlock(h) };
    Some(bytes)
}

/// バイト列を移動可能なグローバルメモリにする (SetClipboardData に渡すため)
fn alloc_global(bytes: &[u8]) -> Result<HGLOBAL> {
    // SAFETY: 確保した領域に bytes.len() バイト書き込む
    unsafe {
        let h = GlobalAlloc(GMEM_MOVEABLE, bytes.len().max(1)).context("メモリを確保できません")?;
        let p = GlobalLock(h);
        if p.is_null() {
            let _ = GlobalFree(Some(h));
            bail!("メモリをロックできません");
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), p as *mut u8, bytes.len());
        let _ = GlobalUnlock(h);
        Ok(h)
    }
}

/// クリップボードに HGLOBAL を渡す。成功したら所有権はシステムに移り、失敗したら自分で解放する
///
/// # Safety
/// クリップボードを開いていること
unsafe fn set_global(format: u32, bytes: &[u8]) -> Result<()> {
    let h = alloc_global(bytes)?;
    match unsafe { SetClipboardData(format, Some(HANDLE(h.0))) } {
        Ok(_) => Ok(()),
        Err(e) => {
            let _ = unsafe { GlobalFree(Some(h)) };
            Err(e.into())
        }
    }
}

/// UTF-16 の NUL 終端のバイト列 (CF_UNICODETEXT の中身)
fn unicode_text_bytes(text: &str) -> Vec<u8> {
    text.encode_utf16()
        .chain(std::iter::once(0))
        .flat_map(|u| u.to_le_bytes())
        .collect()
}

/// 履歴・クラウド同期・監視アプリから外す形式を置く。
/// 入力のための一時的な内容 (と、その後に戻す元の内容) を履歴に二重に残さないため
///
/// # Safety
/// クリップボードを開いていること
unsafe fn set_exclusion_formats() {
    let zero = 0u32.to_le_bytes();
    for name in [
        w!("ExcludeClipboardContentFromMonitorProcessing"),
        w!("CanIncludeInClipboardHistory"),
        w!("CanUploadToCloudClipboard"),
    ] {
        let format = unsafe { RegisterClipboardFormatW(name) };
        if format == 0 {
            continue;
        }
        if let Err(e) = unsafe { set_global(format, &zero) } {
            log::warn!("クリップボードの除外の形式を置けません: {e:#}");
        }
    }
}

/// 退避した内容に戻す (空なら空にする)。戻した内容も履歴に重ねて載せない
fn restore(owner: HWND, saved: &Snapshot) -> Result<()> {
    let _open = Open::new(Some(owner))?;
    // SAFETY: 開いている間に空にして、各形式を置く
    unsafe {
        EmptyClipboard().context("クリップボードを空にできません")?;
        if saved.items.is_empty() {
            return Ok(());
        }
        let mut failed = 0;
        for item in &saved.items {
            let r = match &item.data {
                Data::Global(b) => set_global(item.format, b),
                Data::EnhMetaFile(b) => {
                    let hemf = SetEnhMetaFileBits(b);
                    if hemf.is_invalid() {
                        Err(anyhow!("メタファイルを作れません"))
                    } else {
                        SetClipboardData(item.format, Some(HANDLE(hemf.0)))
                            .map(|_| ())
                            .map_err(|e| {
                                let _ = DeleteEnhMetaFile(Some(hemf));
                                e.into()
                            })
                    }
                }
            };
            if r.is_err() {
                failed += 1;
            }
        }
        if failed > 0 {
            log::warn!(
                "クリップボードの {failed}/{} 形式を戻せません",
                saved.items.len()
            );
        }
        set_exclusion_formats();
    }
    Ok(())
}

/// 退避した内容に戻す。検証 (examples/win_spike.rs) が利用者の内容を戻すのに使う
#[allow(dead_code)]
pub fn restore_snapshot(saved: &Snapshot) -> Result<()> {
    restore_with_retries(owner_window()?, saved)
}

// ---- 遅延レンダリングの受け口 (専用のスレッドに 1 つ) -----------------------------

/// 貼り付け中の状態。所有者ウィンドウのスレッド (WM_RENDERFORMAT) と入力キューのスレッドで共有する。
/// クリップボードの API を呼ぶ間はロックを持たない (所有者ウィンドウへの同期のメッセージと詰まらないように)
#[derive(Default)]
struct State {
    /// 貼り付け中のテキスト (CF_UNICODETEXT の中身)。WM_RENDERFORMAT で渡す。
    /// 復元できていない間は残し、後から読みに来たアプリにも空ではなくこのテキストを渡す
    pending: Option<Vec<u8>>,
    /// 最後に WM_RENDERFORMAT で渡した時刻
    rendered_at: Option<Instant>,
    /// 最初に読みに来たプロセス (クリップボードを開いていたウィンドウのプロセス ID。調査・ログ用)
    first_reader: Option<u32>,
    /// 貼り付けの通番。遅れた復元が次の貼り付けの内容を上書きしないため
    generation: u64,
}

static STATE: Mutex<State> = Mutex::new(State {
    pending: None,
    rendered_at: None,
    first_reader: None,
    generation: 0,
});

/// 貼り付けと遅れた復元を直列にする
static OP: Mutex<()> = Mutex::new(());

fn state() -> MutexGuard<'static, State> {
    STATE.lock().unwrap_or_else(|p| p.into_inner())
}

unsafe extern "system" fn owner_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if msg == WM_RENDERFORMAT && wparam.0 as u32 == u32::from(CF_UNICODETEXT.0) {
        // 遅延レンダリングの要求: 開かずに SetClipboardData で渡す (要求したアプリが開いている)
        let bytes = state().pending.clone();
        if let Some(bytes) = bytes {
            // SAFETY: WM_RENDERFORMAT の処理中はクリップボードが開かれている
            match unsafe { set_global(u32::from(CF_UNICODETEXT.0), &bytes) } {
                Ok(()) => {
                    let reader = clipboard_opener_pid();
                    let mut st = state();
                    st.rendered_at = Some(Instant::now());
                    if st.first_reader.is_none() {
                        st.first_reader = reader;
                    }
                }
                Err(e) => log::warn!("貼り付けるテキストを渡せません: {e:#}"),
            }
        }
        return LRESULT(0);
    }
    // SAFETY: 既定の処理
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

/// 今クリップボードを開いているウィンドウのプロセス ID
fn clipboard_opener_pid() -> Option<u32> {
    // SAFETY: 問い合わせのみ
    unsafe {
        let h = GetOpenClipboardWindow().ok()?;
        let mut pid = 0;
        GetWindowThreadProcessId(h, Some(&mut pid));
        (pid != 0).then_some(pid)
    }
}

/// クリップボードの所有者にするメッセージ専用ウィンドウ。メッセージを処理し続ける専用のスレッドに置く。
/// 入力キューのスレッドは発話を待つ間メッセージを処理しないため、そこに置くと、他のアプリのコピー
/// (EmptyClipboard が所有者へ WM_DESTROYCLIPBOARD を同期で送る) や読み取り (WM_RENDERFORMAT) を待たせてしまう
fn owner_window() -> Result<HWND> {
    static OWNER: OnceLock<std::result::Result<isize, String>> = OnceLock::new();
    let r = OWNER.get_or_init(|| {
        let (tx, rx) = mpsc::channel();
        let spawned = std::thread::Builder::new()
            .name("mukuchi-clipboard".into())
            .spawn(move || {
                let hwnd = create_owner_window();
                let ok = hwnd.is_ok();
                let _ = tx.send(hwnd.map(|h| h.0 as isize).map_err(|e| format!("{e:#}")));
                if ok {
                    // SAFETY: このスレッドのメッセージを処理し続ける (アプリの終了まで)
                    unsafe {
                        let mut msg = MSG::default();
                        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                            let _ = TranslateMessage(&msg);
                            DispatchMessageW(&msg);
                        }
                    }
                }
            });
        match spawned {
            Ok(_) => rx
                .recv()
                .unwrap_or_else(|_| Err("クリップボードのスレッドが終了しました".into())),
            Err(e) => Err(format!("クリップボードのスレッドを作れません: {e}")),
        }
    });
    r.as_ref()
        .map(|h| HWND(*h as *mut _))
        .map_err(|e| anyhow!("{e}"))
}

fn create_owner_window() -> Result<HWND> {
    let class = w!("MukuchiClipboardOwner");
    // SAFETY: ウィンドウクラスの登録とメッセージ専用ウィンドウの作成
    unsafe {
        let hinstance = GetModuleHandleW(PCWSTR::null()).context("モジュールを取得できません")?;
        let wc = WNDCLASSW {
            lpfnWndProc: Some(owner_wndproc),
            hInstance: hinstance.into(),
            lpszClassName: class,
            ..Default::default()
        };
        RegisterClassW(&wc);
        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            class,
            w!("mukuchi clipboard"),
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            Some(HWND_MESSAGE),
            None,
            Some(hinstance.into()),
            None,
        )
        .context("クリップボード用のウィンドウを作れません")
    }
}

/// `until` まで、または `done` が真になるまで待つ (読み取りは所有者のスレッドが受けて STATE に記録する)
fn wait_until(until: Instant, mut done: impl FnMut() -> bool) {
    loop {
        if done() {
            return;
        }
        let now = Instant::now();
        if now >= until {
            return;
        }
        std::thread::sleep((until - now).min(Duration::from_millis(5)));
    }
}

/// 復元の再試行の間隔 (他のアプリがクリップボードを開いたままの時。Open::new の短い再試行の後)
const RESTORE_RETRY_DELAYS: [Duration; 4] = [
    Duration::from_millis(100),
    Duration::from_millis(200),
    Duration::from_millis(300),
    Duration::from_millis(400),
];
/// それでも戻せない時に、裏で戻し続ける間隔と回数 (約 10 秒)
const DEFERRED_RESTORE_INTERVAL: Duration = Duration::from_millis(500);
const DEFERRED_RESTORE_ATTEMPTS: u32 = 20;

/// 自分がまだ所有者か (他のアプリ・利用者がコピーしていれば、そちらを優先して戻さない)
fn still_ours(owner: HWND) -> bool {
    // SAFETY: 所有者の問い合わせのみ
    unsafe { GetClipboardOwner() }.is_ok_and(|h| h == owner)
}

/// 貼り付けの経過 (ログ・検証用)
#[derive(Debug, Clone, Copy)]
pub struct PasteReport {
    /// 退避した形式の数
    pub saved_formats: usize,
    /// Ctrl+V を送ってから貼り付け先が読みに来るまで (読みに来なければ None)
    pub rendered_after: Option<Duration>,
    /// Ctrl+V の前に他のアプリが読んだ (貼り付け先の読み取りを検知できない)
    pub read_before_paste: bool,
    /// 元の内容に戻した (待つ間に他で書き換えられたら戻さない)
    pub restored: bool,
    /// すぐには戻せず、裏で戻し続けている (他のアプリがクリップボードを開いたまま)
    pub restore_deferred: bool,
    /// 最初に読みに来たプロセス ID (先読みしたのが何か調べるため)
    pub first_reader: Option<u32>,
}

/// `text` をクリップボードに置き、`send_paste` (Ctrl+V の送信) を呼び、貼り付け先が読み終えたら元に戻す
pub fn paste_text(text: &str, send_paste: impl FnOnce() -> Result<()>) -> Result<PasteReport> {
    let owner = owner_window()?;
    let _op = OP.lock().unwrap_or_else(|p| p.into_inner());
    // 書き換える前に退避する。ここで失敗したら利用者のクリップボードには触れていない
    let saved = snapshot()?;
    let generation = {
        let mut st = state();
        st.generation += 1;
        st.pending = Some(unicode_text_bytes(text));
        st.rendered_at = None;
        st.first_reader = None;
        st.generation
    };
    let result = paste_with_owner(owner, &saved, send_paste);
    match &result {
        Ok(r) if r.restore_deferred => {
            // 戻せていない。置いたテキストは読みに来たアプリに渡し続け (空の遅延レンダリングを残さない)、
            // 裏で戻し続ける
            spawn_deferred_restore(owner, saved, generation);
        }
        _ => state().pending = None,
    }
    result
}

fn paste_with_owner(
    owner: HWND,
    saved: &Snapshot,
    send_paste: impl FnOnce() -> Result<()>,
) -> Result<PasteReport> {
    {
        let _open = Open::new(Some(owner))?;
        // SAFETY: 開いている間に空にして (所有者 = owner)、テキストを遅延レンダリングで置く
        unsafe {
            EmptyClipboard().context("クリップボードを空にできません")?;
            // 遅延レンダリング (データ NULL) の SetClipboardData は成功しても NULL を返すため、windows-rs では
            // GetLastError が 0 の Err になる。エラーコードが 0 なら成功として扱う
            if let Err(e) = SetClipboardData(u32::from(CF_UNICODETEXT.0), None)
                .map(|_| ())
                .or_else(|e| if e.code().is_ok() { Ok(()) } else { Err(e) })
            {
                drop(_open);
                let _ = restore_with_retries(owner, saved);
                return Err(anyhow!("クリップボードにテキストを置けません: {e}"));
            }
            set_exclusion_formats();
        }
    }
    std::thread::sleep(BEFORE_PASTE);
    let read_before_paste = state().rendered_at.is_some();

    let sent_at = Instant::now();
    let posted = send_paste();

    let rendered_after = if posted.is_err() {
        None
    } else if read_before_paste {
        // 監視アプリ等が先に読んだため、貼り付け先が読んだかは分からない。Mac と同じ固定の待ちにする
        std::thread::sleep(FALLBACK_SETTLE);
        None
    } else {
        wait_until(sent_at + MAX_RENDER_WAIT, || state().rendered_at.is_some());
        let rendered = state().rendered_at;
        if let Some(at) = rendered {
            // 読み取りが終わる (貼り付け先がクリップボードを閉じる) まで待つ
            wait_until(at + AFTER_RENDER, || false);
            let limit = Instant::now() + MAX_CLOSE_WAIT;
            // SAFETY: 開いているウィンドウの問い合わせのみ
            wait_until(limit, || unsafe { GetOpenClipboardWindow() }.is_err());
        }
        rendered.map(|at| at.saturating_duration_since(sent_at))
    };

    let (restored, restore_deferred) = if !still_ours(owner) {
        log::info!("クリップボードが他で変更されたため復元しない");
        (false, false)
    } else {
        match restore_with_retries(owner, saved) {
            Ok(()) => (true, false),
            Err(e) => {
                log::warn!("クリップボードをすぐには戻せません (裏で戻し続けます): {e:#}");
                (false, true)
            }
        }
    };
    posted?;
    let first_reader = state().first_reader;
    Ok(PasteReport {
        saved_formats: saved.len(),
        rendered_after,
        read_before_paste,
        restored,
        restore_deferred,
        first_reader,
    })
}

/// 間を空けて数回戻してみる (他のアプリがクリップボードを開いたままのことがある)
fn restore_with_retries(owner: HWND, saved: &Snapshot) -> Result<()> {
    let mut last = restore(owner, saved);
    for delay in RESTORE_RETRY_DELAYS {
        if last.is_ok() || !still_ours(owner) {
            break;
        }
        std::thread::sleep(delay);
        last = restore(owner, saved);
    }
    if last.is_err() && !still_ours(owner) {
        // 待つ間に他でコピーされた。戻す必要はない
        return Ok(());
    }
    last
}

/// 裏で戻し続ける。次の貼り付けが始まった・他でコピーされた・戻せた時に終わる。
/// 戻せないまま終わっても、置いたテキストは読みに来たアプリに渡し続ける (空の遅延レンダリングは残らない)
fn spawn_deferred_restore(owner: HWND, saved: Snapshot, generation: u64) {
    let owner_v = owner.0 as isize;
    let spawned = std::thread::Builder::new()
        .name("mukuchi-clipboard-restore".into())
        .spawn(move || {
            let owner = HWND(owner_v as *mut _);
            for _ in 0..DEFERRED_RESTORE_ATTEMPTS {
                std::thread::sleep(DEFERRED_RESTORE_INTERVAL);
                let _op = OP.lock().unwrap_or_else(|p| p.into_inner());
                if state().generation != generation {
                    return;
                }
                if !still_ours(owner) || restore(owner, &saved).is_ok() {
                    state().pending = None;
                    log::info!("クリップボードを遅れて戻しました");
                    return;
                }
            }
            log::warn!("クリップボードを戻せません (貼り付けたテキストのまま)");
        });
    if let Err(e) = spawned {
        log::warn!("クリップボードを戻すスレッドを作れません: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unicode_text_is_nul_terminated_utf16le() {
        assert_eq!(unicode_text_bytes("aあ"), vec![0x61, 0, 0x42, 0x30, 0, 0]);
        assert_eq!(unicode_text_bytes(""), vec![0, 0]);
    }

    #[test]
    fn gdi_and_private_formats_are_skipped() {
        assert!(skip_format(2)); // CF_BITMAP
        assert!(skip_format(0x200)); // CF_PRIVATEFIRST
        assert!(skip_format(0x300)); // CF_GDIOBJFIRST
        assert!(!skip_format(13)); // CF_UNICODETEXT
        assert!(!skip_format(8)); // CF_DIB
        assert!(!skip_format(15)); // CF_HDROP
        assert!(!skip_format(14)); // CF_ENHMETAFILE (中身のバイト列で退避する)
    }
}
