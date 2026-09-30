//! 実行環境 (runtime) の導入: 同梱 uv で Python と asr-server の依存をデータディレクトリに入れる。
//!
//! uv の書き込み先はすべてデータディレクトリ配下に向け、利用者の uv 設定 (uv.toml 等) も読まない
//! (docs/architecture.md「同梱物と初回セットアップ」)。環境変数は引き継がずに必要なものだけ渡す
//! (開発環境の PYTHONPATH や UV_* が混ざると本番と違う結果になるため)。

use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{failed, BoxFuture, Cancel, RuntimeStep, StepError};
use crate::asr_process::open_log;
use crate::paths::{resolve_existing, DataPaths, Resources};

/// uv に引き継ぐ環境変数 (他は渡さない)。プロキシは大文字・小文字の両方を読むツールがあるため両方渡す。
/// `SSL_CERT_FILE` / `SSL_CERT_DIR` は社内の証明書を使う環境向け (uv が読む。uv 0.12.17 で確認)
const PASS_ENV: [&str; 13] = [
    "HOME",
    "TMPDIR",
    "LANG",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "all_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
];

/// asr-server/ のうちコピーするもの (テスト・キャッシュ・venv は除く)
const ASR_SERVER_FILES: [&str; 3] = ["pyproject.toml", "uv.lock", ".python-version"];
const ASR_SERVER_SRC: &str = "src";

pub struct UvRuntime {
    pub paths: DataPaths,
    pub resources: Resources,
    /// uv の出力の書き込み先
    pub log_file: PathBuf,
}

impl UvRuntime {
    fn envs(&self) -> Vec<(&'static str, PathBuf)> {
        let p = &self.paths;
        vec![
            ("UV_PYTHON_INSTALL_DIR", p.python()),
            ("UV_CACHE_DIR", p.cache()),
            ("UV_PROJECT_ENVIRONMENT", p.venv()),
            // `uv python install` は既定で ~/.local/bin に実行ファイルを置く。--no-bin に加えて念のため向け先も変える
            ("UV_PYTHON_BIN_DIR", p.uv().join("bin")),
            ("UV_TOOL_DIR", p.uv().join("tools")),
            ("UV_TOOL_BIN_DIR", p.uv().join("tools").join("bin")),
        ]
    }

    async fn run_uv(&self, args: &[&str], cancel: &Cancel) -> Result<(), StepError> {
        let log = open_log(&self.log_file).map_err(|e| failed(RUNTIME_ERROR, e))?;
        let log_err = log.try_clone().map_err(|e| failed(RUNTIME_ERROR, e))?;
        let mut cmd = tokio::process::Command::new(&self.resources.uv);
        cmd.args(args)
            .current_dir(self.paths.asr_server())
            .env_clear()
            .envs(self.envs())
            .env("UV_NO_CONFIG", "1")
            .env("UV_NO_PROGRESS", "1")
            // システム・開発環境の Python を使わない (版と中身を固定するため)
            .env("UV_PYTHON_PREFERENCE", "only-managed")
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            // OS の証明書ストアを使う (社内プロキシの独自ルート証明書等にアプリの HTTP 通信と同じく従うため)。
            // uv 0.12 では UV_NATIVE_TLS は非推奨で UV_SYSTEM_CERTS が正 (uv 0.12.17 の --help で確認)
            .env("UV_SYSTEM_CERTS", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(log_err))
            .kill_on_drop(true);
        for key in PASS_ENV {
            if let Some(v) = std::env::var_os(key) {
                cmd.env(key, v);
            }
        }
        log::info!("uv {}", args.join(" "));
        let mut child = cmd.spawn().map_err(|e| {
            failed(
                "実行環境の導入ツール (uv) を起動できません",
                anyhow!(e).context(format!("{}", self.resources.uv.display())),
            )
        })?;
        let status = tokio::select! {
            s = child.wait() => s.map_err(|e| failed(RUNTIME_ERROR, e))?,
            _ = cancel.cancelled() => {
                // 途中で止めても、やり直しの uv sync がキャッシュを使って続きから進める
                let _ = child.kill().await;
                return Err(StepError::Paused);
            }
        };
        if !status.success() {
            return Err(failed(
                RUNTIME_ERROR,
                anyhow!(
                    "uv {} が失敗: {status} (詳細は {})",
                    args.first().copied().unwrap_or_default(),
                    self.log_file.display()
                ),
            ));
        }
        Ok(())
    }
}

const RUNTIME_ERROR: &str =
    "実行環境の導入に失敗しました。ネットワーク接続を確認して再試行してください";

impl RuntimeStep for UvRuntime {
    fn version(&self) -> Option<String> {
        match runtime_version(&self.resources, Some(&self.paths.uv_hash_cache())) {
            Ok(v) => Some(v),
            Err(e) => {
                log::warn!("同梱物の版を求められません: {e:#}");
                None
            }
        }
    }

    fn is_present(&self) -> bool {
        self.paths.venv_python().exists() && self.paths.asr_server().join("pyproject.toml").exists()
    }

    fn install(&self, cancel: Cancel) -> BoxFuture<Result<(), StepError>> {
        let this = Self {
            paths: self.paths.clone(),
            resources: self.resources.clone(),
            log_file: self.log_file.clone(),
        };
        Box::pin(async move {
            if !this.resources.uv.is_file() {
                return Err(failed(
                    "実行環境の導入ツール (uv) が見つかりません。アプリを入れ直してください",
                    anyhow!("{}", this.resources.uv.display()),
                ));
            }
            let (src, dst) = (this.resources.asr_server.clone(), this.paths.asr_server());
            tauri::async_runtime::spawn_blocking(move || copy_asr_server(&src, &dst))
                .await
                .map_err(|e| failed(RUNTIME_ERROR, anyhow!("{e}")))?
                .map_err(|e| {
                    failed(
                        "文字起こしサーバーの同梱ファイルを展開できません。アプリを入れ直してください",
                        e,
                    )
                })?;
            // .python-version の版を python/ に入れる。引数なしの `uv python install` は
            // .python-version があっても最新版も入れる (uv 0.12.17 で確認) ため版を明示する
            let version = std::fs::read_to_string(this.paths.asr_server().join(".python-version"))
                .map_err(|e| failed(RUNTIME_ERROR, e))?;
            let version = version.trim();
            this.run_uv(&["python", "install", version, "--no-bin"], &cancel)
                .await?;
            let project = this.paths.asr_server();
            let project = project.to_string_lossy();
            this.run_uv(
                &[
                    "sync",
                    "--frozen",
                    "--no-dev",
                    // 初回起動 (モデル読み込み前の import) を速くする
                    "--compile-bytecode",
                    "--project",
                    &project,
                ],
                &cancel,
            )
            .await?;
            Ok(())
        })
    }
}

/// asr-server/ のうち必要なものの一覧 (相対パス、並びは一定)
fn asr_server_files(src: &Path) -> Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    for f in ASR_SERVER_FILES {
        if !src.join(f).is_file() {
            anyhow::bail!("{} がない", src.join(f).display());
        }
        out.push(PathBuf::from(f));
    }
    let mut stack = vec![PathBuf::from(ASR_SERVER_SRC)];
    while let Some(rel) = stack.pop() {
        let mut entries: Vec<_> = std::fs::read_dir(src.join(&rel))
            .with_context(|| format!("読めません: {}", src.join(&rel).display()))?
            .collect::<std::io::Result<_>>()?;
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let name = e.file_name();
            let ft = e.file_type()?;
            let child = rel.join(&name);
            if ft.is_dir() {
                if name != "__pycache__" {
                    stack.push(child);
                }
            } else if ft.is_file() && Path::new(&name).extension().is_none_or(|x| x != "pyc") {
                out.push(child);
            }
        }
    }
    out.sort();
    Ok(out)
}

/// 同梱の asr-server/ をデータディレクトリにコピーする (前回のものは消してから)。
/// コピー元とコピー先が同じ・入れ子なら何もせずエラー (開発で差し替えたパスの誤りで元を消さないため)
pub fn copy_asr_server(src: &Path, dst: &Path) -> Result<()> {
    let (s, d) = (resolve_existing(src), resolve_existing(dst));
    if s.starts_with(&d) || d.starts_with(&s) {
        bail!(
            "コピー元とコピー先が重なっています: {} → {}",
            src.display(),
            dst.display()
        );
    }
    let files = asr_server_files(src)?;
    if dst.exists() {
        std::fs::remove_dir_all(dst)
            .with_context(|| format!("削除できません: {}", dst.display()))?;
    }
    for rel in files {
        let to = dst.join(&rel);
        if let Some(dir) = to.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::copy(src.join(&rel), &to)
            .with_context(|| format!("コピーできません: {}", rel.display()))?;
    }
    Ok(())
}

/// runtime の版: 同梱 uv と asr-server/ (依存の lock・ソース) の内容のハッシュ。
/// アプリの更新でどちらかが変わった時だけ導入し直す。
/// uv (数十MB) のハッシュは `uv_cache` に大きさ・更新時刻と一緒に保存し、変わっていなければ読み直さない
pub fn runtime_version(resources: &Resources, uv_cache: Option<&Path>) -> Result<String> {
    let mut h = Sha256::new();
    h.update(b"uv\0");
    h.update(uv_hash(&resources.uv, uv_cache)?.as_bytes());
    h.update([0]);
    for rel in asr_server_files(&resources.asr_server)? {
        h.update(rel.to_string_lossy().as_bytes());
        h.update([0]);
        h.update(sha256_file(&resources.asr_server.join(&rel))?.as_bytes());
        h.update([0]);
    }
    Ok(hex::encode(h.finalize()))
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HashCache {
    path: PathBuf,
    size: u64,
    mtime_ns: u128,
    sha256: String,
}

fn uv_hash(uv: &Path, cache: Option<&Path>) -> Result<String> {
    let meta = std::fs::metadata(uv).with_context(|| format!("読めません: {}", uv.display()))?;
    let mtime_ns = meta
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let key = |sha256: String| HashCache {
        path: uv.to_path_buf(),
        size: meta.len(),
        mtime_ns,
        sha256,
    };
    if let Some(c) = cache {
        if let Some(hit) = std::fs::read(c)
            .ok()
            .and_then(|b| serde_json::from_slice::<HashCache>(&b).ok())
            .filter(|hc| *hc == key(hc.sha256.clone()))
        {
            return Ok(hit.sha256);
        }
    }
    let sha = sha256_file(uv)?;
    if let Some(c) = cache {
        // 保存できなくても次回計算し直すだけ
        let saved = c
            .parent()
            .map_or(Ok(()), std::fs::create_dir_all)
            .map_err(anyhow::Error::from)
            .and_then(|()| Ok(std::fs::write(c, serde_json::to_vec(&key(sha.clone()))?)?));
        if let Err(e) = saved {
            log::warn!("uv のハッシュを保存できません: {e:#}");
        }
    }
    Ok(sha)
}

fn sha256_file(path: &Path) -> Result<String> {
    use std::io::Read;
    let mut h = Sha256::new();
    let mut f =
        std::fs::File::open(path).with_context(|| format!("読めません: {}", path.display()))?;
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex::encode(h.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_asr_server(dir: &Path) {
        std::fs::create_dir_all(dir.join("src/pkg/__pycache__")).unwrap();
        std::fs::create_dir_all(dir.join("tests")).unwrap();
        std::fs::create_dir_all(dir.join(".venv")).unwrap();
        for f in ASR_SERVER_FILES {
            std::fs::write(dir.join(f), f).unwrap();
        }
        std::fs::write(dir.join("src/pkg/__init__.py"), "").unwrap();
        std::fs::write(dir.join("src/pkg/__pycache__/x.pyc"), "").unwrap();
        std::fs::write(dir.join("tests/test_x.py"), "").unwrap();
    }

    #[test]
    fn copies_only_needed_files() {
        let tmp = tempfile::tempdir().unwrap();
        let (src, dst) = (tmp.path().join("src"), tmp.path().join("dst"));
        fake_asr_server(&src);
        std::fs::create_dir_all(dst.join("stale")).unwrap();
        copy_asr_server(&src, &dst).unwrap();
        assert!(dst.join("uv.lock").is_file());
        assert!(dst.join("src/pkg/__init__.py").is_file());
        assert!(!dst.join("src/pkg/__pycache__").exists());
        assert!(!dst.join("tests").exists());
        assert!(!dst.join(".venv").exists());
        assert!(!dst.join("stale").exists());
    }

    #[test]
    fn version_changes_with_contents() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("asr");
        fake_asr_server(&src);
        let uv = tmp.path().join("uv");
        std::fs::write(&uv, "uv-1").unwrap();
        let r = Resources {
            uv: uv.clone(),
            asr_server: src.clone(),
            verify_wav: tmp.path().join("v.wav"),
        };
        let v1 = runtime_version(&r, None).unwrap();
        assert_eq!(v1, runtime_version(&r, None).unwrap());
        // キャッシュ (pyc) は版に影響しない
        std::fs::write(src.join("src/pkg/__pycache__/y.pyc"), "x").unwrap();
        assert_eq!(v1, runtime_version(&r, None).unwrap());
        std::fs::write(src.join("uv.lock"), "changed").unwrap();
        let v2 = runtime_version(&r, None).unwrap();
        assert_ne!(v1, v2);
        std::fs::write(&uv, "uv-2").unwrap();
        assert_ne!(v2, runtime_version(&r, None).unwrap());
        std::fs::remove_file(src.join("uv.lock")).unwrap();
        assert!(runtime_version(&r, None).is_err());
    }

    #[test]
    fn refuses_overlapping_copy() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("asr");
        fake_asr_server(&src);
        assert!(copy_asr_server(&src, &src).is_err());
        assert!(copy_asr_server(&src, &src.join("sub")).is_err());
        assert!(copy_asr_server(&src.join("src"), &src).is_err());
        assert!(copy_asr_server(&src, tmp.path()).is_err());
        // 元は消えていない
        assert!(src.join("uv.lock").is_file());
    }

    #[test]
    fn uv_hash_is_cached_by_size_and_mtime() {
        let tmp = tempfile::tempdir().unwrap();
        let uv = tmp.path().join("uv");
        let cache = tmp.path().join("cache/uv.json");
        std::fs::write(&uv, "uv-1").unwrap();
        let t0 = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000);
        let set_mtime = |t| {
            std::fs::File::options()
                .write(true)
                .open(&uv)
                .unwrap()
                .set_modified(t)
                .unwrap()
        };
        set_mtime(t0);
        let h1 = uv_hash(&uv, Some(&cache)).unwrap();
        assert!(cache.is_file());
        // 大きさ・時刻が同じなら読み直さない (キャッシュの値を使う)
        std::fs::write(&uv, "uv-2").unwrap();
        set_mtime(t0);
        assert_eq!(uv_hash(&uv, Some(&cache)).unwrap(), h1);
        // 時刻が変われば計算し直す
        set_mtime(t0 + std::time::Duration::from_secs(1));
        let h2 = uv_hash(&uv, Some(&cache)).unwrap();
        assert_ne!(h1, h2);
        assert_eq!(h2, sha256_file(&uv).unwrap());
    }
}
