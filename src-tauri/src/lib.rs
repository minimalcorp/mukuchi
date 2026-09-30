mod asr;
mod audio;
mod autostart;
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
mod windows;

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
        .plugin(tauri_nspanel::init())
        .setup(|app| {
            // 常駐アプリのため Dock に出さない (設定・セットアップ表示中のみ Regular にする)
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let data_dir = app.path().app_data_dir()?;
            let core = Core::new(app.handle().clone(), data_dir.join("settings.json"));
            app.manage(core.clone());
            let settings = core.settings.get();
            app.manage(Arc::new(windows::Windows::new(
                settings.panel_position.clone(),
            )));
            core.start()?;
            tray::setup(app.handle(), &core)?;
            windows::create_panel(app.handle())?;
            // 自動テスト (MUKUCHI_DEV_AUTO_LISTEN) ではセットアップ画面を出さない (前面アプリを奪うため)
            if !settings.setup_completed && !core::dev_flag(core::ENV_DEV_AUTO_LISTEN) {
                windows::open_setup(app.handle())?;
            }
            apply_launch_at_login(&core);
            spawn_watcher(core);
            Ok(())
        })
        .on_window_event(|window, event| match (window.label(), event) {
            // パネルは閉じない (メニューバー常駐。閉じる手段も出していない)
            (windows::PANEL, WindowEvent::CloseRequested { api, .. }) => api.prevent_close(),
            (windows::PANEL, WindowEvent::Moved(_)) => windows::on_panel_moved(window.app_handle()),
            // 設定・セットアップは閉じたら破棄し、他に開いていなければ Dock から消す
            (label @ (windows::SETTINGS | windows::SETUP), WindowEvent::Destroyed) => {
                windows::update_activation_policy(window.app_handle(), Some(label));
            }
            _ => {}
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
            commands::open_setup,
            commands::complete_setup,
            commands::set_panel_size,
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

/// 起動時にログイン項目を設定に揃える (本番ビルドのみ。autostart.rs)。
pub(crate) fn apply_launch_at_login(core: &Arc<Core>) {
    let s = core.settings.get();
    if let Some(actual) = autostart::reconcile(s.launch_at_login, s.setup_completed) {
        log::info!("ログイン項目がシステム設定でオフにされているため設定を合わせる");
        // 登録・解除はせず設定だけ揃える (update_settings は登録操作を伴うため使わない)
        match core
            .settings
            .update(&serde_json::json!({ "launchAtLogin": actual }))
        {
            Ok(next) => {
                let _ = tauri::Emitter::emit(core.app(), core::events::SETTINGS_CHANGED, &next);
            }
            Err(e) => log::warn!("設定を保存できません: {e:#}"),
        }
    }
}

/// 1秒ごとの見回り。
/// - 権限の変化 (システム設定で許可された等) を検知して `permissions-changed` を送る。
///   TCC には変更通知の API がないためポーリングする。問い合わせは軽い
/// - パネルが既定位置に追従している間、前面ウィンドウのあるディスプレイへ移す
fn spawn_watcher(core: Arc<Core>) {
    tauri::async_runtime::spawn(async move {
        let mut last = permissions::current();
        let mut devices = DeviceWatch::default();
        let mut tick: u64 = 0;
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            tick += 1;
            if tick.is_multiple_of(2) {
                devices.poll(&core).await;
            }
            let now = permissions::current();
            if now != last {
                log::info!("権限が変化: {now:?}");
                core.emit_permissions();
                last = now;
            }
            windows::refresh_panel_position(core.app());
            tray::refresh_appearance(core.app());
        }
    });
}

/// マイクの抜き差しの検知。CoreAudio の変更通知ではなく一覧のポーリングで行う
/// (一覧の取得は軽く、設定画面・セットアップを開いている間か ON の間だけ行うため)。
/// - 一覧が変わったら `input-devices-changed` を送る (設定画面のマイク選択を更新する)
/// - システム既定のマイクを使って ON の間に既定が変わったら、新しい既定で録音をやり直す
///   (cpal のストリームは開いた時点のデバイスに固定されるため)
#[derive(Default)]
struct DeviceWatch {
    last: Option<Vec<audio::AudioDevice>>,
}

impl DeviceWatch {
    async fn poll(&mut self, core: &Arc<Core>) {
        let app = core.app();
        let ui_open = [windows::SETTINGS, windows::SETUP]
            .iter()
            .any(|l| app.get_webview_window(l).is_some());
        let listening = core.state.is_listening();
        if !ui_open && !listening {
            // 見ていない間の変化は、次に見始めた時に比べ直す
            self.last = None;
            return;
        }
        let list = match tauri::async_runtime::spawn_blocking(audio::list_input_devices).await {
            Ok(Ok(l)) => l,
            Ok(Err(e)) => {
                log::warn!("{e:#}");
                return;
            }
            Err(_) => return,
        };
        let Some(prev) = self.last.replace(list.clone()) else {
            return;
        };
        if prev == list {
            return;
        }
        log::info!("入力デバイスの一覧が変化: {}台", list.len());
        let _ = tauri::Emitter::emit(app, core::events::INPUT_DEVICES_CHANGED, &list);
        let default_of =
            |l: &[audio::AudioDevice]| l.iter().find(|d| d.is_default).map(|d| d.id.clone());
        let selected = core.settings.get().input_device_id;
        let restart = match selected.as_deref() {
            // システム既定を使っている: 既定が変わったら追従する
            None => default_of(&prev) != default_of(&list),
            // 選択したマイクがつながった (既定で代用していたのを戻す) / 外れた (既定で代用する。
            // 外れた時は録音エラーからの開き直しでも代用されるが、確実にするため)
            Some(id) => {
                let (was, now) = (
                    audio::is_connected(&prev, Some(id)),
                    audio::is_connected(&list, Some(id)),
                );
                was != now || (!now && default_of(&prev) != default_of(&list))
            }
        };
        if listening && core.uses_microphone() && restart {
            let core = core.clone();
            tauri::async_runtime::spawn(async move { core.restart_capture().await });
        }
    }
}
