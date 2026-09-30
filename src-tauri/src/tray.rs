//! メニューバー (macOS 標準メニュー)。
//!
//! P1 は最小限 (状態の行・ON/OFF・設定を開く・終了)。状態別アイコンとエラー時の復旧項目は P2。

use std::sync::Arc;

use anyhow::{Context, Result};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};

use crate::core::Core;
use crate::state::{AppStatus, Phase};

const ID_STATUS: &str = "status";
const ID_TOGGLE: &str = "toggle";
const ID_SETTINGS: &str = "settings";
const ID_QUIT: &str = "quit";

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

fn toggle_text(listening: bool) -> &'static str {
    if listening {
        "音声入力をオフ"
    } else {
        "音声入力をオン"
    }
}

pub fn setup(app: &AppHandle, core: &Arc<Core>) -> Result<()> {
    let status = core.state.status();
    let status_item = MenuItem::with_id(app, ID_STATUS, status_text(&status), false, None::<&str>)
        .context("メニュー項目を作成できません")?;
    let toggle_item = MenuItem::with_id(
        app,
        ID_TOGGLE,
        toggle_text(core.state.is_listening()),
        status.phase != Phase::Loading,
        None::<&str>,
    )
    .context("メニュー項目を作成できません")?;
    let settings_item =
        MenuItem::with_id(app, ID_SETTINGS, "設定を開く…", true, Some("CmdOrCtrl+,"))
            .context("メニュー項目を作成できません")?;
    let quit_item = MenuItem::with_id(app, ID_QUIT, "mukuchi を終了", true, Some("CmdOrCtrl+Q"))
        .context("メニュー項目を作成できません")?;
    let menu = Menu::with_items(
        app,
        &[
            &status_item,
            &PredefinedMenuItem::separator(app)?,
            &toggle_item,
            &PredefinedMenuItem::separator(app)?,
            &settings_item,
            &PredefinedMenuItem::separator(app)?,
            &quit_item,
        ],
    )
    .context("メニューを作成できません")?;

    let icon = app
        .default_window_icon()
        .cloned()
        .context("アイコンがありません")?;
    TrayIconBuilder::with_id("main")
        .icon(icon)
        .tooltip("mukuchi")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            ID_TOGGLE => {
                let core = app.state::<Arc<Core>>().inner().clone();
                tauri::async_runtime::spawn(async move {
                    let on = !core.state.is_listening();
                    if let Err(e) = core.set_listening(on).await {
                        log::error!("音声入力の切り替えに失敗: {e:#}");
                    }
                });
            }
            ID_SETTINGS => {
                // TODO(P3): settings ウィンドウを開く
                log::info!("設定を開く (未実装)");
            }
            ID_QUIT => app.exit(0),
            _ => {}
        })
        .build(app)
        .context("メニューバーのアイコンを作成できません")?;

    let weak = Arc::downgrade(core);
    core.state.subscribe(move |s| {
        if let Err(e) = status_item.set_text(status_text(s)) {
            log::warn!("メニューの更新に失敗: {e}");
        }
        // OFF後も確定処理中は Finalizing になるため、ONかどうかは Phase ではなく事実から判定する
        let listening = weak.upgrade().is_some_and(|c| c.state.is_listening());
        let _ = toggle_item.set_text(toggle_text(listening));
        // 読み込み中はONにできない。エラー中にONを選ぶとエラーを消して再試行する
        let _ = toggle_item.set_enabled(s.phase != Phase::Loading);
    });
    Ok(())
}
