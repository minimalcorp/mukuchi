//! 実行環境 (runtime) の導入 (Windows): 同梱の llama-server (Vulkan 版) を確かめ、CPU 実行に同意していれば
//! CPU 版を取得する (docs/architecture.md「ASR (Windows)」「GPU の判定と CPU 実行の同意」)。
//!
//! - 同梱物はインストール先から直接使う (データディレクトリにコピーしない)
//! - GPU が使えず CPU 実行への同意も無い間は、何も取得せずに止める (`precheck`。フロントが同意画面を出す)
//! - CPU 版は GitHub Release の zip を sha256 で確かめ、Windows 標準の tar (bsdtar) で展開して
//!   `<データ>/llama-cpu/` に必要なファイルだけを置く

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{anyhow, bail, Context, Result};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use super::{failed, BoxFuture, Cancel, RuntimeStep, StepError};
use crate::gpu::GpuManager;
use crate::i18n::Msg;
use crate::llama::{self, SERVER_EXE};
use crate::paths::DataPaths;

/// CPU 版から置くファイル (同梱の Vulkan 版と同じ最小構成から ggml-vulkan.dll を除いたもの。
/// apps/desktop/scripts/fetch-llama-server.mjs の KEEP と合わせる)
const CPU_KEEP: [&str; 8] = [
    "llama-server.exe",
    "llama-server-impl.dll",
    "llama-common.dll",
    "llama.dll",
    "mtmd.dll",
    "ggml.dll",
    "ggml-base.dll",
    "libomp.dll",
];
/// CPU の機能ごとの版 (ggml が実行時に CPU に合うものを選ぶため全部置く)
fn cpu_keep(name: &str) -> bool {
    CPU_KEEP.contains(&name)
        || name == "LICENSE-LLVM-OpenMP"
        || (name.starts_with("ggml-cpu-") && name.ends_with(".dll"))
}
/// CPU 版を置いたことの印 (中身は zip の sha256)。途中で止まった展開を済みとみなさないため最後に書く
const CPU_STAMP: &str = ".mukuchi-llama-cpu";

pub struct LlamaRuntime {
    pub paths: DataPaths,
    /// 同梱の llama-server.exe
    pub bundled_exe: PathBuf,
    pub gpu: Arc<GpuManager>,
    pub http: reqwest::Client,
}

/// CPU 版が置かれているか (印が今の zip のものか)
pub fn cpu_present(dir: &Path) -> bool {
    dir.join(SERVER_EXE).is_file()
        && std::fs::read_to_string(dir.join(CPU_STAMP))
            .is_ok_and(|s| s.trim() == llama::CPU_ZIP_SHA256)
}

impl RuntimeStep for LlamaRuntime {
    fn precheck(&self) -> BoxFuture<Result<(), StepError>> {
        let gpu = self.gpu.clone();
        let exe = self.bundled_exe.clone();
        Box::pin(async move {
            if !exe.is_file() {
                return Err(failed(
                    Msg::LlamaServerMissing,
                    anyhow!("{}", exe.display()),
                ));
            }
            // 判定は起動時に済んでいることが多い。再試行で GPU を挿し直した・ドライバーを入れた場合に備えて判定し直す
            let status = gpu.probe().await;
            if let Some(e) = gpu.launch_error() {
                return Err(failed(Msg::LlamaServerBroken, anyhow!(e)));
            }
            if gpu.needs_consent() {
                return Err(failed(
                    Msg::GpuConsentRequired,
                    anyhow!("GPU が使えず ({:?})、CPU 実行への同意が無い", status.kind),
                ));
            }
            Ok(())
        })
    }

    fn version(&self) -> Option<String> {
        Some(llama::runtime_version())
    }

    fn is_present(&self) -> bool {
        self.bundled_exe.is_file() && (!self.gpu.uses_cpu() || cpu_present(&self.paths.llama_cpu()))
    }

    fn install(&self, cancel: Cancel) -> BoxFuture<Result<(), StepError>> {
        let paths = self.paths.clone();
        let gpu = self.gpu.clone();
        let http = self.http.clone();
        Box::pin(async move {
            if !gpu.uses_cpu() {
                return Ok(());
            }
            let dir = paths.llama_cpu();
            if cpu_present(&dir) {
                return Ok(());
            }
            log::info!("CPU 版の llama-server を取得する");
            install_cpu(&http, &paths, &cancel).await?;
            // 置いたものが起動できるか (DLL が揃っているか) を確かめる
            llama::list_devices(&dir.join(SERVER_EXE))
                .await
                .map_err(|e| failed(Msg::LlamaServerBroken, e))?;
            Ok(())
        })
    }
}

async fn install_cpu(
    http: &reqwest::Client,
    paths: &DataPaths,
    cancel: &Cancel,
) -> Result<(), StepError> {
    let root = paths.root();
    let zip = root.join(format!("{}.part", llama::CPU_ZIP));
    let tmp = root.join("llama-cpu.tmp");
    let result = async {
        download_cpu_zip(http, &zip, cancel).await?;
        extract_cpu(&zip, &tmp, &paths.llama_cpu())
            .await
            .map_err(|e| failed(CPU_ERROR, e))
    }
    .await;
    // 成功・失敗・一時停止のどれでも途中のもの (zip・展開先) を残さない (18MB のため再開せず取り直す)
    let _ = std::fs::remove_file(&zip);
    let _ = std::fs::remove_dir_all(&tmp);
    result
}

const CPU_ERROR: Msg = Msg::CpuRuntimeFailed;

/// CPU 版の zip を取得し、sha256 を確かめる
async fn download_cpu_zip(
    http: &reqwest::Client,
    zip: &Path,
    cancel: &Cancel,
) -> Result<(), StepError> {
    let res = tokio::select! {
        r = http.get(llama::CPU_ZIP_URL).send() => r.map_err(|e| failed(CPU_ERROR, e.without_url()))?,
        _ = cancel.cancelled() => return Err(StepError::Paused),
    };
    if !res.status().is_success() {
        return Err(failed(CPU_ERROR, anyhow!("HTTP {}", res.status())));
    }
    let mut file = tokio::fs::File::create(zip)
        .await
        .map_err(|e| failed(CPU_ERROR, e))?;
    let mut hash = Sha256::new();
    let mut res = res;
    loop {
        let chunk = tokio::select! {
            c = res.chunk() => c.map_err(|e| failed(CPU_ERROR, e.without_url()))?,
            _ = cancel.cancelled() => return Err(StepError::Paused),
        };
        let Some(bytes) = chunk else { break };
        hash.update(&bytes);
        file.write_all(&bytes)
            .await
            .map_err(|e| failed(CPU_ERROR, e))?;
    }
    file.flush().await.map_err(|e| failed(CPU_ERROR, e))?;
    let actual = hex::encode(hash.finalize());
    if actual != llama::CPU_ZIP_SHA256 {
        return Err(failed(
            CPU_ERROR,
            anyhow!(
                "sha256 が一致しない: {actual} (期待値 {})",
                llama::CPU_ZIP_SHA256
            ),
        ));
    }
    Ok(())
}

/// zip を一時ディレクトリ `tmp` に展開し、必要なファイルだけを `dest` に置く (前のものは消してから)
async fn extract_cpu(zip: &Path, tmp: &Path, dest: &Path) -> Result<()> {
    if tmp.exists() {
        std::fs::remove_dir_all(tmp)
            .with_context(|| format!("削除できません: {}", tmp.display()))?;
    }
    std::fs::create_dir_all(tmp)?;
    // Windows 標準の bsdtar は zip を展開でき、絶対パス・`..` を含む項目を既定で拒む。
    // 他の子プロセスと同じく環境変数を絞り、窓を出さず、Job Object に入れる
    let tar = crate::platform::process::system_root().join(r"System32\tar.exe");
    let mut cmd = tokio::process::Command::new(&tar);
    cmd.arg("-xf")
        .arg(zip)
        .arg("-C")
        .arg(tmp)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    crate::platform::process::configure(&mut cmd);
    let child = cmd
        .spawn()
        .with_context(|| format!("起動できません: {}", tar.display()))?;
    crate::platform::process::assign_to_job(&child);
    let out = child.wait_with_output().await?;
    if !out.status.success() {
        bail!(
            "zip を展開できません: {} {}",
            out.status,
            String::from_utf8_lossy(&out.stderr)
                .chars()
                .take(300)
                .collect::<String>()
        );
    }
    let (tmp, dest) = (tmp.to_path_buf(), dest.to_path_buf());
    tauri::async_runtime::spawn_blocking(move || place_cpu_files(&tmp, &dest))
        .await
        .map_err(|e| anyhow!("{e}"))?
}

/// 展開したものから必要なファイルだけを置き、最後に印を書く
fn place_cpu_files(tmp: &Path, dest: &Path) -> Result<()> {
    // zip の最上位にファイルが並ぶ (b11408 で確認)。念のため1段のフォルダも探す
    let src = if tmp.join(SERVER_EXE).is_file() {
        tmp.to_path_buf()
    } else {
        std::fs::read_dir(tmp)?
            .flatten()
            .map(|e| e.path())
            .find(|p| p.join(SERVER_EXE).is_file())
            .ok_or_else(|| anyhow!("zip に {SERVER_EXE} がない"))?
    };
    if dest.exists() {
        std::fs::remove_dir_all(dest)
            .with_context(|| format!("削除できません: {}", dest.display()))?;
    }
    std::fs::create_dir_all(dest)?;
    let mut copied = 0;
    for e in std::fs::read_dir(&src)?.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if e.file_type()?.is_file() && cpu_keep(&name) {
            std::fs::copy(e.path(), dest.join(&name))
                .with_context(|| format!("コピーできません: {name}"))?;
            copied += 1;
        }
    }
    for name in CPU_KEEP {
        if !dest.join(name).is_file() {
            bail!("zip に {name} がない");
        }
    }
    std::fs::write(dest.join(CPU_STAMP), llama::CPU_ZIP_SHA256)?;
    log::info!("CPU 版の llama-server を置いた ({copied} ファイル)");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpu_files_are_minimal() {
        for n in [
            "llama-server.exe",
            "ggml-cpu-haswell.dll",
            "libomp.dll",
            "LICENSE-LLVM-OpenMP",
        ] {
            assert!(cpu_keep(n), "{n}");
        }
        for n in [
            "llama-cli.exe",
            "ggml-rpc.dll",
            "llama-bench.exe",
            "ggml-cpu-x.txt",
        ] {
            assert!(!cpu_keep(n), "{n}");
        }
    }

    #[test]
    fn cpu_presence_needs_stamp() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        assert!(!cpu_present(d));
        std::fs::write(d.join(SERVER_EXE), b"").unwrap();
        assert!(!cpu_present(d), "印が無ければ途中");
        std::fs::write(d.join(CPU_STAMP), "other").unwrap();
        assert!(!cpu_present(d), "別の版");
        std::fs::write(d.join(CPU_STAMP), llama::CPU_ZIP_SHA256).unwrap();
        assert!(cpu_present(d));
    }

    /// 手動の通し確認 (`cargo test -- --ignored real_provision_windows --nocapture`)。実機の GPU・ネットワークを使う。
    /// 本番と同じ部品 (GpuManager・LlamaRuntime・Hugging Face からの取得・ServerVerify・asr_process・LlamaClient) で:
    /// 1. GPU で runtime → model (話す言語 ja の推奨。約2.2GB) → verify、TTS の音声を認識、停止
    /// 2. GPU なし (`MUKUCHI_DEV_FORCE_GPU=none`) で未同意: 何も取得せず止まる
    /// 3. 同意: CPU 版を取得して CPU で verify・認識
    /// 4. integrated・driver_missing・ok の判定
    ///
    /// 環境変数: `MUKUCHI_IT_DATA_DIR` (データ。取得したモデルを再利用する)、`MUKUCHI_IT_LLAMA_DIR` (同梱の
    /// llama-server/)、`MUKUCHI_IT_VERIFY_WAV`、`MUKUCHI_IT_WAVS` (認識する WAV。`;` 区切り)、`MUKUCHI_IT_EMPTY_DIR`
    /// (2 で使う空のデータディレクトリ)
    #[test]
    #[ignore]
    fn real_provision_windows() {
        use super::super::{models, Provisioner, ProvisioningStatus, ServerVerify, Stage};
        use crate::asr_process::AsrProcess;
        use crate::gpu::{ExecDevice, GpuKind};
        use std::sync::Mutex;
        let env = |k: &str| std::env::var(k).unwrap_or_else(|_| panic!("{k} が未設定"));
        let force = |v: &str| std::env::set_var(crate::gpu::ENV_DEV_FORCE_GPU, v);

        let run = |paths: &DataPaths,
                   gpu: Arc<GpuManager>,
                   asr: Arc<AsrProcess>|
         -> (Arc<Provisioner>, ProvisioningStatus) {
            let model = models::Catalog::distributed()
                .recommended(crate::i18n::Locale::Ja)
                .hf
                .clone();
            let m = model.clone();
            let (hf_home, logs) = (paths.models(), paths.root().join("logs"));
            let g = gpu.clone();
            let p = Provisioner::new(
                paths.clone(),
                Arc::new(move || m.clone()),
                Arc::new(LlamaRuntime {
                    paths: paths.clone(),
                    bundled_exe: PathBuf::from(env("MUKUCHI_IT_LLAMA_DIR")).join(SERVER_EXE),
                    gpu: gpu.clone(),
                    http: super::super::hf::http_client().unwrap(),
                }),
                Arc::new(ServerVerify {
                    asr,
                    spec: Arc::new(move || {
                        llama::launch_spec(&hf_home, &model, &g, logs.join("asr-server.log"))
                    }),
                    wav: PathBuf::from(env("MUKUCHI_IT_VERIFY_WAV")),
                }),
                |_| {},
            )
            .unwrap();
            let t = std::time::Instant::now();
            p.start();
            tauri::async_runtime::block_on(async {
                loop {
                    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                    if !p.is_running() {
                        break;
                    }
                }
            });
            let s = p.status();
            println!(
                "セットアップ: {:?} error={:?} ({}秒)",
                s.stage,
                s.error.as_ref().map(|e| e.to_string()),
                t.elapsed().as_secs()
            );
            (p, s)
        };
        // 導入済みで動作確認を省いた時は、本番の起動 (core の start_managed_asr) と同じく起動する
        let transcribe_all = |asr: &Arc<AsrProcess>, paths: &DataPaths, gpu: &GpuManager| {
            tauri::async_runtime::block_on(async {
                if !asr.is_running() {
                    let model = models::Catalog::distributed()
                        .recommended(crate::i18n::Locale::Ja)
                        .hf
                        .clone();
                    let spec = llama::launch_spec(
                        &paths.models(),
                        &model,
                        gpu,
                        paths.root().join(r"logs\asr-server.log"),
                    );
                    println!("起動: {:?}", spec.exec);
                    asr.start(spec, true).await;
                }
                let (_tx, rx) = tokio::sync::watch::channel(false);
                let url = asr.wait_ready(rx).await.unwrap();
                let c = crate::asr::connect(url).unwrap();
                for w in env("MUKUCHI_IT_WAVS").split(';') {
                    let wav = std::fs::read(w).unwrap();
                    let t = std::time::Instant::now();
                    let r = c
                        .transcribe(wav, crate::i18n::Locale::Ja, None)
                        .await
                        .unwrap();
                    println!(
                        "  {} → 「{}」 {}ms",
                        w.rsplit('\\').next().unwrap(),
                        r.text,
                        t.elapsed().as_millis()
                    );
                }
                // 無音 3 秒 (元の Qwen は暴走した入力)
                let silence = crate::audio::encode_wav_16k(&[0.0; 48_000]).unwrap();
                let r = c
                    .transcribe(silence, crate::i18n::Locale::Ja, None)
                    .await
                    .unwrap();
                println!("  無音 3 秒 → 「{}」", r.text);
                c
            })
        };

        let emitted = Arc::new(Mutex::new(Vec::new()));
        let new_gpu = |paths: &DataPaths, accepted: bool| {
            let e = emitted.clone();
            Arc::new(GpuManager::new(
                PathBuf::from(env("MUKUCHI_IT_LLAMA_DIR")).join(SERVER_EXE),
                paths.llama_cpu().join(SERVER_EXE),
                accepted,
                move |s| e.lock().unwrap().push(s.clone()),
            ))
        };

        // 1. GPU
        force("");
        let paths = DataPaths::new(env("MUKUCHI_IT_DATA_DIR"));
        paths.ensure_root().unwrap();
        let gpu = new_gpu(&paths, false);
        let st = tauri::async_runtime::block_on(gpu.status());
        println!("GPU: {st:?}");
        assert_eq!(st.kind, GpuKind::Ok);
        let asr = Arc::new(AsrProcess::new());
        let (_p, s) = run(&paths, gpu.clone(), asr.clone());
        assert_eq!(s.stage, Stage::Done);
        println!(
            "provisioned.json: {}",
            std::fs::read_to_string(paths.provisioned()).unwrap()
        );
        let c = transcribe_all(&asr, &paths, &gpu);
        tauri::async_runtime::block_on(asr.stop());
        assert!(
            tauri::async_runtime::block_on(c.health()).is_err(),
            "停止後は応答しない"
        );
        let log =
            std::fs::read_to_string(paths.root().join(r"logs\asr-server.log")).unwrap_or_default();
        println!("asr-server.log: {} 行", log.lines().count());

        // 2. GPU なし・未同意: 何も取得しない
        force("none");
        let empty = DataPaths::new(env("MUKUCHI_IT_EMPTY_DIR"));
        empty.ensure_root().unwrap();
        let gpu2 = new_gpu(&empty, false);
        let st = tauri::async_runtime::block_on(gpu2.status());
        assert_eq!((st.kind, st.device), (GpuKind::None, ExecDevice::Gpu));
        assert!(gpu2.needs_consent());
        let (_p, s) = run(&empty, gpu2.clone(), Arc::new(AsrProcess::new()));
        assert_eq!(s.stage, Stage::Error);
        assert!(!empty.models().exists(), "モデルを取得しない");
        assert!(!empty.llama_cpu().exists(), "CPU 版を取得しない");

        // 3. 同意: CPU 版を取得して CPU で動かす (モデルは 1 のものを使う)
        let gpu3 = new_gpu(&paths, false);
        tauri::async_runtime::block_on(gpu3.status());
        let asr3 = Arc::new(AsrProcess::new());
        // 導入済み (GPU で入れた) の間は何もしない。起動しないのは Core (gpu_allows_asr) が同意を見て決める
        assert!(gpu3.needs_consent());
        let (p3, s) = run(&paths, gpu3.clone(), asr3.clone());
        assert_eq!(s.stage, Stage::Done);
        gpu3.set_accepted(true);
        assert_eq!(gpu3.status_now().unwrap().device, ExecDevice::Cpu);
        p3.refresh();
        assert!(!p3.is_done(), "CPU 版が無ければ runtime をやり直す");
        drop(p3);
        let (_p, s) = run(&paths, gpu3.clone(), asr3.clone());
        assert_eq!(s.stage, Stage::Done);
        assert!(cpu_present(&paths.llama_cpu()));
        transcribe_all(&asr3, &paths, &gpu3);
        tauri::async_runtime::block_on(asr3.stop());

        // 4. 他の判定
        for (v, kind) in [
            ("integrated", GpuKind::Integrated),
            ("driver_missing", GpuKind::DriverMissing),
            ("ok", GpuKind::Ok),
        ] {
            force(v);
            let g = new_gpu(&paths, false);
            let st = tauri::async_runtime::block_on(g.status());
            println!(
                "{v}: {st:?} exec={:?} needs_consent={}",
                g.exec().1,
                g.needs_consent()
            );
            assert_eq!(st.kind, kind);
            assert_eq!(g.needs_consent(), kind == GpuKind::DriverMissing);
        }
        force("");
        println!("gpu-status-changed: {} 回", emitted.lock().unwrap().len());
    }

    /// 手動の確認 (`cargo test -- --ignored real_cpu_runtime`): 実際に CPU 版を取得・展開し、起動できること。
    /// `MUKUCHI_IT_DATA_DIR` に書く
    #[test]
    #[ignore]
    fn real_cpu_runtime() {
        tauri::async_runtime::block_on(async {
            let dir = std::env::var_os("MUKUCHI_IT_DATA_DIR").expect("MUKUCHI_IT_DATA_DIR");
            let paths = DataPaths::new(dir);
            paths.ensure_root().unwrap();
            let http = super::super::hf::http_client().unwrap();
            let (_tx, never) = Cancel::pair();
            install_cpu(&http, &paths, &never).await.unwrap();
            assert!(cpu_present(&paths.llama_cpu()));
            let d = llama::list_devices(&paths.llama_cpu().join(SERVER_EXE))
                .await
                .unwrap();
            assert!(d.is_empty(), "CPU 版は GPU を列挙しない: {d:?}");
        });
    }
}
