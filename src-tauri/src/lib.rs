mod asr;
mod asr_process;
mod audio;
mod autostart;
mod commands;
mod core;
mod insert;
mod launch;
mod macos;
mod paths;
mod permissions;
mod pipeline;
mod provisioning;
mod settings;
mod state;
mod storage;
mod tray;
mod vad;
mod voice_command;
mod windows;

use std::sync::Arc;
use std::time::Duration;

use tauri::path::BaseDirectory;
use tauri::{Manager, RunEvent, WindowEvent};

use crate::core::Core;

/// `scripts/uninstall.sh` 用: ログイン項目 (SMAppService) を解除して終了する (UI は起動しない)。
/// シェルからは SMAppService を呼べないため、本体をゴミ箱に入れる前にこのフラグ付きで本体を実行する
const ARG_UNREGISTER_LOGIN_ITEM: &str = "--unregister-login-item";
/// 検証用 (隠し): 同梱 uv の解決結果を表示して終了する (UI は起動しない)。
/// リリースビルドは `MUKUCHI_DEV_*` を無視するため、ビルドした .app が Helpers/uv を指すかをこれで確かめる
const ARG_PRINT_UV_PATH: &str = "--print-uv-path";

/// 同梱 uv を解決する。`resource` は Resource 相対パスの解決 (.app 外でのみ使う)
fn resolve_uv(
    resource: impl FnOnce(&str) -> anyhow::Result<std::path::PathBuf>,
) -> paths::UvResolution {
    let exe = tauri::utils::platform::current_exe().map_err(|e| {
        (
            None,
            anyhow::Error::new(e).context("実行ファイルの場所を取得できません"),
        )
    })?;
    paths::resolve_uv(&exe, || resource(paths::DEV_UV_RESOURCE))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if std::env::args_os().any(|a| a == ARG_UNREGISTER_LOGIN_ITEM) {
        let code = match autostart::set_enabled(false) {
            Ok(()) => {
                println!("ログイン項目を解除しました");
                0
            }
            Err(e) => {
                eprintln!("{e:#}");
                1
            }
        };
        std::process::exit(code);
    }
    let context = tauri::generate_context!();
    if std::env::args_os().any(|a| a == ARG_PRINT_UV_PATH) {
        // App を作らずに Resource を解決する (PathResolver::resource_dir と同じ関数)
        let package_info = context.package_info().clone();
        let r = resolve_uv(|rel| {
            tauri::utils::platform::resource_dir(&package_info, &tauri::Env::default())
                .map(|d| d.join(rel))
                .map_err(|e| anyhow::anyhow!("Resource ディレクトリを取得できません: {e}"))
        });
        let code = match r {
            Ok(p) => {
                println!("{}", p.display());
                0
            }
            Err((_, e)) => {
                eprintln!("{e:#}");
                1
            }
        };
        std::process::exit(code);
    }
    let app = tauri::Builder::default()
        // 最初に登録する (プラグインの指定)。2つ目のプロセスは既存のプロセスに知らせて、ここで終了する。
        // Finder 等からの起動は LaunchServices が既存のプロセスに Reopen を送るだけだが、
        // 実行ファイルの直接起動や `open -n` では別プロセスが立つため (ASR サーバー・パネルが二重になる)
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 引数は使わない・記録しない。ウィンドウ操作はメインスレッドで行う
            log::info!("2つ目の起動を検知: 画面を開く");
            let app2 = app.clone();
            if app
                .run_on_main_thread(move || windows::open_on_relaunch(&app2))
                .is_err()
            {
                log::warn!("メインスレッドに送れません");
            }
        }))
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

            // 同梱物。tauri dev では target/debug/ にコピーされたものを指す
            let uv = resolve_uv(|rel| {
                app.path()
                    .resolve(rel, BaseDirectory::Resource)
                    .map_err(anyhow::Error::from)
            })
            .unwrap_or_else(|(candidate, e)| {
                // 起動は止めない。セットアップの runtime ステップが「入れ直してください」を表示する
                log::error!("{e:#}");
                candidate.unwrap_or_default()
            });
            let resources =
                paths::Resources::resolve(app.path().resource_dir().ok().as_deref(), uv);
            log::info!(
                "同梱物: uv={} asr-server={} verify={}",
                resources.uv.display(),
                resources.asr_server.display(),
                resources.verify_wav.display()
            );
            let data_dir = match paths::dev_path(paths::ENV_DEV_DATA_DIR) {
                Some(d) => {
                    // 指定を誤っても、リポジトリ・ビルド成果物・ホーム等を削除対象にしない
                    let mut protected: Vec<std::path::PathBuf> = vec![
                        resources.asr_server.clone(),
                        resources.uv.clone(),
                        app.path().home_dir()?,
                    ];
                    protected.extend(storage::build_target_dir());
                    let d = paths::validate_dev_data_dir(&d, &protected).map_err(|e| {
                        log::error!("{}: {e:#}", paths::ENV_DEV_DATA_DIR);
                        e
                    })?;
                    log::info!(
                        "{} によりデータディレクトリを差し替え: {}",
                        paths::ENV_DEV_DATA_DIR,
                        d.display()
                    );
                    d
                }
                None => app.path().app_data_dir()?,
            };
            let data_paths = paths::DataPaths::new(data_dir);
            data_paths.ensure_root()?;
            let log_dir = app.path().app_log_dir()?;
            let core = Core::new(app.handle().clone(), data_paths, log_dir, resources)?;
            app.manage(core.clone());
            let settings = core.settings.get();
            app.manage(Arc::new(windows::Windows::new(
                settings.panel_position.clone(),
            )));
            core.start()?;
            tray::setup(app.handle(), &core)?;
            let plan = launch::plan(core.launch_input());
            log::info!(
                "起動: パネル表示={} セットアップ表示={}",
                plan.show_panel,
                plan.open_setup
            );
            windows::create_panel(app.handle(), plan.show_panel)?;
            if plan.open_setup {
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
            commands::get_panel_anchor,
            commands::show_panel,
            commands::show_panel_menu,
        ])
        .build(context)
        .expect("error while building tauri application");

    app.run(|app, event| match event {
        // 最後のウィンドウが閉じても終了しない。明示的な終了 (app.exit) は code 付きで来る
        RunEvent::ExitRequested { api, code, .. } => {
            if code.is_none() {
                api.prevent_exit();
            }
        }
        // Dock に出ない常駐アプリのため、Finder・Spotlight・Launchpad から開き直した時に設定 (未完了ならセットアップ) を開く。
        // パネルが常に見えているため has_visible_windows は判断に使わない
        RunEvent::Reopen { .. } => {
            log::info!("Reopen: 画面を開く");
            windows::open_on_relaunch(app);
        }
        // ASR サーバーを止める (止めきれなくても、終了で stdin が閉じてサーバーは終わる)
        RunEvent::Exit => {
            if let Some(core) = app.try_state::<Arc<Core>>() {
                core.shutdown();
            }
        }
        _ => {}
    });
}

/// 起動時に、システム設定でのログイン項目の変更を設定に取り込む (本番ビルドのみ。autostart.rs)。
/// 起動時には登録・解除をしない。
fn apply_launch_at_login(core: &Arc<Core>) {
    let s = core.settings.get();
    if let Some(actual) = autostart::reconcile(s.launch_at_login, s.setup_completed) {
        log::info!("ログイン項目がシステム設定で変更されているため設定を合わせる: {actual}");
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
            // 外観 (ライト/ダーク) で変わるのはエラー時の非テンプレート画像だけ
            // (テンプレート画像はシステムが色を合わせる)。エラー中だけ見直す
            if core.state.status().phase == state::Phase::Error {
                tray::refresh_appearance(core.app());
            }
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
