//! ウィンドウ管理。
//!
//! - `panel`: フォーカスを奪わない常時表示パネル (NSPanel, non-activating。tauri-nspanel)。
//!   大きさはフロントエンドが `set_panel_size` で決め、Rust はピルのアンカー点 (位置に応じた辺・角) を固定して
//!   大きさを変え、visibleFrame からはみ出す分だけずらす (詳細は `geometry`)。アンカーは `panel-anchor` で送る。
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
use crate::i18n::Msg;
use crate::macos::{activation, screen};
use crate::settings::PanelPosition;
use geometry::{PanelAnchor, Point, Rect};

pub const PANEL: &str = "panel";
pub const SETTINGS: &str = "settings";
pub const SETUP: &str = "setup";

pub const SETTINGS_NAVIGATE: &str = "settings-navigate";
pub const PANEL_ANCHOR: &str = "panel-anchor";

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
    /// 利用者の位置 (ピルのアンカー点。保存位置・既定位置・ドラッグ先。グローバル座標)。
    /// 実際の位置は大きさに応じて表示中のディスプレイの visibleFrame に収めたもの (大きさが戻れば元の位置に戻る)
    desired: Option<Point>,
    /// 表示中のディスプレイ
    display_id: Option<String>,
    /// 最後にフロントエンドへ送ったアンカー
    anchor: Option<PanelAnchor>,
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

/// パネルの位置を設定に保存する (利用者のドラッグ・旧形式の移行のみ。大きさによる自動のずれは保存しない)
fn persist_panel_position(app: &AppHandle, pos: PanelPosition) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let core = app.state::<Arc<Core>>().inner().clone();
        let patch = serde_json::json!({ "panelPosition": pos });
        if let Err(e) = core.update_settings(&patch) {
            log::warn!("パネルの位置を保存できません: {e:#}");
        }
    });
}

/// アンカーが変わっていれば記録して panel に送る。ロックの外で送るため、送るべきものを返す
fn note_anchor(g: &mut PanelGeom, a: PanelAnchor) -> Option<PanelAnchor> {
    if g.anchor == Some(a) {
        return None;
    }
    g.anchor = Some(a);
    Some(a)
}

fn emit_anchor(app: &AppHandle, a: PanelAnchor) {
    if let Err(e) = app.emit_to(PANEL, PANEL_ANCHOR, a) {
        log::warn!("panel-anchor を送れません: {e}");
    }
}

/// 現在のアンカー (panel の読み込み直後、イベントを待たずに取るため)
pub fn panel_anchor(app: &AppHandle) -> PanelAnchor {
    windows(app).geom().anchor.unwrap_or_default()
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
    // tauri-nspanel が後から付ける nonactivating はウィンドウサーバーに伝わらないため直接設定する
    // (詳細は activation::prevent_activation)。ないとパネルのクリックで入力先のアプリがフォーカスを失う
    ensure_prevents_activation(app);
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
        // 表示し直しで戻ることがないよう念のため再設定する (読み返して確認する)
        ensure_prevents_activation(&app2);
        log::info!("パネルを表示");
    })
    .context("メインスレッドに送れません")
}

/// パネルのクリックで mukuchi を前面アプリにしない設定をする (メインスレッド)。
fn ensure_prevents_activation(app: &AppHandle) {
    let Ok(panel) = app.get_webview_panel(PANEL) else {
        return;
    };
    if !activation::prevent_activation(panel.as_panel()) {
        log::error!(
            "パネルのクリックで mukuchi が前面アプリになるのを防げません (この macOS では未対応)"
        );
    }
}

/// 開発時の確認用に、フォーカスを奪わないための設定をログに出す。
fn log_panel_flags(app: &AppHandle) {
    let Ok(panel) = app.get_webview_panel(PANEL) else {
        return;
    };
    let ns = panel.as_panel();
    log::info!(
        "panel: nonactivating={} preventsActivation={:?} canBecomeKey={} canBecomeMain={} becomesKeyOnlyIfNeeded={} floating={} level={}",
        ns.styleMask()
            .contains(objc2_app_kit::NSWindowStyleMask::NonactivatingPanel),
        activation::prevents_activation(ns),
        panel.can_become_key_window(),
        panel.can_become_main_window(),
        panel.becomes_key_only_if_needed(),
        panel.is_floating_panel(),
        ns.level(),
    );
}

/// フロントエンドが決めた大きさにする。アンカー点は保ち、表示中のディスプレイに収める。
pub fn set_panel_size(app: &AppHandle, width: f64, height: f64) -> Result<()> {
    if !width.is_finite() || !height.is_finite() {
        anyhow::bail!("大きさが不正です");
    }
    // 整数の pt にする (端数があると中央揃えの丸めでアンカー点がずれる)。内容が収まるよう切り上げる
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
    let (saved, size) = {
        let g = win.geom();
        (g.saved.clone(), g.size)
    };
    let from_saved = saved.as_ref().and_then(|p| {
        let s = screen::screen_by_id(mtm, &p.display_id)?;
        Some((s, p))
    });
    let target = match from_saved {
        Some((s, p)) => {
            let pos = if p.version < PanelPosition::CURRENT_VERSION {
                // 旧形式 (ウィンドウの下端中央) は今の大きさで見た目の位置を変えずに移行し、保存し直す
                let migrated = geometry::migrate(p, size, &s);
                log::info!("パネルの位置を新しい形式に移行");
                win.geom().saved = Some(migrated.clone());
                persist_panel_position(app, migrated.clone());
                migrated
            } else {
                p.clone()
            };
            let point = geometry::from_relative(&pos, &s.frame);
            Some((s, point))
        }
        // 保存位置がない (またはそのディスプレイが外された) 場合は前面ウィンドウのディスプレイの既定位置
        None => screen::frontmost_window_screen(mtm).map(|s| {
            let p = geometry::default_point(&s.visible);
            (s, p)
        }),
    };
    let Some((scr, desired)) = target else {
        return;
    };
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

/// 利用者の位置と大きさから、表示中のディスプレイに収めたフレームを設定する (メインスレッド)。
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
        .or_else(|| screen::screen_at(mtm, (desired.x, desired.y)))
        .map(|s| s.visible);
    let Some(visible) = visible else {
        return;
    };
    let (r, anchor) = geometry::place(desired, g.size, &visible);
    let changed_anchor = note_anchor(&mut g, anchor);
    let current = screen::to_rect(panel.as_panel().frame());
    let same_frame = g.last_frame == Some(r) && current.approx_eq(&r);
    if !same_frame {
        // 移動通知 (on_panel_moved) が setFrame の中から同期的に来ても自分の操作と分かるよう、先に記録する
        g.last_frame = Some(r);
    }
    drop(g);
    // 大きさを変える前に送る (フロントエンドが新しい基準で描き始められるように)
    if let Some(a) = changed_anchor {
        emit_anchor(app, a);
    }
    if same_frame {
        return;
    }
    if cfg!(debug_assertions) {
        // 開発時の確認用 (パネルのクリック試験で位置を知るため)
        log::info!(
            "panel frame: x={} y={} w={} h={} anchor={:?}",
            r.x,
            r.y,
            r.w,
            r.h,
            anchor
        );
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
    // ディスプレイはピル (影の余白を除いた部分) の中心で決める。影の余白は画面外に出ていることがある
    let Some(scr) = screen::screen_at(mtm, geometry::content_of(&frame).center()) else {
        return;
    };
    let (point, anchor) = geometry::point_of_frame(&frame, &scr.visible);
    g.last_frame = Some(frame);
    g.desired = Some(point);
    g.display_id = Some(scr.id.clone());
    // 見回りがドラッグ中に保存位置へ引き戻さないよう、保存前でも利用者の位置として持つ
    g.saved = Some(geometry::to_relative(point, &scr));
    let changed_anchor = note_anchor(&mut g, anchor);
    drop(g);
    if let Some(a) = changed_anchor {
        emit_anchor(app, a);
    }

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
    // 画面外 (Dock・メニューバーの下) に置かれた分は収めてから保存する。
    // ここで収めるのは利用者が置いた位置の補正なので保存する (大きさの変更による自動のずれとは別)
    let (frame, _) = geometry::place(desired, g.size, &scr.visible);
    let (point, _) = geometry::point_of_frame(&frame, &scr.visible);
    let pos = geometry::to_relative(point, &scr);
    g.desired = Some(point);
    g.saved = Some(pos.clone());
    g.screens_sig = Some(screens_signature(mtm));
    drop(g);
    apply_panel_frame(app);
    persist_panel_position(app, pos);
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
        .title(Msg::WindowSettings.to_string())
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
        .title(Msg::WindowSetup.to_string())
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

/// Finder・Spotlight 等からの再度の起動 (Reopen) や2つ目のプロセスの起動時に、
/// Dock に出ない常駐アプリでも画面を開けるようにする。セットアップ未完了ならセットアップを開く
pub fn open_on_relaunch(app: &AppHandle) {
    // 起動処理 (setup) の完了前は何もしない (起動処理がセットアップの要否を決める)
    let Some(core) = app.try_state::<Arc<Core>>() else {
        return;
    };
    let result = if core.settings.get().setup_completed {
        open_settings(app, None)
    } else {
        open_setup(app)
    };
    if let Err(e) = result {
        log::error!("再起動時に画面を開けません: {e:#}");
    }
}

/// 表示言語の変更時: 開いているウィンドウのタイトルを今の表示言語にする
/// (タイトルは隠しているが、ウィンドウの一覧・アクセシビリティに出るため)
pub fn relocalize_titles(app: &AppHandle) {
    for (label, msg) in [(SETTINGS, Msg::WindowSettings), (SETUP, Msg::WindowSetup)] {
        if let Some(w) = app.get_webview_window(label) {
            if let Err(e) = w.set_title(&msg.to_string()) {
                log::warn!("ウィンドウのタイトルを変えられません ({label}): {e}");
            }
        }
    }
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

/// パネルの位置の考え方:
///
/// - 利用者の位置は「ピル (描画内容からフロントエンドの影の余白を除いた部分) のアンカー点」1 点で持つ。
/// - アンカー (どの辺・角を固定して大きさを変えるか) はその点の、ディスプレイの visibleFrame 内での位置で決まる:
///   左右は 3 等分 (左 / 中央 / 右)、上下は 2 等分 (上 / 下)。
/// - アンカー点はピルの、アンカーに当たる辺・角 (例: 右上なら右上の角、中央下なら下辺の中央)。
///   ピルの中心でアンカーを決めてからその角を取っても、角は中心より外側にあるため同じアンカーに分類される
///   (`anchor_at(anchor_point(c, anchor_at(center(c)))) == anchor_at(center(c))`)。
///   そのため保存するのは点だけでよい。
/// - 大きさを変える時はアンカー点を固定してピルを置き、ピルが visibleFrame からはみ出す分だけずらす。
///   ずらした結果は保存しないため、小さく戻れば利用者の位置に戻る。
pub mod geometry {
    use serde::Serialize;

    use crate::macos::screen::ScreenInfo;
    use crate::settings::PanelPosition;

    /// パネルのピルと Dock の上端の間 (デザイン 03)
    pub const DOCK_GAP: f64 = 16.0;

    /// フロントエンドがピル・カードの周りに取る影の余白 (PanelFrame の px-6 pt-4 pb-8)。
    /// この部分は画面外に出てもよい
    #[derive(Debug, Clone, Copy, PartialEq)]
    pub struct Margins {
        pub left: f64,
        pub right: f64,
        pub top: f64,
        pub bottom: f64,
    }

    pub const MARGINS: Margins = Margins {
        left: 24.0,
        right: 24.0,
        top: 16.0,
        bottom: 32.0,
    };

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

    /// グローバル座標の点 (整数に保つ。奇数幅でも往復で一致させるため)
    #[derive(Debug, Clone, Copy, PartialEq)]
    pub struct Point {
        pub x: f64,
        pub y: f64,
    }

    impl Point {
        pub fn approx_eq(&self, o: &Point) -> bool {
            (self.x - o.x).abs() < 1.0 && (self.y - o.y).abs() < 1.0
        }
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
    #[serde(rename_all = "lowercase")]
    pub enum Horizontal {
        Left,
        Center,
        Right,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
    #[serde(rename_all = "lowercase")]
    pub enum Vertical {
        Top,
        Bottom,
    }

    /// `panel-anchor` イベントの payload
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
    pub struct PanelAnchor {
        pub horizontal: Horizontal,
        pub vertical: Vertical,
    }

    impl Default for PanelAnchor {
        /// 既定位置 (Dock の上の中央) のアンカー
        fn default() -> Self {
            Self {
                horizontal: Horizontal::Center,
                vertical: Vertical::Bottom,
            }
        }
    }

    /// ウィンドウのフレームからピルの部分 (影の余白を除いたもの)
    pub fn content_of(frame: &Rect) -> Rect {
        Rect {
            x: frame.x + MARGINS.left,
            y: frame.y + MARGINS.bottom,
            w: (frame.w - MARGINS.left - MARGINS.right).max(0.0),
            h: (frame.h - MARGINS.top - MARGINS.bottom).max(0.0),
        }
    }

    /// ピルの部分からウィンドウのフレーム (`content_of` の逆)
    pub fn frame_of_content(c: &Rect) -> Rect {
        Rect {
            x: c.x - MARGINS.left,
            y: c.y - MARGINS.bottom,
            w: c.w + MARGINS.left + MARGINS.right,
            h: c.h + MARGINS.top + MARGINS.bottom,
        }
    }

    /// 点が visibleFrame のどこにあるかでアンカーを決める
    pub fn anchor_at((px, py): (f64, f64), visible: &Rect) -> PanelAnchor {
        let horizontal = if px < visible.x + visible.w / 3.0 {
            Horizontal::Left
        } else if px > visible.x + visible.w * 2.0 / 3.0 {
            Horizontal::Right
        } else {
            Horizontal::Center
        };
        let vertical = if py > visible.y + visible.h / 2.0 {
            Vertical::Top
        } else {
            Vertical::Bottom
        };
        PanelAnchor {
            horizontal,
            vertical,
        }
    }

    /// ピルのアンカーに当たる辺・角 (整数)。中央は `content_at` の逆になるよう floor(x + w/2 + 0.5)
    pub fn anchor_point(c: &Rect, a: PanelAnchor) -> Point {
        let x = match a.horizontal {
            Horizontal::Left => c.x,
            Horizontal::Center => (c.x + c.w / 2.0 + 0.5).floor(),
            Horizontal::Right => c.x + c.w,
        };
        let y = match a.vertical {
            Vertical::Top => c.y + c.h,
            Vertical::Bottom => c.y,
        };
        Point {
            x: x.round(),
            y: y.round(),
        }
    }

    /// アンカー点を固定して大きさ (cw, ch) のピルを置く
    pub fn content_at(p: Point, a: PanelAnchor, (cw, ch): (f64, f64)) -> Rect {
        let x = match a.horizontal {
            Horizontal::Left => p.x,
            Horizontal::Center => (p.x - cw / 2.0).floor(),
            Horizontal::Right => p.x - cw,
        };
        let y = match a.vertical {
            Vertical::Top => p.y - ch,
            Vertical::Bottom => p.y,
        };
        Rect { x, y, w: cw, h: ch }
    }

    /// ピルが領域に収まるようずらす (大きさは変えない)。領域より大きい場合は左端・下端を合わせる
    pub fn clamp_content(c: &Rect, area: &Rect) -> Rect {
        let clamp = |v: f64, lo: f64, hi: f64| v.clamp(lo, hi.max(lo));
        Rect {
            x: clamp(c.x, area.x.ceil(), (area.x + area.w - c.w).floor()),
            y: clamp(c.y, area.y.ceil(), (area.y + area.h - c.h).floor()),
            w: c.w,
            h: c.h,
        }
    }

    /// ウィンドウの大きさ (影の余白込み) からピルの大きさ
    pub fn content_size((w, h): (f64, f64)) -> (f64, f64) {
        (
            (w - MARGINS.left - MARGINS.right).max(0.0),
            (h - MARGINS.top - MARGINS.bottom).max(0.0),
        )
    }

    /// 利用者の位置 `p` と大きさから、実際に置くウィンドウのフレームとアンカーを求める。
    /// `visible` は p を保存したディスプレイの visibleFrame
    pub fn place(p: Point, size: (f64, f64), visible: &Rect) -> (Rect, PanelAnchor) {
        let a = anchor_at((p.x, p.y), visible);
        let c = clamp_content(&content_at(p, a, content_size(size)), visible);
        (frame_of_content(&c), a)
    }

    /// ウィンドウのフレーム (ドラッグ先) から利用者の位置とアンカーを求める (`place` の逆)
    pub fn point_of_frame(frame: &Rect, visible: &Rect) -> (Point, PanelAnchor) {
        let c = content_of(frame);
        let a = anchor_at(c.center(), visible);
        (anchor_point(&c, a), a)
    }

    /// 既定位置: visibleFrame の中央下。ピルの下端が Dock の上端 (visibleFrame の下端) から 16pt 上
    pub fn default_point(visible: &Rect) -> Point {
        Point {
            x: (visible.x + visible.w / 2.0).round(),
            y: (visible.y + DOCK_GAP).round(),
        }
    }

    /// 保存形式 (ディスプレイの左下からの相対位置) へ
    pub fn to_relative(p: Point, s: &ScreenInfo) -> PanelPosition {
        PanelPosition {
            x: (p.x - s.frame.x).round(),
            y: (p.y - s.frame.y).round(),
            display_id: s.id.clone(),
            version: PanelPosition::CURRENT_VERSION,
        }
    }

    /// 保存形式からグローバル座標へ (ディスプレイは呼び出し側が選ぶ)。現行の版であること
    pub fn from_relative(pos: &PanelPosition, frame: &Rect) -> Point {
        Point {
            x: (frame.x + pos.x).round(),
            y: (frame.y + pos.y).round(),
        }
    }

    /// 旧形式 (ウィンドウの下端中央) を、その時の大きさで置いたピルのアンカー点に移行する。
    /// 現行の版ならそのまま返す
    pub fn migrate(pos: &PanelPosition, size: (f64, f64), s: &ScreenInfo) -> PanelPosition {
        if pos.version >= PanelPosition::CURRENT_VERSION {
            return pos.clone();
        }
        let (w, h) = size;
        let cx = s.frame.x + pos.x;
        let frame = Rect {
            x: (cx - w / 2.0).floor(),
            y: (s.frame.y + pos.y).round(),
            w,
            h,
        };
        let (p, _) = point_of_frame(&frame, &s.visible);
        to_relative(p, s)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        const W: f64 = 1512.0;

        fn screen() -> ScreenInfo {
            ScreenInfo {
                id: "1".into(),
                frame: Rect {
                    x: 0.0,
                    y: 0.0,
                    w: W,
                    h: 982.0,
                },
                // Dock 下 (高さ 70) とメニューバー (33)
                visible: Rect {
                    x: 0.0,
                    y: 70.0,
                    w: W,
                    h: 879.0,
                },
            }
        }

        /// 閉じたピル (240x36) と展開したカード (440x200) のウィンドウの大きさ
        const PILL: (f64, f64) = (240.0 + 48.0, 36.0 + 48.0);
        const CARD: (f64, f64) = (440.0 + 48.0, 200.0 + 48.0);

        fn inside(c: &Rect, v: &Rect) -> bool {
            c.x >= v.x && c.y >= v.y && c.x + c.w <= v.x + v.w && c.y + c.h <= v.y + v.h
        }

        fn anchor(h: Horizontal, v: Vertical) -> PanelAnchor {
            PanelAnchor {
                horizontal: h,
                vertical: v,
            }
        }

        #[test]
        fn default_is_bottom_center_above_dock() {
            let s = screen();
            let p = default_point(&s.visible);
            let (f, a) = place(p, PILL, &s.visible);
            assert_eq!(a, PanelAnchor::default());
            let c = content_of(&f);
            // ピル下端 = Dock 上端 70 + 16、ウィンドウ下端は影の余白 32 下
            assert_eq!(c.y, 86.0);
            assert_eq!(f.y, 86.0 - 32.0);
            assert_eq!(c.x + c.w / 2.0, W / 2.0);
            // 展開しても下端中央は動かない
            let (f2, _) = place(p, CARD, &s.visible);
            let c2 = content_of(&f2);
            assert_eq!(c2.y, c.y);
            assert_eq!(c2.x + c2.w / 2.0, W / 2.0);
        }

        /// 6 通りのアンカーそれぞれで、固定した辺・角が大きさによらず動かない
        #[test]
        fn each_anchor_keeps_its_corner() {
            use Horizontal::*;
            use Vertical::*;
            let s = screen();
            let v = &s.visible;
            // 各領域の中ほどに置いたピルのウィンドウ位置 (x, y)
            let cases = [
                ((300.0, 700.0), anchor(Left, Top)),
                ((700.0, 700.0), anchor(Center, Top)),
                ((1100.0, 700.0), anchor(Right, Top)),
                ((300.0, 200.0), anchor(Left, Bottom)),
                ((700.0, 200.0), anchor(Center, Bottom)),
                ((1100.0, 200.0), anchor(Right, Bottom)),
            ];
            for ((x, y), want) in cases {
                let drag = Rect {
                    x,
                    y,
                    w: PILL.0,
                    h: PILL.1,
                };
                let (p, a) = point_of_frame(&drag, v);
                assert_eq!(a, want, "at {x},{y}");
                // 点だけからも同じアンカーになる (保存するのは点だけのため)
                assert_eq!(anchor_at((p.x, p.y), v), want);
                let (small, a1) = place(p, PILL, v);
                let (big, a2) = place(p, CARD, v);
                assert_eq!((a1, a2), (want, want));
                assert_eq!(small, drag, "同じ大きさなら元の位置");
                let (cs, cb) = (content_of(&small), content_of(&big));
                assert_eq!(anchor_point(&cs, want), anchor_point(&cb, want));
                match want.horizontal {
                    Left => assert_eq!(cs.x, cb.x),
                    Right => assert_eq!(cs.x + cs.w, cb.x + cb.w),
                    Center => assert!((cs.center().0 - cb.center().0).abs() <= 0.5),
                }
                match want.vertical {
                    Top => assert_eq!(cs.y + cs.h, cb.y + cb.h),
                    Bottom => assert_eq!(cs.y, cb.y),
                }
            }
        }

        /// 右上に置いたら左と下へ広がる
        #[test]
        fn top_right_grows_left_and_down() {
            let s = screen();
            let drag = Rect {
                x: 1150.0,
                y: 800.0,
                w: PILL.0,
                h: PILL.1,
            };
            let (p, _) = point_of_frame(&drag, &s.visible);
            let (big, _) = place(p, CARD, &s.visible);
            assert!(big.x < drag.x);
            assert!(big.y < drag.y);
            assert_eq!(big.x + big.w, drag.x + drag.w);
            assert_eq!(big.y + big.h, drag.y + drag.h);
        }

        /// 4 辺それぞれではみ出す位置でも、ピルは visibleFrame に収まる (影の余白ははみ出してよい)
        #[test]
        fn clamps_at_all_edges() {
            let s = screen();
            let v = &s.visible;
            let points = [
                Point {
                    x: -200.0,
                    y: 400.0,
                }, // 左
                Point {
                    x: 1700.0,
                    y: 400.0,
                }, // 右
                Point {
                    x: 700.0,
                    y: 5000.0,
                }, // 上 (メニューバー)
                Point {
                    x: 700.0,
                    y: -100.0,
                }, // 下 (Dock)
                Point {
                    x: 1511.0,
                    y: 948.0,
                }, // 右上の角ぎりぎり
                Point { x: 1.0, y: 71.0 }, // 左下の角ぎりぎり
            ];
            for p in points {
                for size in [PILL, CARD] {
                    let (f, _) = place(p, size, v);
                    let c = content_of(&f);
                    assert!(inside(&c, v), "{p:?} {size:?} -> {c:?}");
                    assert_eq!((c.w, c.h), content_size(size));
                }
            }
            // 端にぴったり寄せられる
            let (f, _) = place(
                Point {
                    x: -200.0,
                    y: 400.0,
                },
                PILL,
                v,
            );
            assert_eq!(content_of(&f).x, 0.0);
            let (f, _) = place(
                Point {
                    x: 1700.0,
                    y: 400.0,
                },
                PILL,
                v,
            );
            let c = content_of(&f);
            assert_eq!(c.x + c.w, W);
            let (f, _) = place(
                Point {
                    x: 700.0,
                    y: 5000.0,
                },
                CARD,
                v,
            );
            let c = content_of(&f);
            assert_eq!(c.y + c.h, 949.0);
            // 下は Dock の上端まで。ウィンドウ下端 (影) は Dock に重なる
            let (f, _) = place(
                Point {
                    x: 700.0,
                    y: -100.0,
                },
                PILL,
                v,
            );
            assert_eq!(content_of(&f).y, 70.0);
            assert_eq!(f.y, 70.0 - MARGINS.bottom);
        }

        /// 展開ではみ出して自動でずれても、閉じれば利用者の位置に戻る。
        /// 利用者の位置 (保存するもの) は自動のずれで変わらない
        #[test]
        fn shrink_returns_to_user_position_without_persisting_shift() {
            let s = screen();
            let v = &s.visible;
            // 小さいディスプレイ (幅 800) の中央寄り右に置いたピルが、幅 600 のカードに広がると右にはみ出す
            let small_screen = ScreenInfo {
                id: "3".into(),
                frame: Rect {
                    x: 0.0,
                    y: 0.0,
                    w: 800.0,
                    h: 600.0,
                },
                visible: Rect {
                    x: 0.0,
                    y: 0.0,
                    w: 800.0,
                    h: 575.0,
                },
            };
            let sv = &small_screen.visible;
            let drag = Rect {
                x: 360.0,
                y: 100.0,
                w: PILL.0,
                h: PILL.1,
            };
            let (p, a) = point_of_frame(&drag, sv);
            assert_eq!(a, anchor(Horizontal::Center, Vertical::Bottom));
            let saved = to_relative(p, &small_screen);
            let (big, _) = place(p, (648.0, 248.0), sv);
            let cb = content_of(&big);
            assert!(inside(&cb, sv));
            assert_eq!(cb.x + cb.w, 800.0, "右端で止まり左へずれる");
            // place は位置を返すだけで、利用者の位置 (保存値) は変わらない
            assert_eq!(to_relative(p, &small_screen), saved);
            let (small, _) = place(from_relative(&saved, &small_screen.frame), PILL, sv);
            assert_eq!(small, drag);

            // 左上アンカーのピルが背の高いカードになって下 (Dock) にはみ出す → 上へずれる → 戻る
            let low_left = Rect {
                x: 100.0,
                y: 70.0 - MARGINS.bottom + 600.0,
                w: PILL.0,
                h: PILL.1,
            };
            let (p, a) = point_of_frame(&low_left, v);
            assert_eq!(a, anchor(Horizontal::Left, Vertical::Top));
            let tall = (CARD.0, 700.0);
            let (big, _) = place(p, tall, v);
            let cb = content_of(&big);
            assert!(inside(&cb, v));
            assert_eq!(cb.y, 70.0, "下端 (Dock) で止まり上へずれる");
            let (small, _) = place(p, PILL, v);
            assert_eq!(small, low_left);
        }

        #[test]
        fn saved_position_roundtrip_on_offset_display() {
            // 主ディスプレイの左にあるディスプレイ (負の座標)
            let s = ScreenInfo {
                id: "2".into(),
                frame: Rect {
                    x: -1920.0,
                    y: -200.0,
                    w: 1920.0,
                    h: 1080.0,
                },
                visible: Rect {
                    x: -1920.0,
                    y: -200.0,
                    w: 1920.0,
                    h: 1055.0,
                },
            };
            let p = Point {
                x: -1500.0,
                y: 600.0,
            };
            let rel = to_relative(p, &s);
            assert_eq!((rel.x, rel.y), (420.0, 800.0));
            assert_eq!(rel.version, PanelPosition::CURRENT_VERSION);
            assert_eq!(from_relative(&rel, &s.frame), p);
        }

        /// 奇数幅でも、置いたフレームから求めた点が元と一致する (0.5pt ずれない)
        #[test]
        fn odd_width_roundtrip_has_no_drift() {
            let s = screen();
            let p = default_point(&s.visible);
            for w in [321.0, 241.0, 440.0, 333.0, 49.0, 999.0] {
                let (f, a) = place(p, (w, 100.0), &s.visible);
                assert_eq!(f.x, f.x.floor());
                let (back, a2) = point_of_frame(&f, &s.visible);
                assert_eq!((back, a2), (p, a), "width {w}");
            }
        }

        /// 旧形式 (ウィンドウの下端中央) を移行すると、その大きさでは見た目の位置が変わらない
        #[test]
        fn migrates_legacy_position() {
            let s = screen();
            for (x, y) in [
                (756.0, 54.0),
                (200.0, 700.0),
                (1300.0, 500.0),
                (1300.0, 100.0),
            ] {
                let old = PanelPosition {
                    x,
                    y,
                    display_id: "1".into(),
                    version: PanelPosition::LEGACY_VERSION,
                };
                let size = (321.0, 84.0);
                let legacy_frame = Rect {
                    x: (x - size.0 / 2.0).floor(),
                    y,
                    w: size.0,
                    h: size.1,
                };
                let new = migrate(&old, size, &s);
                assert_eq!(new.version, PanelPosition::CURRENT_VERSION);
                assert_eq!(new.display_id, "1");
                let (f, _) = place(from_relative(&new, &s.frame), size, &s.visible);
                assert_eq!(f, legacy_frame, "{x},{y}");
                // 移行済みはそのまま
                assert_eq!(migrate(&new, (500.0, 300.0), &s), new);
            }
            // 旧既定位置 (Dock の上の中央) は新しい既定位置と同じ点になる
            let old_default = PanelPosition {
                x: 756.0,
                y: 70.0 + DOCK_GAP - MARGINS.bottom,
                display_id: "1".into(),
                version: PanelPosition::LEGACY_VERSION,
            };
            let new = migrate(&old_default, PILL, &s);
            assert_eq!(from_relative(&new, &s.frame), default_point(&s.visible));
        }

        #[test]
        fn anchor_serializes_lowercase() {
            let v = serde_json::to_value(anchor(Horizontal::Right, Vertical::Top)).unwrap();
            assert_eq!(
                v,
                serde_json::json!({ "horizontal": "right", "vertical": "top" })
            );
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
