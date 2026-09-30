//! Tauri commands (docs/architecture.md「Tauri commands / events」)。
//! エラーは表示用の日本語メッセージ (文字列) で返す。

use std::sync::Arc;

use serde::Serialize;
use tauri::{Manager, State};

use crate::audio::{self, AudioDevice};
use crate::core::Core;
use crate::permissions::{self, Pane, Permissions};
use crate::settings::Settings;
use crate::state::AppStatus;

type CmdResult<T> = Result<T, String>;

fn err(e: anyhow::Error) -> String {
    format!("{e:#}")
}

fn not_implemented(name: &str) -> String {
    format!("not_implemented: {name} は未実装です")
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

// ---- 未実装 (P2 以降) -------------------------------------------------------

#[tauri::command]
pub fn restart_asr() -> CmdResult<()> {
    Err(not_implemented("restart_asr"))
}

#[tauri::command]
pub fn get_provisioning_status() -> CmdResult<()> {
    Err(not_implemented("get_provisioning_status"))
}

#[tauri::command]
pub fn start_provisioning() -> CmdResult<()> {
    Err(not_implemented("start_provisioning"))
}

#[tauri::command]
pub fn pause_provisioning() -> CmdResult<()> {
    Err(not_implemented("pause_provisioning"))
}

#[tauri::command]
pub fn get_storage_usage() -> CmdResult<()> {
    Err(not_implemented("get_storage_usage"))
}

#[tauri::command]
pub fn delete_runtime_and_model() -> CmdResult<()> {
    Err(not_implemented("delete_runtime_and_model"))
}

#[tauri::command]
pub fn get_uninstall_targets() -> CmdResult<()> {
    Err(not_implemented("get_uninstall_targets"))
}

#[tauri::command]
pub fn uninstall() -> CmdResult<()> {
    Err(not_implemented("uninstall"))
}

#[tauri::command]
pub fn open_logs_folder(app: tauri::AppHandle) -> CmdResult<()> {
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    crate::macos::open_path(&dir).map_err(err)
}

#[tauri::command]
pub fn open_settings(category: Option<String>) -> CmdResult<()> {
    // TODO(P3): settings ウィンドウを開き、category を選択する
    log::info!("open_settings({category:?}) は未実装");
    Err(not_implemented("open_settings"))
}

#[tauri::command]
pub fn complete_setup() -> CmdResult<()> {
    Err(not_implemented("complete_setup"))
}
