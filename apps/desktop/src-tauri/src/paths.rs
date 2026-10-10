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
/// 開発用 (Windows): 同梱 llama-server/ の代わりに使うディレクトリ (デバッグビルドのみ)
#[cfg(target_os = "windows")]
pub const ENV_DEV_LLAMA_SERVER_DIR: &str = "MUKUCHI_DEV_LLAMA_SERVER_DIR";

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
    // Windows は Python を使わない
    #[cfg_attr(target_os = "windows", allow(dead_code))]
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
    #[cfg_attr(target_os = "windows", allow(dead_code))]
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
    /// Windows: CPU 実行に同意した時に取得する CPU 版の llama-server (同梱の Vulkan 版はコピーしない)
    #[cfg(target_os = "windows")]
    pub fn llama_cpu(&self) -> PathBuf {
        self.root.join("llama-cpu")
    }

    /// 実行環境 (runtime) を構成するもの。ストレージ表示と「実行環境とモデルのみ削除」で使う
    pub fn runtime_dirs(&self) -> Vec<PathBuf> {
        #[allow(unused_mut)]
        let mut dirs = vec![
            self.python(),
            self.venv(),
            self.uv(),
            self.cache(),
            self.asr_server(),
        ];
        #[cfg(target_os = "windows")]
        dirs.push(self.llama_cpu());
        dirs
    }
}

/// 同梱物 (uv は .app の Contents/Helpers、その他は Contents/Resources 配下)
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resources {
    pub uv: PathBuf,
    pub asr_server: PathBuf,
    pub verify_wav: PathBuf,
    /// Windows: 同梱の llama-server/ (Vulkan 版。tauri.windows.conf.json の resources)
    #[cfg(target_os = "windows")]
    pub llama_server: PathBuf,
}

impl Resources {
    /// `resource_dir` は .app の Contents/Resources。`uv` は [`resolve_uv`] の結果。
    /// 開発時は環境変数で個別に差し替えられる
    pub fn resolve(resource_dir: Option<&Path>, uv: PathBuf) -> Self {
        let base = resource_dir.map(Path::to_path_buf).unwrap_or_default();
        Self {
            uv,
            asr_server: dev_path(ENV_DEV_ASR_SERVER_DIR).unwrap_or_else(|| base.join("asr-server")),
            verify_wav: dev_path(ENV_DEV_VERIFY_WAV).unwrap_or_else(|| base.join("verify.wav")),
            #[cfg(target_os = "windows")]
            llama_server: dev_path(ENV_DEV_LLAMA_SERVER_DIR)
                .unwrap_or_else(|| base.join("llama-server")),
        }
    }
}

/// dev (未バンドル実行) の uv の Resource 相対パス (`tauri.dev.conf.json` の resources)
pub const DEV_UV_RESOURCE: &str = "bin/uv";

/// 実行ファイルが `<X>.app/Contents/MacOS/` にあれば `<X>.app/Contents/Helpers/uv` を返す
pub fn bundled_uv_path(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let app = contents.parent()?;
    let is_bundle = macos.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && app.extension()? == "app";
    is_bundle.then(|| contents.join("Helpers").join("uv"))
}

/// 同梱 uv の場所を決める。.app 内なら Helpers/uv、それ以外は `dev_resource` (Resource の `bin/uv`)。
/// `MUKUCHI_DEV_UV` (デバッグビルドのみ) はそのまま使う。
/// 見つからない・実行できない場合は Err だが、呼び出し側が表示用に使えるよう候補パスも返す
pub fn resolve_uv(exe: &Path, dev_resource: impl FnOnce() -> Result<PathBuf>) -> UvResolution {
    resolve_uv_with(dev_path(ENV_DEV_UV), exe, dev_resource)
}

/// 見つからない時は (候補パス, 理由)
pub type UvResolution = std::result::Result<PathBuf, (Option<PathBuf>, anyhow::Error)>;

/// テストで開発者の環境 (`MUKUCHI_DEV_UV`) に左右されないよう差し替えを引数で受ける
fn resolve_uv_with(
    dev_override: Option<PathBuf>,
    exe: &Path,
    dev_resource: impl FnOnce() -> Result<PathBuf>,
) -> UvResolution {
    if let Some(p) = dev_override {
        return Ok(p);
    }
    let candidate = match bundled_uv_path(exe) {
        Some(p) => p,
        None => dev_resource().map_err(|e| {
            (
                None,
                e.context("実行環境の導入ツール (uv) の場所を決められません"),
            )
        })?,
    };
    check_executable(&candidate).map_err(|e| (Some(candidate), e))
}

/// 実在する実行可能な通常ファイルか確かめ、正規化したパスを返す
pub fn check_executable(p: &Path) -> Result<PathBuf> {
    let c = p.canonicalize().with_context(|| {
        format!(
            "実行環境の導入ツール (uv) が見つかりません。アプリを入れ直してください: {}",
            p.display()
        )
    })?;
    let meta = std::fs::metadata(&c).with_context(|| format!("確認できません: {}", c.display()))?;
    if !meta.is_file() {
        bail!(
            "実行環境の導入ツール (uv) がファイルではありません。アプリを入れ直してください: {}",
            c.display()
        );
    }
    // Windows に実行権限のビットは無い (実行できるかは拡張子で決まる)
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o111 == 0 {
            bail!(
                "実行環境の導入ツール (uv) に実行権限がありません。アプリを入れ直してください: {}",
                c.display()
            );
        }
    }
    Ok(c)
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
        // 正規化前のパスで確かめる (Windows の canonicalize が返す `\\?\` 付きのパスでは `..` が要素にならない)
        assert!(!ok(&tmp.path().join("empty").join("..").join("empty")));
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
        // シンボリックリンク経由で保護対象の祖先を指す (Windows の symlink は権限が要るため unix のみ)
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(base.join("repo/src-tauri"), base.join("link")).unwrap();
            assert!(!ok(&base.join("link")));
        }
        // 保護対象の中 (祖先ではない) は構わない
        assert!(ok(&target.join("dev-data")));
    }

    /// .app の構成・実行権限・symlink を使うため macOS のみ (uv は Mac の実行環境)
    #[test]
    #[cfg(target_os = "macos")]
    fn uv_in_app_bundle_uses_helpers() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().canonicalize().unwrap();
        let contents = base.join("Apps/mukuchi.app/Contents");
        std::fs::create_dir_all(contents.join("MacOS")).unwrap();
        std::fs::create_dir_all(contents.join("Helpers")).unwrap();
        let exe = contents.join("MacOS/mukuchi");
        let uv = contents.join("Helpers/uv");
        let never = || -> Result<PathBuf> { panic!(".app 内では Resource を見ない") };

        assert_eq!(bundled_uv_path(&exe), Some(uv.clone()));
        // 無い
        let (cand, err) = resolve_uv_with(None, &exe, never).unwrap_err();
        assert_eq!(cand, Some(uv.clone()));
        assert!(format!("{err:#}").contains("見つかりません"));
        // 実行権限が無い
        std::fs::write(&uv, b"#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&uv, std::fs::Permissions::from_mode(0o644)).unwrap();
        let (_, err) = resolve_uv_with(None, &exe, never).unwrap_err();
        assert!(format!("{err:#}").contains("実行権限"));
        // ある (シンボリックリンク経由でも正規化した実体を返す)
        std::fs::set_permissions(&uv, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(resolve_uv_with(None, &exe, never).unwrap(), uv);
        std::os::unix::fs::symlink(base.join("Apps"), base.join("link")).unwrap();
        let via_link = base.join("link/mukuchi.app/Contents/MacOS/mukuchi");
        assert_eq!(resolve_uv_with(None, &via_link, never).unwrap(), uv);
        // ディレクトリ
        std::fs::remove_file(&uv).unwrap();
        std::fs::create_dir(&uv).unwrap();
        let (_, err) = resolve_uv_with(None, &exe, never).unwrap_err();
        assert!(format!("{err:#}").contains("ファイルではありません"));
    }

    #[test]
    fn dev_uv_override_is_used_as_is() {
        let p = PathBuf::from("/nonexistent/uv");
        let r = resolve_uv_with(
            Some(p.clone()),
            Path::new("/a.app/Contents/MacOS/x"),
            || bail!("x"),
        );
        assert_eq!(r.unwrap(), p);
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn uv_outside_app_bundle_uses_resource() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().canonicalize().unwrap();
        // tauri dev の target/debug/ や、.app でない Contents/MacOS
        for exe in [
            base.join("target/debug/mukuchi"),
            base.join("NotApp/Contents/MacOS/mukuchi"),
            base.join("x.app/Contents/Other/mukuchi"),
            PathBuf::from("/mukuchi"),
        ] {
            assert_eq!(bundled_uv_path(&exe), None, "{}", exe.display());
        }
        let exe = base.join("target/debug/mukuchi");
        let uv = base.join("target/debug").join(DEV_UV_RESOURCE);
        std::fs::create_dir_all(uv.parent().unwrap()).unwrap();
        std::fs::write(&uv, b"").unwrap();
        std::fs::set_permissions(&uv, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(resolve_uv_with(None, &exe, || Ok(uv.clone())).unwrap(), uv);
        // Resource を解決できない
        let (cand, _) = resolve_uv_with(None, &exe, || bail!("x")).unwrap_err();
        assert_eq!(cand, None);
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
