//! 手動の結合確認 (`cargo test -- --ignored`)。ネットワーク・uv・実モデルを使う。
//!
//! - `real_hf_range_resume`: 実際の Hugging Face から小さいファイルを取得し、途中で止めて Range で再開する
//!   (`MUKUCHI_IT_HF_HOME` に書く)
//! - `real_provision_and_serve`: `MUKUCHI_IT_DATA_DIR` を データディレクトリとして runtime → model → verify を行い、
//!   本番と同じ起動のサーバーで `MUKUCHI_IT_WAV` を文字起こしする。uv と asr-server は
//!   `MUKUCHI_DEV_UV` / `MUKUCHI_DEV_ASR_SERVER_DIR`、検証音声は `MUKUCHI_DEV_VERIFY_WAV`。
//!   モデルは既定 (`MUKUCHI_IT_MODEL=<カタログの id>` で変える)
//! - `real_catalog_sizes`: カタログの容量 (size_bytes) が固定した revision の tree API の合計と一致するか

use std::sync::atomic::AtomicU64;

use super::*;
#[cfg(not(target_os = "windows"))]
use crate::asr_process::AsrProcess;
#[cfg(not(target_os = "windows"))]
use crate::paths::Resources;
use hf::{Cache, Downloader};

fn env_path(name: &str) -> PathBuf {
    PathBuf::from(std::env::var_os(name).unwrap_or_else(|| panic!("{name} が未設定")))
}

#[test]
#[ignore]
fn real_hf_range_resume() {
    tauri::async_runtime::block_on(async {
        let hf_home = env_path("MUKUCHI_IT_HF_HOME");
        // MLX のリポジトリの小さいファイル (config.json・tokenizer.json) を使う (どちらの OS でも確かめられる)
        let model = models::Catalog::for_platform(models::Platform::MacosAarch64)
            .recommended(crate::i18n::Locale::Ja)
            .hf
            .clone();
        let http = hf::http_client().unwrap();
        let (_tx, never) = Cancel::pair();
        let files: Vec<_> = hf::list_files(&http, &model, &never)
            .await
            .unwrap()
            .into_iter()
            .filter(|f| f.path == "config.json" || f.path == "tokenizer.json")
            .collect();
        assert_eq!(files.len(), 2);
        println!(
            "files: {:?}",
            files.iter().map(|f| (&f.path, f.size)).collect::<Vec<_>>()
        );
        let cache = Cache::new(&model, &hf_home);

        // 1回目: 約3MB で一時停止
        let (tx, cancel) = Cancel::pair();
        let done = Arc::new(AtomicU64::new(0));
        let d = done.clone();
        let tx = Arc::new(Mutex::new(Some(tx)));
        let progress = move |delta: i64| {
            let now = d.fetch_add(delta as u64, Ordering::SeqCst) + delta as u64;
            if now > 3_000_000 {
                if let Some(tx) = tx.lock().unwrap().take() {
                    let _ = tx.send(true);
                    // 送り手を落とさない (落とすと cancelled が戻らなくなる)
                    std::mem::forget(tx);
                }
            }
        };
        let r = Downloader {
            http: &http,
            model: &model,
            cache: &cache,
            cancel: &cancel,
            progress: &progress,
        }
        .download_all(&files)
        .await;
        assert!(matches!(r, Err(StepError::Paused)), "{r:?}");
        let partial = cache.bytes_on_disk(&files);
        println!("一時停止時点: {partial} バイト");
        assert!(partial > 3_000_000 && partial < files.iter().map(|f| f.size).sum());

        // 2回目: 続きから
        let resumed = Arc::new(AtomicU64::new(0));
        let r2 = resumed.clone();
        let progress = move |delta: i64| {
            r2.fetch_add(delta as u64, Ordering::SeqCst);
        };
        Downloader {
            http: &http,
            model: &model,
            cache: &cache,
            cancel: &never,
            progress: &progress,
        }
        .download_all(&files)
        .await
        .unwrap();
        let total: u64 = files.iter().map(|f| f.size).sum();
        println!(
            "再開で取得: {} バイト (合計 {total})",
            resumed.load(Ordering::SeqCst)
        );
        assert_eq!(
            resumed.load(Ordering::SeqCst),
            total - partial,
            "続きだけ取る"
        );
        assert!(cache.snapshot_complete(&files));
    });
}

/// Mac の実行環境 (uv・Python・MLX) を使う。Windows の通しの確認は llama_runtime.rs
#[test]
#[ignore]
#[cfg(not(target_os = "windows"))]
fn real_provision_and_serve() {
    tauri::async_runtime::block_on(async {
        let paths = DataPaths::new(env_path("MUKUCHI_IT_DATA_DIR"));
        paths.ensure_root().unwrap();
        let logs = paths.root().join("logs");
        let uv = crate::paths::dev_path(crate::paths::ENV_DEV_UV)
            .unwrap_or_else(|| std::path::PathBuf::from(crate::paths::DEV_UV_RESOURCE));
        let resources = Resources::resolve(None, uv);
        let catalog = models::Catalog::distributed();
        let model = std::env::var("MUKUCHI_IT_MODEL")
            .ok()
            .and_then(|id| catalog.get(&id).cloned())
            .unwrap_or_else(|| catalog.recommended(crate::i18n::Locale::Ja).clone())
            .hf;
        println!("model: {}", model.version());
        let asr = Arc::new(AsrProcess::new());
        let spec = LaunchSpec {
            python: paths.venv_python(),
            model_dir: model.snapshot_dir(&paths.models()),
            hf_home: paths.models(),
            cwd: paths.venv(),
            log_file: logs.join("asr-server.log"),
        };
        let last = Arc::new(Mutex::new(None::<ProvisioningStatus>));
        let l = last.clone();
        let m = model.clone();
        let p = Provisioner::new(
            paths.clone(),
            Arc::new(move || m.clone()),
            Arc::new(runtime::UvRuntime {
                paths: paths.clone(),
                resources: resources.clone(),
                log_file: logs.join("provisioning.log"),
            }),
            Arc::new(ServerVerify {
                asr: asr.clone(),
                spec: Arc::new({
                    let spec = spec.clone();
                    move || spec.clone()
                }),
                wav: resources.verify_wav.clone(),
            }),
            move |s| {
                let mut g = l.lock().unwrap();
                if g.as_ref().map(|x: &ProvisioningStatus| x.stage) != Some(s.stage) {
                    println!(
                        "stage: {:?} items={:?}",
                        s.stage,
                        s.items
                            .iter()
                            .map(|i| (i.id, i.state, i.bytes_done, i.bytes_total))
                            .collect::<Vec<_>>()
                    );
                }
                *g = Some(s.clone());
            },
        )
        .unwrap();
        println!("初期: {:?}", p.status().stage);
        let t = Instant::now();
        p.start();
        loop {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let fin = lock(&p.running)
                .as_ref()
                .is_none_or(|r| *r.finished.borrow());
            if fin {
                break;
            }
        }
        let s = p.status();
        println!(
            "終了: {:?} error={:?} ({}秒)",
            s.stage,
            s.error,
            t.elapsed().as_secs()
        );
        assert_eq!(s.stage, Stage::Done);
        println!(
            "provisioned.json: {}",
            std::fs::read_to_string(paths.provisioned()).unwrap()
        );

        // verify で起動したサーバーをそのまま使う
        let (_tx, rx) = Cancel::pair();
        let url = asr.wait_ready(rx.receiver()).await.unwrap();
        println!("server: {url}");
        let client = crate::asr::connect(url.clone()).unwrap();
        println!("health: {}", client.health().await.unwrap());
        let wav = std::fs::read(env_path("MUKUCHI_IT_WAV")).unwrap();
        let tr = client
            .transcribe(wav, crate::i18n::Locale::Ja, None)
            .await
            .unwrap();
        println!(
            "transcribe: {}文字, server {:?}ms",
            tr.text.chars().count(),
            tr.server_ms
        );
        assert!(!tr.text.trim().is_empty());
        asr.stop().await;
        assert!(client.health().await.is_err(), "停止後は応答しない");
    });
}

#[test]
#[ignore]
fn real_catalog_sizes() {
    tauri::async_runtime::block_on(async {
        let http = hf::http_client().unwrap();
        let (_tx, never) = Cancel::pair();
        // 両 OS のカタログ (どちらの OS でも確かめられる)
        for platform in models::Platform::ALL {
            for m in models::Catalog::for_platform(platform).iter() {
                let files = hf::list_files(&http, &m.hf, &never).await.unwrap();
                let total: u64 = files.iter().map(|f| f.size).sum();
                println!(
                    "{platform:?} {}: {} files, {total} bytes",
                    m.id,
                    files.len()
                );
                assert_eq!(total, m.size_bytes, "{}", m.id);
            }
        }
    });
}
