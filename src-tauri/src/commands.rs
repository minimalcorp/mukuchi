//! Tauri commands (docs/architecture.md「Tauri commands / events」)。
//! エラーは表示用の日本語メッセージ (文字列) で返す。

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::audio::{self, AudioDevice};
use crate::core::Core;
use crate::permissions::{self, Pane, Permissions};
use crate::provisioning::ProvisioningStatus;
use crate::settings::Settings;
use crate::state::AppStatus;
use crate::storage::{StorageUsage, UninstallTarget};
use crate::windows::{self, SettingsCategory};

type CmdResult<T> = Result<T, String>;

fn err(e: anyhow::Error) -> String {
    format!("{e:#}")
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
        .map_err(|e| e.to_string())?
        .map_err(err)
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
    permissions::open_system_settings(pane).map_err(err)
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

// ---- セットアップ・ストレージ ------------------------------------------------

#[tauri::command]
pub fn get_provisioning_status(core: State<'_, Arc<Core>>) -> ProvisioningStatus {
    core.provisioning.status()
}

#[tauri::command]
pub fn start_provisioning(core: State<'_, Arc<Core>>) {
    core.provisioning.start();
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
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_runtime_and_model(core: State<'_, Arc<Core>>) -> CmdResult<()> {
    core.inner().delete_runtime_and_model().await.map_err(err)
}

#[tauri::command]
pub async fn get_uninstall_targets(core: State<'_, Arc<Core>>) -> CmdResult<Vec<UninstallTarget>> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || core.uninstall_targets())
        .await
        .map_err(|e| e.to_string())?
        .map_err(err)
}

#[tauri::command]
pub async fn uninstall(core: State<'_, Arc<Core>>) -> CmdResult<()> {
    core.inner().uninstall().await.map_err(err)
}

#[tauri::command]
pub fn open_logs_folder(app: tauri::AppHandle) -> CmdResult<()> {
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    crate::macos::open_path(&dir).map_err(err)
}

// ---- ウィンドウ ---------------------------------------------------------------

#[tauri::command]
pub fn open_settings(app: AppHandle, category: Option<SettingsCategory>) -> CmdResult<()> {
    windows::open_settings(&app, category).map_err(err)
}

#[tauri::command]
pub fn open_setup(app: AppHandle) -> CmdResult<()> {
    windows::open_setup(&app).map_err(err)
}

#[tauri::command]
pub fn complete_setup(app: AppHandle, core: State<'_, Arc<Core>>) -> CmdResult<()> {
    core.inner().complete_setup().map_err(err)?;
    // 「試しに話す」を経ずに完了した場合もパネルを出す
    windows::show_panel(&app).map_err(err)?;
    windows::close_setup(&app).map_err(err)
}

#[tauri::command]
pub fn show_panel(app: AppHandle) -> CmdResult<()> {
    windows::show_panel(&app).map_err(err)
}

#[tauri::command]
pub fn set_panel_size(app: AppHandle, width: f64, height: f64) -> CmdResult<()> {
    windows::set_panel_size(&app, width, height).map_err(err)
}

/// パネル内の論理座標 (左上原点) にメニューバーと同じメニューを出す。
/// メニューが閉じるのを待たずに戻る (選択はメニューバーと同じ処理に流れる)
#[tauri::command]
pub fn show_panel_menu(app: AppHandle, x: f64, y: f64) -> CmdResult<()> {
    crate::tray::popup_panel_menu(&app, x, y).map_err(err)
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
