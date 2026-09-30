mod asr;
mod audio;
mod commands;
mod core;
mod insert;
mod macos;
mod permissions;
mod pipeline;
mod settings;
mod state;
mod tray;
mod vad;
mod voice_command;

use std::sync::Arc;
use std::time::Duration;

use tauri::{Manager, RunEvent, WindowEvent};

use crate::core::Core;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                // ASRサーバーのログと時刻を揃える
                .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    // ~/Library/Logs/<バンドルID>/
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: None,
                    }),
                ])
                .build(),
        )
        .setup(|app| {
            // 常駐アプリのため Dock に出さない (設定・セットアップ表示中のみ Regular にするのは P3/P4)
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let data_dir = app.path().app_data_dir()?;
            let core = Core::new(app.handle().clone(), data_dir.join("settings.json"));
            app.manage(core.clone());
            core.start()?;
            tray::setup(app.handle(), &core)?;
            spawn_permission_watcher(core);
            Ok(())
        })
        .on_window_event(|window, event| {
            // ウィンドウを閉じてもアプリは終了しない (メニューバーに常駐する)
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_status,
            commands::set_listening,
            commands::get_settings,
            commands::update_settings,
            commands::list_input_devices,
            commands::get_permissions,
            commands::request_microphone,
            commands::open_system_settings,
            commands::restart_asr,
            commands::get_provisioning_status,
            commands::start_provisioning,
            commands::pause_provisioning,
            commands::get_storage_usage,
            commands::delete_runtime_and_model,
            commands::get_uninstall_targets,
            commands::uninstall,
            commands::list_running_apps,
            commands::open_logs_folder,
            commands::get_app_info,
            commands::open_settings,
            commands::complete_setup,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app, event| {
        // 最後のウィンドウが閉じても終了しない。明示的な終了 (app.exit) は code 付きで来る
        if let RunEvent::ExitRequested { api, code, .. } = event {
            if code.is_none() {
                api.prevent_exit();
            }
        }
    });
}

/// 権限の変化 (システム設定で許可された等) を検知して `permissions-changed` を送る。
/// TCC には変更通知の API がないためポーリングする。問い合わせは軽い。
fn spawn_permission_watcher(core: Arc<Core>) {
    tauri::async_runtime::spawn(async move {
        let mut last = permissions::current();
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let now = permissions::current();
            if now != last {
                log::info!("権限が変化: {now:?}");
                core.emit_permissions();
                last = now;
            }
        }
    });
}
