//! アプリのメニューバー (設定・セットアップを開いて Regular になっている間に画面上部に出るメニュー)。
//!
//! Tauri の既定のメニュー (`Menu::default`) は項目名が英語に固定 (muda の predefined.rs) のため、
//! 同じ構成を自分で組み、表示言語の文言を渡す (PredefinedMenuItem の text 引数)。表示言語の変更時は作り直す。
//! 標準の動作 (⌘C・⌘V 等のキー、ウインドウ・ヘルプメニューの扱い) は predefined の項目と
//! `set_menu` (WINDOW_SUBMENU_ID・HELP_SUBMENU_ID を NSApp に登録する) に任せる。
//!
//! 既知の制約: AppKit が自分で足す項目 (編集メニューの「音声入力を開始」「絵文字と記号」、
//! ウインドウメニューの「すべてを手前に移動」等) は macOS の言語で表示され、表示言語には連動しない。
//! View メニュー (フルスクリーン) は置かない (設定・セットアップは大きさを変えないウインドウのため)

use anyhow::{Context, Result};
use tauri::menu::{
    AboutMetadata, Menu, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID,
};
use tauri::AppHandle;

use crate::i18n::{self, Locale, Msg};

/// 今の表示言語で組み直して設定する。どのスレッドからでも呼べる (項目の作成はメインスレッドで行われる)
pub fn refresh(app: &AppHandle) {
    let result = build(app, i18n::current())
        .and_then(|m| app.set_menu(m).context("アプリのメニューを設定できません"));
    if let Err(e) = result {
        log::warn!("アプリのメニューを作れません: {e:#}");
    }
}

fn build(app: &AppHandle, l: Locale) -> Result<Menu<tauri::Wry>> {
    let t = |m: Msg| m.text(l);
    let pkg = app.package_info();
    let config = app.config();
    let about = AboutMetadata {
        name: Some(pkg.name.clone()),
        version: Some(pkg.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config.bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };
    let sep = || PredefinedMenuItem::separator(app);
    let app_menu = Submenu::with_items(
        app,
        pkg.name.clone(),
        true,
        &[
            &PredefinedMenuItem::about(app, Some(&t(Msg::AppMenuAbout)), Some(about))?,
            &sep()?,
            &PredefinedMenuItem::services(app, Some(&t(Msg::AppMenuServices)))?,
            &sep()?,
            &PredefinedMenuItem::hide(app, Some(&t(Msg::AppMenuHide)))?,
            &PredefinedMenuItem::hide_others(app, Some(&t(Msg::AppMenuHideOthers)))?,
            &PredefinedMenuItem::show_all(app, Some(&t(Msg::AppMenuShowAll)))?,
            &sep()?,
            &PredefinedMenuItem::quit(app, Some(&t(Msg::MenuQuit)))?,
        ],
    )?;
    let file = Submenu::with_items(
        app,
        t(Msg::AppMenuFile),
        true,
        &[&PredefinedMenuItem::close_window(
            app,
            Some(&t(Msg::AppMenuCloseWindow)),
        )?],
    )?;
    let edit = Submenu::with_items(
        app,
        t(Msg::AppMenuEdit),
        true,
        &[
            &PredefinedMenuItem::undo(app, Some(&t(Msg::AppMenuUndo)))?,
            &PredefinedMenuItem::redo(app, Some(&t(Msg::AppMenuRedo)))?,
            &sep()?,
            &PredefinedMenuItem::cut(app, Some(&t(Msg::AppMenuCut)))?,
            &PredefinedMenuItem::copy(app, Some(&t(Msg::AppMenuCopy)))?,
            &PredefinedMenuItem::paste(app, Some(&t(Msg::AppMenuPaste)))?,
            &PredefinedMenuItem::select_all(app, Some(&t(Msg::AppMenuSelectAll)))?,
        ],
    )?;
    let window = Submenu::with_id_and_items(
        app,
        WINDOW_SUBMENU_ID,
        t(Msg::AppMenuWindow),
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some(&t(Msg::AppMenuMinimize)))?,
            &PredefinedMenuItem::maximize(app, Some(&t(Msg::AppMenuZoom)))?,
            &sep()?,
            &PredefinedMenuItem::close_window(app, Some(&t(Msg::AppMenuCloseWindow)))?,
        ],
    )?;
    let help = Submenu::with_id_and_items(app, HELP_SUBMENU_ID, t(Msg::AppMenuHelp), true, &[])?;
    Ok(Menu::with_items(
        app,
        &[&app_menu, &file, &edit, &window, &help],
    )?)
}
