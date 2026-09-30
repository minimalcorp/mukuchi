//! ウィンドウ管理。
//!
//! - `panel`: フォーカスを奪わない常時表示パネル (NSPanel, non-activating。tauri-nspanel)。
//!   大きさはフロントエンドが `set_panel_size` で決め、Rust は「下端中央」を基準位置 (アンカー) に保つ。
//!   既定位置は前面ウィンドウのあるディスプレイの下中央。ドラッグで動かすと位置を settings.panelPosition に保存する
//! - `settings` / `setup`: 必要な時に作り、閉じたら破棄する。表示中だけ Dock に出す (ActivationPolicy::Regular)
//!
//! AppKit の操作はメインスレッドで行う (`run_on_main_thread`)。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use objc2::MainThreadMarker;
use objc2_app_kit::NSEvent;
use objc2_foundation::{NSPoint, NSRect, NSSize};
use serde::{Deserialize, Serialize};
use tauri::{
    ActivationPolicy, AppHandle, Emitter, LogicalPosition, Manager, WebviewUrl,
    WebviewWindowBuilder,
};
use tauri_nspanel::{CollectionBehavior, ManagerExt, PanelBuilder, PanelLevel, StyleMask};

use crate::core::Core;
use crate::macos::screen;
use crate::settings::PanelPosition;
use geometry::{Anchor, AnchorOn, Rect};

pub const PANEL: &str = "panel";
pub const SETTINGS: &str = "settings";
pub const SETUP: &str = "setup";

pub const SETTINGS_NAVIGATE: &str = "settings-navigate";

/// パネルの初期の大きさ (フロントエンドが set_panel_size で決めるまでの仮の値)
const PANEL_INITIAL_SIZE: (f64, f64) = (320.0, 100.0);
/// ドラッグ後、位置を保存するまでの待ち (ドラッグ中に何度も書き込まない)
const SAVE_POSITION_DELAY: Duration = Duration::from_millis(500);
/// ボタンを離した後に届く移動通知もドラッグの続きとみなす時間
const DRAG_GRACE: Duration = Duration::from_millis(800);

mod panel_class {
    use tauri_nspanel::tauri_panel;

    // キーウィンドウにならない (キー入力・フォーカスを奪わない) パネル。
    // クリックは受け取る (WebView 側で accept_first_mouse を有効にする)
    tauri_panel! {
        panel!(MukuchiPanel {
            config: {
                can_become_key_window: false,
                can_become_main_window: false,
                becomes_key_only_if_needed: true,
                is_floating_panel: true
            }
        })
    }
}
use panel_class::MukuchiPanel;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SettingsCategory {
    General,
    Voice,
    Commands,
    Recognition,
    Permissions,
    Storage,
    About,
}

impl SettingsCategory {
    fn as_str(self) -> &'static str {
        match self {
            Self::General => "general",
            Self::Voice => "voice",
            Self::Commands => "commands",
            Self::Recognition => "recognition",
            Self::Permissions => "permissions",
            Self::Storage => "storage",
            Self::About => "about",
        }
    }
}

#[derive(Clone, Serialize)]
struct Navigate {
    category: SettingsCategory,
}

/// パネルの位置・大きさの状態 (メインスレッドからのみ触るが、Tauri の state に置くため Mutex)
#[derive(Default)]
struct PanelGeom {
    size: (f64, f64),
    /// 置きたい位置 (保存位置・既定位置・ドラッグ先。グローバル座標)。実際の位置は大きさに応じて
    /// 表示中のディスプレイの visibleFrame に収めたもの (大きさが戻れば元の位置に戻る)
    desired: Option<Anchor>,
    /// 表示中のディスプレイ
    display_id: Option<String>,
    /// 最後に Rust が設定したフレーム。これと同じ位置への移動通知は自分の操作 (大きさの変更等)
    last_frame: Option<Rect>,
    /// 最後に配置した時のディスプレイ構成。変わっていたら移動はディスプレイ構成の変化によるもの
    screens_sig: Option<String>,
    /// マウスボタンを押した状態での移動 (利用者のドラッグ) を最後に見た時刻
    last_drag: Option<Instant>,
    /// 利用者が決めた位置。None なら既定位置 (前面ウィンドウのディスプレイの下中央) に追従する
    saved: Option<PanelPosition>,
}

pub struct Windows {
    geom: Mutex<PanelGeom>,
    save_generation: AtomicU64,
}

impl Windows {
    pub fn new(saved: Option<PanelPosition>) -> Self {
        Self {
            geom: Mutex::new(PanelGeom {
                size: PANEL_INITIAL_SIZE,
                saved,
                ..Default::default()
            }),
            save_generation: AtomicU64::new(0),
        }
    }

    fn geom(&self) -> std::sync::MutexGuard<'_, PanelGeom> {
        self.geom.lock().unwrap_or_else(|p| p.into_inner())
    }
}

fn windows(app: &AppHandle) -> Arc<Windows> {
    app.state::<Arc<Windows>>().inner().clone()
}

// ---- panel ------------------------------------------------------------------

/// パネルを作る。`visible` なら表示する (セットアップ完了前は作るだけ)。setup (メインスレッド) から呼ぶ。
pub fn create_panel(app: &AppHandle, visible: bool) -> Result<()> {
    let (w, h) = PANEL_INITIAL_SIZE;
    let panel = PanelBuilder::<_, MukuchiPanel>::new(app, PANEL)
        .url(WebviewUrl::App("index.html".into()))
        .title("mukuchi")
        .size(tauri::Size::Logical(tauri::LogicalSize::new(w, h)))
        // Dock (レベル20) より下の Floating にする。パネル下端の透明な余白が Dock に重なっても
        // Dock のクリックを奪わないため
        .level(PanelLevel::Floating)
        .floating(true)
        .has_shadow(false)
        .transparent(true)
        .hides_on_deactivate(false)
        .becomes_key_only_if_needed(true)
        // 作成時にアプリをアクティブにしない
        .no_activate(true)
        .style_mask(StyleMask::empty().borderless().nonactivating_panel())
        .collection_behavior(
            CollectionBehavior::new()
                .can_join_all_spaces()
                .stationary()
                .ignores_cycle()
                .full_screen_auxiliary(),
        )
        .with_window(|w| {
            w.decorations(false)
                .transparent(true)
                .shadow(false)
                .resizable(false)
                .focusable(false)
                .visible(false)
                // 非アクティブなウィンドウの最初のクリックも WebView (ボタン) に届ける
                .accept_first_mouse(true)
        })
        .build()
        .context("パネルを作成できません")?;
    reposition_panel_on_main(app, true);
    if visible {
        panel.show();
    }
    log_panel_flags(app);
    Ok(())
}

/// パネルを表示する (表示中なら何もしない)。どのスレッドからでも呼べる。
pub fn show_panel(app: &AppHandle) -> Result<()> {
    let app2 = app.clone();
    app.run_on_main_thread(move || {
        let Ok(panel) = app2.get_webview_panel(PANEL) else {
            log::warn!("パネルがありません");
            return;
        };
        if panel.is_visible() {
            return;
        }
        // 隠れている間に Dock・ディスプレイ構成が変わっていることがあるため置き直してから出す
        reposition_panel_on_main(&app2, true);
        panel.show();
        log::info!("パネルを表示");
    })
    .context("メインスレッドに送れません")
}

/// 開発時の確認用に、フォーカスを奪わないための設定をログに出す。
fn log_panel_flags(app: &AppHandle) {
    let Ok(panel) = app.get_webview_panel(PANEL) else {
        return;
    };
    let ns = panel.as_panel();
    log::info!(
        "panel: nonactivating={} canBecomeKey={} canBecomeMain={} becomesKeyOnlyIfNeeded={} floating={} level={}",
        ns.styleMask()
            .contains(objc2_app_kit::NSWindowStyleMask::NonactivatingPanel),
        panel.can_become_key_window(),
        panel.can_become_main_window(),
        panel.becomes_key_only_if_needed(),
        panel.is_floating_panel(),
        ns.level(),
    );
}

/// フロントエンドが決めた大きさにする。下端中央の位置は保ち、表示中のディスプレイに収める。
pub fn set_panel_size(app: &AppHandle, width: f64, height: f64) -> Result<()> {
    if !width.is_finite() || !height.is_finite() {
        anyhow::bail!("大きさが不正です");
    }
    // 整数の pt にする (端数があると中央揃えの丸めでアンカーがずれる)。内容が収まるよう切り上げる
    let w = width.clamp(1.0, 4000.0).ceil();
    let h = height.clamp(1.0, 4000.0).ceil();
    let win = windows(app);
    win.geom().size = (w, h);
    let app2 = app.clone();
    app.run_on_main_thread(move || apply_panel_frame(&app2))
        .context("メインスレッドに送れません")?;
    Ok(())
}

/// ディスプレイ構成 (ID と範囲) を表す文字列。変化の検出に使う
fn screens_signature(mtm: MainThreadMarker) -> String {
    screen::screens(mtm)
        .iter()
        .map(|s| {
            format!(
                "{}:{},{},{},{}",
                s.id, s.frame.x, s.frame.y, s.frame.w, s.frame.h
            )
        })
        .collect::<Vec<_>>()
        .join(";")
}

/// 保存位置 (なければ既定位置) にパネルを置く。`force` でなければ同じディスプレイの同じ位置には動かさない。
fn reposition_panel_on_main(app: &AppHandle, force: bool) {
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let win = windows(app);
    let saved = win.geom().saved.clone();
    let target = saved
        .as_ref()
        .and_then(|p| {
            let s = screen::screen_by_id(mtm, &p.display_id)?;
            Some((s, AnchorOn::from(Anchor::from_relative(p))))
        })
        .or_else(|| {
            // 保存位置がない (またはそのディスプレイが外された) 場合は前面ウィンドウのディスプレイの既定位置
            let s = screen::frontmost_window_screen(mtm)?;
            let a = geometry::default_anchor(&s.visible);
            Some((s, a))
        });
    let Some((scr, anchor)) = target else {
        return;
    };
    let desired = geometry::resolve(anchor, &scr.frame);
    let sig = screens_signature(mtm);
    let mut g = win.geom();
    let same = g.display_id.as_deref() == Some(scr.id.as_str())
        && g.desired.is_some_and(|a| a.approx_eq(&desired))
        && g.screens_sig.as_deref() == Some(sig.as_str());
    if !force && same {
        return;
    }
    g.desired = Some(desired);
    g.display_id = Some(scr.id);
    g.screens_sig = Some(sig);
    drop(g);
    apply_panel_frame(app);
}

/// 置きたい位置と大きさから、表示中のディスプレイに収めたフレームを設定する (メインスレッド)。
fn apply_panel_frame(app: &AppHandle) {
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let Ok(panel) = app.get_webview_panel(PANEL) else {
        return;
    };
    let win = windows(app);
    let mut g = win.geom();
    let Some(desired) = g.desired else {
        return;
    };
    // Dock・メニューバーの大きさは変わりうるため、その都度ディスプレイの visibleFrame を読む
    let visible = g
        .display_id
        .as_deref()
        .and_then(|id| screen::screen_by_id(mtm, id))
        .or_else(|| screen::screen_at(mtm, (desired.cx, desired.bottom)))
        .map(|s| s.visible);
    let anchor = match visible {
        Some(v) => geometry::clamp_anchor(desired, g.size, &v),
        None => desired,
    };
    let r = geometry::frame_for(anchor, g.size);
    let current = screen::to_rect(panel.as_panel().frame());
    if g.last_frame == Some(r) && current.approx_eq(&r) {
        return;
    }
    // 移動通知 (on_panel_moved) が setFrame の中から同期的に来ても自分の操作と分かるよう、先に記録する
    g.last_frame = Some(r);
    drop(g);
    if cfg!(debug_assertions) {
        // 開発時の確認用 (パネルのクリック試験で位置を知るため)
        log::info!("panel frame: x={} y={} w={} h={}", r.x, r.y, r.w, r.h);
    }
    panel.as_panel().setFrame_display(
        NSRect::new(NSPoint::new(r.x, r.y), NSSize::new(r.w, r.h)),
        true,
    );
}

/// 表示位置の見直し (定期実行)。既定位置に追従している間は前面ウィンドウのディスプレイへ移る。
pub fn refresh_panel_position(app: &AppHandle) {
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        if is_dragging(&windows(&app2).geom()) {
            return;
        }
        reposition_panel_on_main(&app2, false)
    });
}

/// マウスの左ボタンが押されているか
fn mouse_down() -> bool {
    NSEvent::pressedMouseButtons() & 1 != 0
}

/// 利用者がドラッグ中 (または離した直後) か
fn is_dragging(g: &PanelGeom) -> bool {
    mouse_down() && g.last_drag.is_some() || g.last_drag.is_some_and(|t| t.elapsed() < DRAG_GRACE)
}

/// パネルが動いた (Tauri の Moved)。メインスレッドで呼ばれる。
///
/// 位置を保存するのは利用者のドラッグ (マウスボタンを押したままの移動) だけ。
/// ディスプレイの取り外し・解像度の変更で AppKit がパネルを動かした場合は保存せず、
/// 保存位置 (そのディスプレイがなければ既定位置) に置き直す。
pub fn on_panel_moved(app: &AppHandle) {
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let Ok(panel) = app.get_webview_panel(PANEL) else {
        return;
    };
    let frame = screen::to_rect(panel.as_panel().frame());
    let win = windows(app);
    let mut g = win.geom();
    if g.last_frame.is_some_and(|f| f.approx_eq(&frame)) {
        // Rust が設定した位置 (大きさの変更を含む)
        return;
    }
    let screens_changed = g.screens_sig.as_deref() != Some(screens_signature(mtm).as_str());
    let pressed = mouse_down();
    if screens_changed || !(pressed || is_dragging(&g)) {
        drop(g);
        log::info!("パネルがシステムにより移動された (ディスプレイ構成の変化等)。保存せず置き直す");
        reposition_panel_on_main(app, true);
        return;
    }
    if pressed {
        g.last_drag = Some(Instant::now());
    }
    // ディスプレイはピル (ウィンドウ) の中心で決める。下端は影の余白で画面外に出ていることがある
    let Some(scr) = screen::screen_at(mtm, frame.center()) else {
        return;
    };
    let anchor = Anchor::of_frame(&frame);
    g.last_frame = Some(frame);
    g.desired = Some(anchor);
    g.display_id = Some(scr.id.clone());
    // 見回りがドラッグ中に保存位置へ引き戻さないよう、保存前でも利用者の位置として持つ
    g.saved = Some(anchor.to_relative(&scr));
    drop(g);

    // ドラッグ中は何度も呼ばれるため、止まってから保存する
    let generation = win.save_generation.fetch_add(1, Ordering::SeqCst) + 1;
    schedule_drag_end(app.clone(), generation);
}

fn schedule_drag_end(app: AppHandle, generation: u64) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(SAVE_POSITION_DELAY).await;
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || finish_drag(&app2, generation));
    });
}

/// ドラッグが止まった。ボタンを離していれば、画面内に収めた位置に置いて保存する (メインスレッド)。
fn finish_drag(app: &AppHandle, generation: u64) {
    let win = windows(app);
    if win.save_generation.load(Ordering::SeqCst) != generation {
        return;
    }
    if mouse_down() {
        // 押したまま止まっている。離すまで待つ (ドラッグ中にパネルを動かさない)
        schedule_drag_end(app.clone(), generation);
        return;
    }
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let mut g = win.geom();
    g.last_drag = None;
    let (Some(desired), Some(id)) = (g.desired, g.display_id.clone()) else {
        return;
    };
    let Some(scr) = screen::screen_by_id(mtm, &id) else {
        return;
    };
    // 画面外 (Dock・メニューバーの下) に置かれた分は収めてから保存する
    let anchor = geometry::clamp_anchor(desired, g.size, &scr.visible);
    let pos = anchor.to_relative(&scr);
    g.desired = Some(geometry::resolve(
        Anchor::from_relative(&pos).into(),
        &scr.frame,
    ));
    g.saved = Some(pos.clone());
    g.screens_sig = Some(screens_signature(mtm));
    drop(g);
    apply_panel_frame(app);

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let core = app.state::<Arc<Core>>().inner().clone();
        let patch = serde_json::json!({ "panelPosition": pos });
        if let Err(e) = core.update_settings(&patch) {
            log::warn!("パネルの位置を保存できません: {e:#}");
        }
    });
}

/// 設定の panelPosition が外から変わった (既定位置へ戻す等) 場合に反映する。
pub fn on_settings_panel_position(app: &AppHandle, pos: Option<PanelPosition>) {
    let win = windows(app);
    {
        let mut g = win.geom();
        if g.saved == pos {
            return;
        }
        g.saved = pos;
    }
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || reposition_panel_on_main(&app2, true));
}

// ---- settings / setup -------------------------------------------------------

/// 設定ウィンドウを開く。開いていれば前面に出し、カテゴリを切り替える。
pub fn open_settings(app: &AppHandle, category: Option<SettingsCategory>) -> Result<()> {
    if let Some(w) = app.get_webview_window(SETTINGS) {
        show_regular(app, &w)?;
        if let Some(category) = category {
            app.emit_to(SETTINGS, SETTINGS_NAVIGATE, Navigate { category })
                .context("カテゴリを切り替えられません")?;
        }
        return Ok(());
    }
    let url = match category {
        Some(c) => format!("index.html?category={}", c.as_str()),
        None => "index.html".into(),
    };
    let w = WebviewWindowBuilder::new(app, SETTINGS, WebviewUrl::App(url.into()))
        .title("mukuchi 設定")
        .inner_size(760.0, 560.0)
        .resizable(false)
        .maximizable(false)
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(LogicalPosition::new(14.0, 16.0))
        .center()
        .visible(false)
        .build()
        .context("設定ウィンドウを作成できません")?;
    show_regular(app, &w)
}

pub fn open_setup(app: &AppHandle) -> Result<()> {
    if let Some(w) = app.get_webview_window(SETUP) {
        return show_regular(app, &w);
    }
    let w = WebviewWindowBuilder::new(app, SETUP, WebviewUrl::App("index.html".into()))
        .title("mukuchi セットアップ")
        .inner_size(560.0, 440.0)
        .resizable(false)
        .maximizable(false)
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(LogicalPosition::new(14.0, 12.0))
        .center()
        .visible(false)
        .build()
        .context("セットアップウィンドウを作成できません")?;
    show_regular(app, &w)
}

pub fn close_setup(app: &AppHandle) -> Result<()> {
    if let Some(w) = app.get_webview_window(SETUP) {
        w.destroy()
            .context("セットアップウィンドウを閉じられません")?;
    }
    Ok(())
}

/// Dock に出してから表示・前面化する (Accessory のままだとウィンドウが前面に来ないことがある)。
fn show_regular(app: &AppHandle, w: &tauri::WebviewWindow) -> Result<()> {
    app.set_activation_policy(ActivationPolicy::Regular)
        .context("Dock 表示を切り替えられません")?;
    w.show().context("ウィンドウを表示できません")?;
    w.unminimize().ok();
    w.set_focus().context("ウィンドウを前面に出せません")?;
    Ok(())
}

/// settings / setup が1つも表示されていなければ Dock から消す。
/// ウィンドウの破棄 (Destroyed) の後に呼ぶ。
pub fn update_activation_policy(app: &AppHandle, closing: Option<&str>) {
    let any_visible = [SETTINGS, SETUP].iter().any(|label| {
        Some(*label) != closing
            && app
                .get_webview_window(label)
                .is_some_and(|w| w.is_visible().unwrap_or(false))
    });
    let policy = if any_visible {
        ActivationPolicy::Regular
    } else {
        ActivationPolicy::Accessory
    };
    if let Err(e) = app.set_activation_policy(policy) {
        log::warn!("Dock 表示を切り替えられません: {e}");
    }
}

// ---- 位置計算 (テスト可能な純粋関数) -----------------------------------------

pub mod geometry {
    use serde::{Deserialize, Serialize};

    use crate::macos::screen::ScreenInfo;
    use crate::settings::PanelPosition;

    /// パネルのピルと Dock の上端の間 (デザイン 03)
    pub const DOCK_GAP: f64 = 16.0;
    /// フロントエンドがピルの下に取る影の余白
    pub const SHADOW_BOTTOM: f64 = 32.0;

    /// AppKit 座標 (左下原点、y 上向き) の矩形
    #[derive(Debug, Clone, Copy, PartialEq)]
    pub struct Rect {
        pub x: f64,
        pub y: f64,
        pub w: f64,
        pub h: f64,
    }

    impl Rect {
        pub fn contains(&self, (px, py): (f64, f64)) -> bool {
            px >= self.x && px < self.x + self.w && py >= self.y && py < self.y + self.h
        }

        pub fn center(&self) -> (f64, f64) {
            (self.x + self.w / 2.0, self.y + self.h / 2.0)
        }

        /// 位置・大きさが 1pt 未満の差で一致するか (AppKit が端数を丸めることがあるため)
        pub fn approx_eq(&self, o: &Rect) -> bool {
            (self.x - o.x).abs() < 1.0
                && (self.y - o.y).abs() < 1.0
                && (self.w - o.w).abs() < 1.0
                && (self.h - o.h).abs() < 1.0
        }

        pub fn distance_sq(&self, (px, py): (f64, f64)) -> f64 {
            let dx = (self.x - px).max(0.0).max(px - (self.x + self.w));
            let dy = (self.y - py).max(0.0).max(py - (self.y + self.h));
            dx * dx + dy * dy
        }
    }

    /// パネルのウィンドウの下端中央 (グローバル座標)。cx・bottom は整数に保つ
    /// (奇数幅でも `frame_for` と `of_frame` が往復で一致するように)
    #[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
    pub struct Anchor {
        pub cx: f64,
        pub bottom: f64,
    }

    impl Anchor {
        /// `frame_for` の逆。x = floor(cx - w/2) なので cx = floor(x + w/2 + 0.5) で戻る
        pub fn of_frame(r: &Rect) -> Self {
            Self {
                cx: (r.x + r.w / 2.0 + 0.5).floor(),
                bottom: r.y.round(),
            }
        }

        pub fn approx_eq(&self, o: &Anchor) -> bool {
            (self.cx - o.cx).abs() < 1.0 && (self.bottom - o.bottom).abs() < 1.0
        }

        /// 保存形式 (ディスプレイの左下からの相対位置) から戻す。ディスプレイは呼び出し側が選ぶ
        pub fn from_relative(p: &PanelPosition) -> RelativeAnchor {
            RelativeAnchor { x: p.x, y: p.y }
        }

        pub fn to_relative(self, s: &ScreenInfo) -> PanelPosition {
            PanelPosition {
                x: (self.cx - s.frame.x).round(),
                y: (self.bottom - s.frame.y).round(),
                display_id: s.id.clone(),
            }
        }
    }

    /// ディスプレイ内の相対位置 (まだディスプレイに置いていないアンカー)
    #[derive(Debug, Clone, Copy, PartialEq)]
    pub struct RelativeAnchor {
        pub x: f64,
        pub y: f64,
    }

    /// 既定位置: ピルの下端が Dock の上端 (visibleFrame の下端) から 16pt 上。
    /// ウィンドウはピルの下に影の余白 32pt を含むため、ウィンドウの下端は Dock 上端 +16 −32
    pub fn default_anchor(visible: &Rect) -> AnchorOn {
        AnchorOn::Global(Anchor {
            cx: visible.x + visible.w / 2.0,
            bottom: visible.y + DOCK_GAP - SHADOW_BOTTOM,
        })
    }

    /// グローバル座標か、ディスプレイ内の相対位置か
    #[derive(Debug, Clone, Copy, PartialEq)]
    pub enum AnchorOn {
        Global(Anchor),
        Relative(RelativeAnchor),
    }

    impl From<RelativeAnchor> for AnchorOn {
        fn from(r: RelativeAnchor) -> Self {
            Self::Relative(r)
        }
    }

    /// ディスプレイ内の相対位置をグローバル座標にする (整数に丸める)。
    pub fn resolve(a: AnchorOn, frame: &Rect) -> Anchor {
        let a = match a {
            AnchorOn::Global(a) => a,
            AnchorOn::Relative(r) => Anchor {
                cx: frame.x + r.x,
                bottom: frame.y + r.y,
            },
        };
        Anchor {
            cx: a.cx.round(),
            bottom: a.bottom.round(),
        }
    }

    /// ピルが領域 (ディスプレイの visibleFrame) の外に出ないよう収める。
    /// 影の余白 (ウィンドウ下端の SHADOW_BOTTOM) だけは下にはみ出してよい。結果は整数。
    pub fn clamp_anchor(a: Anchor, size: (f64, f64), area: &Rect) -> Anchor {
        let (w, h) = size;
        let cx = if w >= area.w {
            area.x + area.w / 2.0
        } else {
            // 左右とも収まる範囲 (x = floor(cx - w/2) が area 内、右端も area 内)
            let lo = (area.x + w / 2.0).ceil();
            let hi = (area.x + area.w - w / 2.0).floor().max(lo);
            a.cx.clamp(lo, hi)
        };
        let lo = area.y - SHADOW_BOTTOM;
        let hi = (area.y + area.h - h).max(lo);
        Anchor {
            cx: cx.round(),
            bottom: a.bottom.clamp(lo, hi).round(),
        }
    }

    pub fn frame_for(a: Anchor, (w, h): (f64, f64)) -> Rect {
        Rect {
            x: (a.cx - w / 2.0).floor(),
            y: a.bottom.round(),
            w,
            h,
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn screen() -> ScreenInfo {
            ScreenInfo {
                id: "1".into(),
                frame: Rect {
                    x: 0.0,
                    y: 0.0,
                    w: 1512.0,
                    h: 982.0,
                },
                // Dock 下 (高さ 70) とメニューバー (33)
                visible: Rect {
                    x: 0.0,
                    y: 70.0,
                    w: 1512.0,
                    h: 879.0,
                },
            }
        }

        fn place(a: AnchorOn, size: (f64, f64), s: &ScreenInfo) -> Anchor {
            clamp_anchor(resolve(a, &s.frame), size, &s.visible)
        }

        #[test]
        fn default_is_bottom_center_above_dock() {
            let s = screen();
            let a = place(default_anchor(&s.visible), (320.0, 100.0), &s);
            assert_eq!(a.cx, 756.0);
            // ピル下端 = 70 + 16、ウィンドウ下端はその 32 下
            assert_eq!(a.bottom, 70.0 + 16.0 - 32.0);
            let f = frame_for(a, (320.0, 100.0));
            assert_eq!((f.x, f.y), (596.0, 54.0));
        }

        #[test]
        fn resize_keeps_bottom_center() {
            let s = screen();
            let a = place(default_anchor(&s.visible), (320.0, 100.0), &s);
            let small = frame_for(a, (320.0, 100.0));
            let big = frame_for(a, (520.0, 180.0));
            assert_eq!(Anchor::of_frame(&small), Anchor::of_frame(&big));
            assert_eq!(small.y, big.y);
        }

        #[test]
        fn saved_position_roundtrip_and_clamp() {
            let s = screen();
            let a = Anchor {
                cx: 300.0,
                bottom: 500.0,
            };
            let rel = a.to_relative(&s);
            assert_eq!((rel.x, rel.y), (300.0, 500.0));
            let back = place(Anchor::from_relative(&rel).into(), (320.0, 100.0), &s);
            assert!(back.approx_eq(&a));
            // 画面外 (ディスプレイ構成の変化等) は visibleFrame に収める
            let off = place(
                RelativeAnchor {
                    x: -500.0,
                    y: 5000.0,
                }
                .into(),
                (320.0, 100.0),
                &s,
            );
            assert_eq!(off.cx, 160.0);
            // メニューバーの下 (visible の上端 70+879=949)
            assert_eq!(off.bottom, 949.0 - 100.0);
        }

        /// 奇数幅でも、Rust が置いたフレームから求めたアンカーが元と一致する (0.5pt ずれない)
        #[test]
        fn odd_width_roundtrip_has_no_drift() {
            let s = screen();
            let a = place(default_anchor(&s.visible), (321.0, 100.0), &s);
            let mut cur = a;
            for w in [321.0, 241.0, 440.0, 333.0, 1.0, 999.0] {
                let f = frame_for(cur, (w, 100.0));
                assert_eq!(f.x, f.x.floor());
                let back = Anchor::of_frame(&f);
                assert_eq!(back, cur, "width {w}");
                cur = back;
            }
            assert_eq!(cur, a);
            // 負の座標 (主ディスプレイの左にあるディスプレイ) でも同じ
            let neg = Anchor {
                cx: -757.0,
                bottom: -20.0,
            };
            for w in [321.0, 320.0] {
                assert_eq!(Anchor::of_frame(&frame_for(neg, (w, 50.0))), neg);
            }
        }

        /// 大きさを変えるたびに visibleFrame へ収める。元の大きさに戻れば元の位置に戻る
        #[test]
        fn resize_clamps_to_visible_and_restores() {
            let s = screen();
            let desired = Anchor {
                cx: 1400.0,
                bottom: 900.0,
            };
            let small = clamp_anchor(desired, (200.0, 36.0), &s.visible);
            assert_eq!(small, desired);
            let big = clamp_anchor(desired, (441.0, 180.0), &s.visible);
            let f = frame_for(big, (441.0, 180.0));
            assert!(f.x + f.w <= s.visible.x + s.visible.w);
            assert!(f.y + f.h <= s.visible.y + s.visible.h);
            assert_eq!(clamp_anchor(desired, (200.0, 36.0), &s.visible), desired);
            // 影の余白は Dock 側 (下) にはみ出してよいが、ピルは Dock に重ならない
            let low = clamp_anchor(
                Anchor {
                    cx: 700.0,
                    bottom: 0.0,
                },
                (320.0, 100.0),
                &s.visible,
            );
            assert_eq!(low.bottom, 70.0 - SHADOW_BOTTOM);
        }

        #[test]
        fn rect_center_and_approx() {
            let r = Rect {
                x: 10.0,
                y: -20.0,
                w: 321.0,
                h: 100.0,
            };
            assert_eq!(r.center(), (170.5, 30.0));
            let mut o = r;
            o.x += 0.5;
            assert!(r.approx_eq(&o));
            o.x += 0.6;
            assert!(!r.approx_eq(&o));
        }

        #[test]
        fn rect_distance() {
            let r = Rect {
                x: 0.0,
                y: 0.0,
                w: 10.0,
                h: 10.0,
            };
            assert!(r.contains((5.0, 5.0)));
            assert_eq!(r.distance_sq((5.0, 5.0)), 0.0);
            assert_eq!(r.distance_sq((13.0, 14.0)), 9.0 + 16.0);
        }
    }
}
