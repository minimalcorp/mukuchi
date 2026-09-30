//! メニューバー (macOS 標準メニュー)。デザイン 02・06。
//!
//! - アイコン: 状態別のテンプレート画像。エラー時だけ赤い点付き (非テンプレート)
//! - メニュー: 状態の行 / 音声入力をオン・オフ / 設定を開く… / mukuchi を終了。
//!   エラー時は最上部に原因の行と復旧の項目を1つずつ出す。
//!   セットアップ完了前は「セットアップを開く…」を出す (セットアップ画面を閉じた人が再開できるように)
//!
//! 状態の変化は録音・入力のスレッドから通知されるため、ここでは待たずにメインスレッドへ送るだけにし
//! (`run_on_main_thread` は投げっぱなし)、メインスレッド側で最新の状態を読んで反映する。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};

use crate::core::Core;
use crate::macos::status_icon::{self, IconPng, StatusIcon};
use crate::permissions::{self, Pane};
use crate::state::{AppStatus, ErrorAction, Phase};
use crate::windows::{self, SettingsCategory};

const TRAY_ID: &str = "main";
const ID_STATUS: &str = "status";
const ID_RECOVER: &str = "recover";
const ID_TOGGLE: &str = "toggle";
const ID_SETTINGS: &str = "settings";
const ID_SETUP: &str = "setup";
const ID_QUIT: &str = "quit";

macro_rules! icon {
    ($name:literal) => {
        IconPng {
            x1: include_bytes!(concat!("../icons/tray/", $name, ".png")),
            x2: include_bytes!(concat!("../icons/tray/", $name, "@2x.png")),
        }
    };
}
const ICON_MIC: IconPng = icon!("mic");
const ICON_MIC_OFF: IconPng = icon!("mic-off");
const ICON_AUDIO_LINES: IconPng = icon!("audio-lines");
const ICON_LOADER: IconPng = icon!("loader-circle");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum IconKind {
    Off,
    Listening,
    Speaking,
    Finalizing,
    Error,
}

impl IconKind {
    fn of(phase: Phase) -> Self {
        match phase {
            // 読み込み中も使えない状態として OFF と同じにする
            Phase::Loading | Phase::Off => Self::Off,
            Phase::Listening | Phase::Done => Self::Listening,
            Phase::Speaking => Self::Speaking,
            Phase::Finalizing => Self::Finalizing,
            Phase::Error => Self::Error,
        }
    }

    fn icon(self, dark: bool) -> StatusIcon {
        match self {
            Self::Off => StatusIcon::Template(ICON_MIC_OFF),
            Self::Listening => StatusIcon::Template(ICON_MIC),
            Self::Speaking => StatusIcon::Template(ICON_AUDIO_LINES),
            Self::Finalizing => StatusIcon::Template(ICON_LOADER),
            Self::Error => StatusIcon::WithRedDot {
                png: ICON_MIC,
                dark,
            },
        }
    }
}

/// メニューの内容。変わった時だけ作り直す
#[derive(Debug, Clone, PartialEq, Eq)]
struct MenuModel {
    status: String,
    recover: Option<ErrorAction>,
    listening: bool,
    toggle_enabled: bool,
    /// 「セットアップを開く…」を出すか
    setup_item: bool,
}

impl MenuModel {
    fn of(s: &AppStatus, listening: bool, setup_completed: bool) -> Self {
        let recover = s.error.as_ref().and_then(|e| e.action);
        Self {
            // 復旧の項目が同じ操作なら重ねて出さない
            setup_item: !setup_completed && recover != Some(ErrorAction::StartSetup),
            status: status_text(s),
            recover,
            listening,
            // 読み込み中はONにできない。エラー中にONを選ぶとエラーを消して再試行する
            toggle_enabled: s.phase != Phase::Loading,
        }
    }
}

pub fn status_text(s: &AppStatus) -> String {
    match s.phase {
        Phase::Loading => match s.loading_progress {
            Some(p) => format!("モデルを読み込んでいます… {}%", (p * 100.0).round() as i64),
            None => "モデルを読み込んでいます…".into(),
        },
        Phase::Off => "オフ・モデル読み込み済み".into(),
        Phase::Listening | Phase::Speaking | Phase::Finalizing | Phase::Done => {
            "聞いています".into()
        }
        Phase::Error => s
            .error
            .as_ref()
            .map(|e| e.message.clone())
            .unwrap_or_else(|| "エラー".into()),
    }
}

fn recover_text(a: ErrorAction) -> &'static str {
    match a {
        ErrorAction::OpenAccessibility | ErrorAction::OpenMicrophone => "システム設定を開く…",
        ErrorAction::SelectMicrophone => "マイクを選択…",
        ErrorAction::RestartAsr => "文字起こしサーバーを再起動",
        ErrorAction::StartSetup => "セットアップを開く…",
    }
}

fn toggle_text(listening: bool) -> &'static str {
    if listening {
        "音声入力をオフ"
    } else {
        "音声入力をオン"
    }
}

#[derive(Default)]
struct TrayState {
    menu: Mutex<Option<MenuModel>>,
    /// 表示中のアイコンと、描いた時のメニューバーの外観 (暗いか。テンプレート画像では常に false)
    icon: Mutex<Option<(IconKind, bool)>>,
    /// メインスレッドへの反映を依頼済みか (連続した通知をまとめる)
    pending: AtomicBool,
}

pub fn setup(app: &AppHandle, core: &Arc<Core>) -> Result<()> {
    TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("mukuchi")
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| on_menu(app, event.id().as_ref()))
        .build(app)
        .context("メニューバーのアイコンを作成できません")?;

    let state = Arc::new(TrayState::default());
    app.manage(state.clone());
    // 先に購読してから現在の状態を反映する (その間の変化を取りこぼさない)
    {
        let app = app.clone();
        let state = state.clone();
        core.state
            .subscribe(move |_| schedule_refresh(&app, &state));
    }
    schedule_refresh(app, &state);
    Ok(())
}

/// メニューバーの外観 (明暗) の変化を反映する。エラー表示中だけ見回り (1秒ごと) から呼ぶ。
/// 変更通知 (KVO) を使わずポーリングにするのは、エラー表示中にしか影響せず、確認も軽いため
pub fn refresh_appearance(app: &AppHandle) {
    refresh_menu(app);
}

/// 状態以外 (セットアップ完了等) でメニューが変わる時に呼ぶ。どのスレッドからでも呼べる
pub fn refresh_menu(app: &AppHandle) {
    if let Some(state) = app.try_state::<Arc<TrayState>>() {
        schedule_refresh(app, state.inner());
    }
}

fn schedule_refresh(app: &AppHandle, state: &Arc<TrayState>) {
    if state.pending.swap(true, Ordering::SeqCst) {
        return;
    }
    let app2 = app.clone();
    let state2 = state.clone();
    let sent = app.run_on_main_thread(move || {
        // 読む前に下ろす: 読んだ後の変化は次の依頼で反映される
        state2.pending.store(false, Ordering::SeqCst);
        if let Err(e) = refresh(&app2, &state2) {
            log::warn!("メニューバーの更新に失敗: {e:#}");
        }
    });
    if sent.is_err() {
        state.pending.store(false, Ordering::SeqCst);
    }
}

/// メインスレッドで呼ばれる。
fn refresh(app: &AppHandle, state: &TrayState) -> Result<()> {
    let core = app.state::<Arc<Core>>().inner().clone();
    let status = core.state.status();
    let tray = app
        .tray_by_id(TRAY_ID)
        .context("メニューバーのアイコンがありません")?;

    let kind = IconKind::of(status.phase);
    let mut icon = state.icon.lock().unwrap_or_else(|p| p.into_inner());
    let current = *icon;
    let applied = tray
        .with_inner_tray_icon(move |t| {
            let (Some(item), Some(mtm)) = (t.ns_status_item(), objc2::MainThreadMarker::new())
            else {
                return current;
            };
            // 赤い点付きの画像は外観ごとに描き分けるため、外観の変化でも描き直す
            let dark = kind == IconKind::Error && status_icon::is_dark(&item, mtm);
            if current != Some((kind, dark)) {
                status_icon::set(&item, mtm, kind.icon(dark));
            }
            Some((kind, dark))
        })
        .context("アイコンを変更できません")?;
    *icon = applied;
    drop(icon);

    // OFF後も確定処理中は Finalizing になるため、ONかどうかは Phase ではなく事実から判定する
    let model = MenuModel::of(
        &status,
        core.state.is_listening(),
        core.settings.get().setup_completed,
    );
    let mut last = state.menu.lock().unwrap_or_else(|p| p.into_inner());
    if last.as_ref() != Some(&model) {
        let menu = build_menu(app, &model)?;
        tray.set_menu(Some(menu))
            .context("メニューを設定できません")?;
        *last = Some(model);
    }
    Ok(())
}

fn build_menu(app: &AppHandle, m: &MenuModel) -> Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    let status = MenuItem::with_id(app, ID_STATUS, &m.status, false, None::<&str>)?;
    menu.append(&status)?;
    if let Some(a) = m.recover {
        menu.append(&MenuItem::with_id(
            app,
            ID_RECOVER,
            recover_text(a),
            true,
            None::<&str>,
        )?)?;
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(
        app,
        ID_TOGGLE,
        toggle_text(m.listening),
        m.toggle_enabled,
        None::<&str>,
    )?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    if m.setup_item {
        menu.append(&MenuItem::with_id(
            app,
            ID_SETUP,
            "セットアップを開く…",
            true,
            None::<&str>,
        )?)?;
    }
    menu.append(&MenuItem::with_id(
        app,
        ID_SETTINGS,
        "設定を開く…",
        true,
        Some("CmdOrCtrl+,"),
    )?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(
        app,
        ID_QUIT,
        "mukuchi を終了",
        true,
        Some("CmdOrCtrl+Q"),
    )?)?;
    Ok(menu)
}

fn on_menu(app: &AppHandle, id: &str) {
    let core = app.state::<Arc<Core>>().inner().clone();
    match id {
        ID_TOGGLE => {
            tauri::async_runtime::spawn(async move {
                let on = !core.state.is_listening();
                if let Err(e) = core.set_listening(on).await {
                    log::error!("音声入力の切り替えに失敗: {e:#}");
                }
            });
        }
        ID_SETTINGS => {
            if let Err(e) = windows::open_settings(app, None) {
                log::error!("設定を開けません: {e:#}");
            }
        }
        ID_SETUP => {
            if let Err(e) = windows::open_setup(app) {
                log::error!("セットアップを開けません: {e:#}");
            }
        }
        ID_RECOVER => recover(app, &core),
        ID_QUIT => app.exit(0),
        _ => {}
    }
}

/// エラーの復旧 (AppError.action に対応)
pub fn recover(app: &AppHandle, core: &Arc<Core>) {
    let Some(action) = core.state.error().and_then(|e| e.action) else {
        return;
    };
    let result = match action {
        ErrorAction::OpenAccessibility => permissions::open_system_settings(Pane::Accessibility),
        ErrorAction::OpenMicrophone => permissions::open_system_settings(Pane::Microphone),
        ErrorAction::SelectMicrophone => windows::open_settings(app, Some(SettingsCategory::Voice)),
        ErrorAction::StartSetup => windows::open_setup(app),
        ErrorAction::RestartAsr => {
            let core = core.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = core.restart_asr().await {
                    log::error!("文字起こしサーバーを再起動できません: {e:#}");
                }
            });
            Ok(())
        }
    };
    if let Err(e) = result {
        log::error!("復旧操作に失敗: {e:#}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{AppError, StateManager};

    #[test]
    fn menu_model_per_state() {
        let s = StateManager::new();
        let m = MenuModel::of(&s.status(), false, true);
        assert_eq!(m.status, "モデルを読み込んでいます…");
        assert!(!m.toggle_enabled);

        s.set_asr_ready(true);
        let m = MenuModel::of(&s.status(), false, true);
        assert_eq!(m.status, "オフ・モデル読み込み済み");
        assert!(m.toggle_enabled);
        assert_eq!(m.recover, None);

        s.set_listening(true);
        assert_eq!(
            MenuModel::of(&s.status(), true, true).status,
            "聞いています"
        );

        s.set_error(AppError::asr_stopped("x"));
        let m = MenuModel::of(&s.status(), false, true);
        assert_eq!(m.recover, Some(ErrorAction::RestartAsr));
        assert_eq!(m.status, "文字起こしサーバーが停止しました");
        assert_eq!(IconKind::of(s.status().phase), IconKind::Error);
    }

    #[test]
    fn setup_item_until_completed() {
        let s = StateManager::new();
        s.set_asr_ready(true);
        assert!(MenuModel::of(&s.status(), false, false).setup_item);
        assert!(!MenuModel::of(&s.status(), false, true).setup_item);
        // 復旧の「セットアップを開く…」と重ねない
        s.set_error(AppError::runtime_missing());
        let m = MenuModel::of(&s.status(), false, false);
        assert_eq!(m.recover, Some(ErrorAction::StartSetup));
        assert!(!m.setup_item);
    }

    #[test]
    fn icons_per_phase() {
        assert_eq!(IconKind::of(Phase::Off), IconKind::Off);
        assert_eq!(IconKind::of(Phase::Speaking), IconKind::Speaking);
        assert_eq!(IconKind::of(Phase::Finalizing), IconKind::Finalizing);
        assert_eq!(IconKind::of(Phase::Done), IconKind::Listening);
        // PNG が @1x=18px / @2x=36px であること
        for png in [ICON_MIC, ICON_MIC_OFF, ICON_AUDIO_LINES, ICON_LOADER] {
            assert_eq!(&png.x1[16..24], &[0, 0, 0, 18, 0, 0, 0, 18]);
            assert_eq!(&png.x2[16..24], &[0, 0, 0, 36, 0, 0, 0, 36]);
        }
    }

    /// 全状態 × 明暗 × @1x/@2x で、メニューバーに出る画像に不透明な画素があること。
    /// `MUKUCHI_TRAY_ICON_DUMP=<dir>` を指定すると PNG に書き出す (目視確認用)
    #[test]
    fn every_icon_renders_visible_pixels() {
        use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRepPropertyKey};
        use objc2_foundation::NSDictionary;

        let dump = std::env::var_os("MUKUCHI_TRAY_ICON_DUMP").map(std::path::PathBuf::from);
        if let Some(dir) = &dump {
            std::fs::create_dir_all(dir).expect("create dump dir");
        }
        let kinds = [
            IconKind::Off,
            IconKind::Listening,
            IconKind::Speaking,
            IconKind::Finalizing,
            IconKind::Error,
        ];
        for kind in kinds {
            for dark in [false, true] {
                for scale in [1isize, 2] {
                    let label =
                        format!("{kind:?}-{}@{scale}x", if dark { "dark" } else { "light" });
                    let rep = status_icon::render_for_test(kind.icon(dark), dark, scale)
                        .unwrap_or_else(|| panic!("{label}: 描けない"));
                    let px = 18 * scale;
                    assert_eq!((rep.pixelsWide(), rep.pixelsHigh()), (px, px), "{label}");
                    let mut max_alpha = 0.0f64;
                    let mut visible = 0;
                    for y in 0..px {
                        for x in 0..px {
                            let a = rep.colorAtX_y(x, y).map_or(0.0, |c| c.alphaComponent());
                            max_alpha = max_alpha.max(a);
                            if a > 0.1 {
                                visible += 1;
                            }
                        }
                    }
                    // OFF は 50% の濃さ。それ以外は不透明な線がある
                    let min_alpha = if kind == IconKind::Off { 0.4 } else { 0.9 };
                    assert!(
                        max_alpha >= min_alpha && visible >= 20 * scale * scale,
                        "{label}: max_alpha={max_alpha} visible={visible}"
                    );
                    if let Some(dir) = &dump {
                        let props = NSDictionary::<NSBitmapImageRepPropertyKey, _>::new();
                        // SAFETY: 空の辞書 (型は API どおり)
                        let data = unsafe {
                            rep.representationUsingType_properties(
                                NSBitmapImageFileType::PNG,
                                &props,
                            )
                        }
                        .expect("encode png");
                        std::fs::write(dir.join(format!("{label}.png")), data.to_vec())
                            .expect("write png");
                    }
                }
            }
        }
    }
}
