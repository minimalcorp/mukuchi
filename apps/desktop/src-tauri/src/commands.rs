//! Tauri commands (docs/architecture.md「Tauri commands / events」)。
//! エラーは表示用のメッセージ (表示言語の文字列) で返す。想定外の失敗 (ウィンドウの作成等) は
//! 詳細をログに出し、操作ごとの短い文言で返す (詳細は技術的で利用者には役に立たないため)

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::audio::{self, AudioDevice};
use crate::core::Core;
use crate::i18n::{Locale, Msg};
use crate::permissions::{self, Pane, Permissions};
use crate::provisioning::models::ModelInfo;
use crate::provisioning::ProvisioningStatus;
use crate::settings::Settings;
use crate::shortcut::ShortcutStatus;
use crate::state::AppStatus;
use crate::storage::{StorageUsage, UninstallTarget};
use crate::update::UpdateStatus;
use crate::windows::{self, SettingsCategory};

type CmdResult<T> = Result<T, String>;

fn err(e: anyhow::Error) -> String {
    format!("{e:#}")
}

/// 想定外の失敗: 詳細はログ、表示は `msg`
fn internal(msg: Msg) -> impl FnOnce(anyhow::Error) -> String {
    move |e| {
        log::error!("{msg:?}: {e:#}");
        msg.to_string()
    }
}

/// spawn_blocking 等の異常終了 (panic)
fn join_err(e: impl std::fmt::Display) -> String {
    log::error!("処理が異常終了しました: {e}");
    Msg::Internal.to_string()
}

#[tauri::command]
pub fn get_status(core: State<'_, Arc<Core>>) -> AppStatus {
    core.state.status()
}

#[tauri::command]
pub async fn set_listening(core: State<'_, Arc<Core>>, on: bool) -> CmdResult<()> {
    core.inner().set_listening(on).await.map_err(err)
}

#[tauri::command]
pub fn get_shortcut_status(core: State<'_, Arc<Core>>) -> ShortcutStatus {
    core.shortcut.status()
}

/// 同期 command (メインスレッドで実行) にする: 登録・解除はメインスレッドで行われ、
/// 別スレッドから呼ぶとメインスレッドの完了を待つことになるため (shortcut.rs)
#[tauri::command]
pub fn set_shortcut_suspended(core: State<'_, Arc<Core>>, suspended: bool) {
    core.shortcut.set_suspended(suspended);
}

/// 解決した表示言語 (uiLanguage が system なら起動時の macOS の優先言語から)
#[tauri::command]
pub fn get_locale(core: State<'_, Arc<Core>>) -> Locale {
    core.locale()
}

#[tauri::command]
pub fn get_settings(core: State<'_, Arc<Core>>) -> Settings {
    core.settings.get()
}

#[tauri::command]
pub fn update_settings(
    core: State<'_, Arc<Core>>,
    patch: serde_json::Value,
) -> CmdResult<Settings> {
    core.inner().update_settings(&patch).map_err(err)
}

#[tauri::command]
pub async fn list_input_devices() -> CmdResult<Vec<AudioDevice>> {
    tauri::async_runtime::spawn_blocking(audio::list_input_devices)
        .await
        .map_err(join_err)?
        .map_err(internal(Msg::ListDevicesFailed))
}

#[tauri::command]
pub fn get_permissions() -> Permissions {
    permissions::current()
}

#[tauri::command]
pub async fn request_microphone(core: State<'_, Arc<Core>>) -> CmdResult<Permissions> {
    let p = permissions::request_microphone().await;
    core.emit_permissions();
    Ok(p)
}

#[tauri::command]
pub fn open_system_settings(pane: Pane) -> CmdResult<()> {
    // macOS 13 未満の LoginItems は理由を出す (Msg)。それ以外は想定外
    permissions::open_system_settings(pane).map_err(|e| {
        if e.downcast_ref::<Msg>().is_some() {
            err(e)
        } else {
            internal(Msg::OpenSystemSettingsFailed)(e)
        }
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningApp {
    bundle_id: String,
    name: String,
}

#[tauri::command]
pub fn list_running_apps() -> Vec<RunningApp> {
    crate::macos::running_apps()
        .into_iter()
        .filter_map(|a| {
            Some(RunningApp {
                bundle_id: a.bundle_id?,
                name: a.name,
            })
        })
        .collect()
}

#[derive(Serialize)]
pub struct AppInfo {
    version: String,
    build: String,
}

#[tauri::command]
pub fn get_app_info(app: tauri::AppHandle) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        build: env!("MUKUCHI_BUILD").to_string(),
    }
}

// ---- アップデート ---------------------------------------------------------------

#[tauri::command]
pub fn get_update_status(core: State<'_, Arc<Core>>) -> UpdateStatus {
    core.updates.status()
}

#[tauri::command]
pub async fn check_for_update(core: State<'_, Arc<Core>>) -> CmdResult<UpdateStatus> {
    Ok(core.updates.check().await)
}

/// async (メインスレッド以外) で実行する: 再起動の request_restart をメインスレッドから呼ばないため (update.rs)
#[tauri::command]
pub async fn install_update(core: State<'_, Arc<Core>>) -> CmdResult<()> {
    core.inner().install_update().await.map_err(err)
}

// ---- セットアップ・ストレージ ------------------------------------------------

#[tauri::command]
pub fn get_provisioning_status(core: State<'_, Arc<Core>>) -> ProvisioningStatus {
    core.provisioning.status()
}

#[tauri::command]
pub fn start_provisioning(core: State<'_, Arc<Core>>) {
    core.start_provisioning();
}

#[tauri::command]
pub async fn pause_provisioning(core: State<'_, Arc<Core>>) -> CmdResult<()> {
    core.provisioning.pause().await;
    Ok(())
}

#[tauri::command]
pub async fn get_storage_usage(core: State<'_, Arc<Core>>) -> CmdResult<StorageUsage> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || core.storage_usage())
        .await
        .map_err(join_err)
}

#[tauri::command]
pub async fn delete_runtime_and_model(core: State<'_, Arc<Core>>) -> CmdResult<()> {
    core.inner().delete_runtime_and_model().await.map_err(err)
}

// ---- モデルの管理 --------------------------------------------------------------

#[tauri::command]
pub async fn list_models(core: State<'_, Arc<Core>>) -> CmdResult<Vec<ModelInfo>> {
    // ディスクの使用量を数えるためブロッキングで行う
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || core.list_models())
        .await
        .map_err(join_err)
}

#[tauri::command]
pub async fn select_model(core: State<'_, Arc<Core>>, id: String) -> CmdResult<()> {
    core.inner().select_model(&id).await.map_err(err)
}

#[tauri::command]
pub fn download_model(core: State<'_, Arc<Core>>, id: String) -> CmdResult<()> {
    core.download_model(&id).map_err(err)
}

#[tauri::command]
pub async fn pause_model_download(core: State<'_, Arc<Core>>, id: String) -> CmdResult<()> {
    core.pause_model_download(&id).await.map_err(err)
}

#[tauri::command]
pub async fn cancel_model_download(core: State<'_, Arc<Core>>, id: String) -> CmdResult<()> {
    core.cancel_model_download(&id).await.map_err(err)
}

#[tauri::command]
pub async fn delete_model(core: State<'_, Arc<Core>>, id: String) -> CmdResult<()> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || core.delete_model(&id))
        .await
        .map_err(join_err)?
        .map_err(err)
}

#[tauri::command]
pub async fn get_uninstall_targets(core: State<'_, Arc<Core>>) -> CmdResult<Vec<UninstallTarget>> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || core.uninstall_targets())
        .await
        .map_err(join_err)?
        .map_err(err)
}

#[tauri::command]
pub async fn uninstall(core: State<'_, Arc<Core>>) -> CmdResult<()> {
    core.inner().uninstall().await.map_err(err)
}

#[tauri::command]
pub fn open_logs_folder(app: tauri::AppHandle) -> CmdResult<()> {
    let open = || -> anyhow::Result<()> {
        let dir = app.path().app_log_dir()?;
        std::fs::create_dir_all(&dir)?;
        crate::macos::open_path(&dir)
    };
    open().map_err(internal(Msg::OpenLogsFailed))
}

// ---- ウィンドウ ---------------------------------------------------------------

#[tauri::command]
pub fn open_settings(app: AppHandle, category: Option<SettingsCategory>) -> CmdResult<()> {
    windows::open_settings(&app, category).map_err(internal(Msg::OpenSettingsFailed))
}

#[tauri::command]
pub fn open_setup(app: AppHandle) -> CmdResult<()> {
    windows::open_setup(&app).map_err(internal(Msg::OpenSetupFailed))
}

#[tauri::command]
pub fn complete_setup(app: AppHandle, core: State<'_, Arc<Core>>) -> CmdResult<()> {
    core.inner().complete_setup().map_err(err)?;
    // 「試しに話す」を経ずに完了した場合もパネルを出す
    windows::show_panel(&app).map_err(internal(Msg::PanelFailed))?;
    windows::close_setup(&app).map_err(internal(Msg::Internal))
}

#[tauri::command]
pub fn show_panel(app: AppHandle) -> CmdResult<()> {
    windows::show_panel(&app).map_err(internal(Msg::PanelFailed))
}

#[tauri::command]
pub fn set_panel_size(app: AppHandle, width: f64, height: f64) -> CmdResult<()> {
    windows::set_panel_size(&app, width, height).map_err(internal(Msg::PanelFailed))
}

/// パネル内の論理座標 (左上原点) にメニューバーと同じメニューを出す。
/// メニューが閉じるのを待たずに戻る (選択はメニューバーと同じ処理に流れる)
#[tauri::command]
pub fn show_panel_menu(app: AppHandle, x: f64, y: f64) -> CmdResult<()> {
    crate::tray::popup_panel_menu(&app, x, y).map_err(internal(Msg::PanelFailed))
}

/// panel の読み込み直後に、`panel-anchor` を待たずに現在のアンカーを取る
#[tauri::command]
pub fn get_panel_anchor(app: AppHandle) -> windows::geometry::PanelAnchor {
    windows::panel_anchor(&app)
}

#[tauri::command]
pub async fn restart_asr(core: State<'_, Arc<Core>>) -> CmdResult<()> {
    core.inner().restart_asr().await.map_err(err)
}
