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
use std::time::Duration;

use anyhow::{Context, Result};
use objc2::MainThreadMarker;
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
use geometry::{Anchor, AnchorOn};

pub const PANEL: &str = "panel";
pub const SETTINGS: &str = "settings";
pub const SETUP: &str = "setup";

pub const SETTINGS_NAVIGATE: &str = "settings-navigate";

/// パネルの初期の大きさ (フロントエンドが set_panel_size で決めるまでの仮の値)
const PANEL_INITIAL_SIZE: (f64, f64) = (320.0, 100.0);
/// ドラッグ後、位置を保存するまでの待ち (ドラッグ中に何度も書き込まない)
const SAVE_POSITION_DELAY: Duration = Duration::from_millis(500);

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
    /// 最後に Rust が設定したアンカー (グローバル座標)。これと違う位置への移動は利用者のドラッグ
    anchor: Option<Anchor>,
    /// 表示中のディスプレイ
    display_id: Option<String>,
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

/// パネルを作って表示する。setup (メインスレッド) から呼ぶ。
pub fn create_panel(app: &AppHandle) -> Result<()> {
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
    panel.show();
    log_panel_flags(app);
    Ok(())
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

/// フロントエンドが決めた大きさにする。下端中央の位置は保つ。
pub fn set_panel_size(app: &AppHandle, width: f64, height: f64) -> Result<()> {
    let w = width.clamp(1.0, 4000.0);
    let h = height.clamp(1.0, 4000.0);
    if !w.is_finite() || !h.is_finite() {
        anyhow::bail!("大きさが不正です");
    }
    let win = windows(app);
    win.geom().size = (w, h);
    let app2 = app.clone();
    app.run_on_main_thread(move || apply_panel_frame(&app2))
        .context("メインスレッドに送れません")?;
    Ok(())
}

/// 保存位置 (なければ既定位置) にパネルを置く。`force` でなければ同じディスプレイの既定位置には動かさない。
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
    let mut g = win.geom();
    let anchor = geometry::clamp_anchor(anchor, g.size, &scr.frame);
    let same_display = g.display_id.as_deref() == Some(scr.id.as_str());
    if !force && same_display && g.anchor.is_some_and(|a| a.approx_eq(&anchor)) {
        return;
    }
    g.anchor = Some(anchor);
    g.display_id = Some(scr.id);
    drop(g);
    apply_panel_frame(app);
}

/// 現在のアンカーと大きさでフレームを設定する (メインスレッド)。
fn apply_panel_frame(app: &AppHandle) {
    let Ok(panel) = app.get_webview_panel(PANEL) else {
        return;
    };
    let (anchor, size) = {
        let win = windows(app);
        let g = win.geom();
        (g.anchor, g.size)
    };
    let Some(anchor) = anchor else {
        return;
    };
    let r = geometry::frame_for(anchor, size);
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
    let _ = app.run_on_main_thread(move || reposition_panel_on_main(&app2, false));
}

/// パネルが動いた (Tauri の Moved)。利用者のドラッグなら位置を保存する。メインスレッドで呼ばれる。
pub fn on_panel_moved(app: &AppHandle) {
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let Ok(panel) = app.get_webview_panel(PANEL) else {
        return;
    };
    let frame = screen::to_rect(panel.as_panel().frame());
    let anchor = Anchor::of_frame(&frame);
    let win = windows(app);
    let mut g = win.geom();
    if g.anchor.is_some_and(|a| a.approx_eq(&anchor)) {
        // Rust が設定した位置 (大きさの変更を含む)
        return;
    }
    let Some(scr) = screen::screen_at(mtm, (anchor.cx, anchor.bottom)) else {
        return;
    };
    let pos = anchor.to_relative(&scr);
    g.anchor = Some(anchor);
    g.display_id = Some(scr.id.clone());
    g.saved = Some(pos.clone());
    drop(g);

    // ドラッグ中は何度も呼ばれるため、止まってから保存する
    let generation = win.save_generation.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(SAVE_POSITION_DELAY).await;
        if windows(&app).save_generation.load(Ordering::SeqCst) != generation {
            return;
        }
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

        pub fn distance_sq(&self, (px, py): (f64, f64)) -> f64 {
            let dx = (self.x - px).max(0.0).max(px - (self.x + self.w));
            let dy = (self.y - py).max(0.0).max(py - (self.y + self.h));
            dx * dx + dy * dy
        }
    }

    /// パネルのウィンドウの下端中央 (グローバル座標)
    #[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
    pub struct Anchor {
        pub cx: f64,
        pub bottom: f64,
    }

    impl Anchor {
        pub fn of_frame(r: &Rect) -> Self {
            Self {
                cx: r.x + r.w / 2.0,
                bottom: r.y,
            }
        }

        pub fn approx_eq(&self, o: &Anchor) -> bool {
            (self.cx - o.cx).abs() < 0.5 && (self.bottom - o.bottom).abs() < 0.5
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

    /// ピルがディスプレイの外に出ないよう収める (影の余白は下にはみ出してよい)。
    pub fn clamp_anchor(a: impl Into<AnchorOn>, size: (f64, f64), frame: &Rect) -> Anchor {
        let a = match a.into() {
            AnchorOn::Global(a) => a,
            AnchorOn::Relative(r) => Anchor {
                cx: frame.x + r.x,
                bottom: frame.y + r.y,
            },
        };
        let (w, h) = size;
        let cx = if w >= frame.w {
            frame.x + frame.w / 2.0
        } else {
            a.cx.clamp(frame.x + w / 2.0, frame.x + frame.w - w / 2.0)
        };
        let lo = frame.y - SHADOW_BOTTOM;
        let hi = (frame.y + frame.h - h).max(lo);
        Anchor {
            cx,
            bottom: a.bottom.clamp(lo, hi),
        }
    }

    pub fn frame_for(a: Anchor, (w, h): (f64, f64)) -> Rect {
        Rect {
            x: (a.cx - w / 2.0).round(),
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

        #[test]
        fn default_is_bottom_center_above_dock() {
            let s = screen();
            let a = clamp_anchor(default_anchor(&s.visible), (320.0, 100.0), &s.frame);
            assert_eq!(a.cx, 756.0);
            // ピル下端 = 70 + 16、ウィンドウ下端はその 32 下
            assert_eq!(a.bottom, 70.0 + 16.0 - 32.0);
            let f = frame_for(a, (320.0, 100.0));
            assert_eq!((f.x, f.y), (596.0, 54.0));
        }

        #[test]
        fn resize_keeps_bottom_center() {
            let s = screen();
            let a = clamp_anchor(default_anchor(&s.visible), (320.0, 100.0), &s.frame);
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
            let back = clamp_anchor(Anchor::from_relative(&rel), (320.0, 100.0), &s.frame);
            assert!(back.approx_eq(&a));
            // 画面外 (ディスプレイ構成の変化等) は収める
            let off = clamp_anchor(
                RelativeAnchor {
                    x: -500.0,
                    y: 5000.0,
                },
                (320.0, 100.0),
                &s.frame,
            );
            assert_eq!(off.cx, 160.0);
            assert_eq!(off.bottom, 982.0 - 100.0);
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
