//! データディレクトリと同梱物のパス (docs/architecture.md「識別子・パス」「同梱物と初回セットアップ」)。

use std::path::{Component, Path, PathBuf};

use anyhow::{bail, Context, Result};

/// 開発用: データディレクトリの場所を差し替える (デバッグビルドのみ)。
/// 検証で利用者 (開発者) の本物のデータ・モデルに触れないため
pub const ENV_DEV_DATA_DIR: &str = "MUKUCHI_DEV_DATA_DIR";
/// 開発用: 同梱 uv の代わりに使う uv (devShell の uv 等。デバッグビルドのみ)
pub const ENV_DEV_UV: &str = "MUKUCHI_DEV_UV";
/// 開発用: 同梱 asr-server/ の代わりに使うディレクトリ (リポジトリの asr-server/ 等。デバッグビルドのみ)
pub const ENV_DEV_ASR_SERVER_DIR: &str = "MUKUCHI_DEV_ASR_SERVER_DIR";
/// 開発用: 同梱 verify.wav の代わりに使う検証用音声 (デバッグビルドのみ)
pub const ENV_DEV_VERIFY_WAV: &str = "MUKUCHI_DEV_VERIFY_WAV";

/// デバッグビルドでだけ環境変数のパスを返す
pub fn dev_path(name: &str) -> Option<PathBuf> {
    if !cfg!(debug_assertions) {
        return None;
    }
    std::env::var_os(name)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// アプリが作ったデータディレクトリの目印。削除 (アンインストール・実行環境とモデルのみ削除) は
/// これがあるディレクトリだけを対象にする (差し替えたデータディレクトリの指定を誤っても無関係の場所を消さないため)
pub const DATA_MARKER: &str = ".mukuchi-data";

/// `MUKUCHI_DEV_DATA_DIR` の検証。受け付けたら (目印を書く前の) パスを返す。
/// - 絶対パスで `..` を含まない
/// - 存在しない・空・目印がある のいずれか (既存の無関係なディレクトリを使わない)
/// - `.git` を含まない (リポジトリ)
/// - `protected` (target・asr-server 等) と同じか、その祖先でない (削除で巻き込まないため)
pub fn validate_dev_data_dir(dir: &Path, protected: &[PathBuf]) -> Result<PathBuf> {
    if !dir.is_absolute() {
        bail!("絶対パスで指定してください: {}", dir.display());
    }
    if dir.components().any(|c| c == Component::ParentDir) {
        bail!("`..` を含むパスは使えません: {}", dir.display());
    }
    let resolved = resolve_existing(dir);
    if resolved.join(".git").exists() {
        bail!("git リポジトリは使えません: {}", dir.display());
    }
    for p in protected {
        let p = resolve_existing(p);
        if p.starts_with(&resolved) {
            bail!(
                "{} を含むディレクトリは使えません: {}",
                p.display(),
                dir.display()
            );
        }
    }
    match std::fs::read_dir(&resolved) {
        Ok(mut entries) => {
            if !resolved.join(DATA_MARKER).is_file() && entries.next().is_some() {
                bail!(
                    "空でなく、mukuchi が作ったもの ({DATA_MARKER} がある) でもないディレクトリは使えません: {}",
                    dir.display()
                );
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            return Err(e).with_context(|| format!("確認できません: {}", dir.display()));
        }
    }
    Ok(dir.to_path_buf())
}

/// 実在する最も深い祖先までシンボリックリンクを解決し、残りをつなげる (比較用)
pub fn resolve_existing(p: &Path) -> PathBuf {
    let mut rest = Vec::new();
    let mut cur = p;
    loop {
        if let Ok(c) = cur.canonicalize() {
            let mut out = c;
            for r in rest.iter().rev() {
                out.push(r);
            }
            return out;
        }
        match (cur.parent(), cur.file_name()) {
            (Some(parent), Some(name)) => {
                rest.push(name.to_os_string());
                cur = parent;
            }
            _ => return p.to_path_buf(),
        }
    }
}

/// データディレクトリ (`~/Library/Application Support/<バンドルID>/`) 配下のレイアウト
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataPaths {
    root: PathBuf,
}

impl DataPaths {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn marker(&self) -> PathBuf {
        self.root.join(DATA_MARKER)
    }
    /// アプリが作った (目印のある) データディレクトリか
    pub fn has_marker(&self) -> bool {
        self.marker().is_file()
    }
    /// データディレクトリを作り、目印を書く (起動時。本番も開発も)
    pub fn ensure_root(&self) -> Result<()> {
        std::fs::create_dir_all(&self.root)
            .with_context(|| format!("作成できません: {}", self.root.display()))?;
        if !self.has_marker() {
            std::fs::write(self.marker(), b"")
                .with_context(|| format!("作成できません: {}", self.marker().display()))?;
        }
        Ok(())
    }
    pub fn settings(&self) -> PathBuf {
        self.root.join("settings.json")
    }
    /// 導入済みの判定 (runtime/model の版と完了時刻)
    pub fn provisioned(&self) -> PathBuf {
        self.root.join("provisioned.json")
    }
    /// UV_PYTHON_INSTALL_DIR
    pub fn python(&self) -> PathBuf {
        self.root.join("python")
    }
    /// UV_PROJECT_ENVIRONMENT
    pub fn venv(&self) -> PathBuf {
        self.root.join("venv")
    }
    pub fn venv_python(&self) -> PathBuf {
        self.venv().join("bin").join("python")
    }
    /// UV_CACHE_DIR
    pub fn cache(&self) -> PathBuf {
        self.root.join("cache")
    }
    /// uv がその他に書き込む先 (python の実行ファイルのリンク・tool 等)。アプリ外 (~/.local 等) に書かせないため
    pub fn uv(&self) -> PathBuf {
        self.root.join("uv")
    }
    /// 同梱 uv のハッシュのキャッシュ (起動のたびに uv 全体を読まないため)
    pub fn uv_hash_cache(&self) -> PathBuf {
        self.uv().join("bundled-uv-hash.json")
    }
    /// 同梱の asr-server/ をコピーした先 (uv sync のプロジェクト)
    pub fn asr_server(&self) -> PathBuf {
        self.root.join("asr-server")
    }
    /// HF_HOME
    pub fn models(&self) -> PathBuf {
        self.root.join("models")
    }

    /// 実行環境 (runtime) を構成するもの。ストレージ表示と「実行環境とモデルのみ削除」で使う
    pub fn runtime_dirs(&self) -> Vec<PathBuf> {
        vec![
            self.python(),
            self.venv(),
            self.uv(),
            self.cache(),
            self.asr_server(),
        ]
    }
}

/// 同梱物 (.app の Resources 配下)
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resources {
    pub uv: PathBuf,
    pub asr_server: PathBuf,
    pub verify_wav: PathBuf,
}

impl Resources {
    /// `resource_dir` は .app の Contents/Resources。開発時は環境変数で個別に差し替えられる
    pub fn resolve(resource_dir: Option<&Path>) -> Self {
        let base = resource_dir.map(Path::to_path_buf).unwrap_or_default();
        Self {
            uv: dev_path(ENV_DEV_UV).unwrap_or_else(|| base.join("bin").join("uv")),
            asr_server: dev_path(ENV_DEV_ASR_SERVER_DIR).unwrap_or_else(|| base.join("asr-server")),
            verify_wav: dev_path(ENV_DEV_VERIFY_WAV).unwrap_or_else(|| base.join("verify.wav")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dev_data_dir_rules() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().canonicalize().unwrap();
        let target = base.join("repo/src-tauri/target");
        let asr = base.join("repo/asr-server");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::create_dir_all(&asr).unwrap();
        let protected = vec![target.clone(), asr.clone()];
        let ok = |p: &Path| validate_dev_data_dir(p, &protected).is_ok();

        // 存在しない・空
        assert!(ok(&base.join("new/data")));
        std::fs::create_dir_all(base.join("empty")).unwrap();
        assert!(ok(&base.join("empty")));
        // 相対・`..`
        assert!(!ok(Path::new("data")));
        assert!(!ok(&base.join("empty/../empty")));
        // 空でなく目印もない
        std::fs::create_dir_all(base.join("docs")).unwrap();
        std::fs::write(base.join("docs/a.txt"), "x").unwrap();
        assert!(!ok(&base.join("docs")));
        // 目印があれば中身があってもよい
        let paths = DataPaths::new(base.join("data"));
        paths.ensure_root().unwrap();
        std::fs::write(paths.settings(), "{}").unwrap();
        assert!(ok(&base.join("data")));
        // リポジトリ・保護対象の祖先・同じもの
        std::fs::create_dir_all(base.join("repo/.git")).unwrap();
        std::fs::write(base.join("repo/.mukuchi-data"), "").unwrap();
        assert!(!ok(&base.join("repo")));
        assert!(!ok(&target));
        assert!(!ok(&base));
        assert!(!ok(Path::new("/")));
        // シンボリックリンク経由で保護対象の祖先を指す
        std::os::unix::fs::symlink(base.join("repo/src-tauri"), base.join("link")).unwrap();
        assert!(!ok(&base.join("link")));
        // 保護対象の中 (祖先ではない) は構わない
        assert!(ok(&target.join("dev-data")));
    }

    #[test]
    fn ensure_root_writes_marker_once() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = DataPaths::new(tmp.path().join("d"));
        assert!(!paths.has_marker());
        paths.ensure_root().unwrap();
        assert!(paths.has_marker());
        paths.ensure_root().unwrap();
    }
}
