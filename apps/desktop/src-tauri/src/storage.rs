//! ストレージ表示・「実行環境とモデルのみ削除」・完全なアンインストールの対象と削除
//! (docs/architecture.md「識別子・パス」のアンインストール対象)。
//!
//! Windows はアプリ内でファイルを消さない (データの下の WebView2 のデータ・ログは実行中に使用中で消せないため)。
//! 対象の表示と NSIS のアンインストーラーの起動までを行い、削除はアプリの終了後にアンインストーラー (とフック) が行う
//! (docs/architecture.md「Windows 版」のアンインストール)。

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;

#[cfg(windows)]
use crate::paths::{comparable, is_within, strip_verbatim};
use crate::paths::{DataPaths, DATA_MARKER};

/// 開発用: `1` ならアンインストールで何も消さず、消す対象と操作をログに出すだけにする (デバッグビルドのみ)。
/// Windows の開発ビルドは uninstall.exe が無いため、指定がなくても常にこの動作 (core.rs)
#[cfg_attr(windows, allow(dead_code))]
pub const ENV_DEV_UNINSTALL_DRY_RUN: &str = "MUKUCHI_DEV_UNINSTALL_DRY_RUN";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageUsage {
    pub runtime_bytes: u64,
    pub model_bytes: u64,
    pub other_bytes: u64,
}

/// ディスク上の使用量 (割り当てブロック)。シンボリックリンクはたどらず、ハードリンクは1回だけ数える
pub fn disk_usage(paths: &[PathBuf]) -> u64 {
    let mut seen = HashSet::new();
    paths.iter().map(|p| usage_of(p, &mut seen)).sum()
}

fn usage_of(path: &Path, seen: &mut HashSet<(u64, u64)>) -> u64 {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return 0;
    };
    let mut total = 0;
    if let Some(bytes) = first_seen_bytes(path, &meta, seen) {
        total += bytes;
    }
    if meta.is_dir() {
        if let Ok(entries) = std::fs::read_dir(path) {
            for e in entries.flatten() {
                total += usage_of(&e.path(), seen);
            }
        }
    }
    total
}

/// 初めて見たファイルならその使用量 (割り当てブロック)。同じ実体 (ハードリンク) は1回だけ数える
#[cfg(unix)]
fn first_seen_bytes(
    _path: &Path,
    meta: &std::fs::Metadata,
    seen: &mut HashSet<(u64, u64)>,
) -> Option<u64> {
    use std::os::unix::fs::MetadataExt;
    if seen.insert((meta.dev(), meta.ino())) {
        Some(meta.blocks() * 512)
    } else {
        None
    }
}

/// Windows: ファイルの大きさ (論理サイズ。割り当て量は std の安定版で取れないため)。
/// HF のスナップショットは blob のハードリンク (provisioning/hf.rs) のため、リンクが複数あるファイルは
/// 同じ実体 (ボリュームのシリアル番号 + ファイル ID) を1回だけ数える。ID が取れなければそのまま数える
#[cfg(windows)]
fn first_seen_bytes(
    path: &Path,
    meta: &std::fs::Metadata,
    seen: &mut HashSet<(u64, u64)>,
) -> Option<u64> {
    use ::windows::Win32::Foundation::HANDLE;
    use ::windows::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };
    use std::os::windows::io::AsRawHandle;
    if !meta.is_file() {
        return Some(meta.len());
    }
    let id = std::fs::File::open(path).ok().and_then(|f| {
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        // SAFETY: f が開いている間ハンドルは有効。info はこの呼び出しの間有効
        unsafe { GetFileInformationByHandle(HANDLE(f.as_raw_handle()), &mut info) }.ok()?;
        (info.nNumberOfLinks > 1).then_some((
            info.dwVolumeSerialNumber as u64,
            ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
        ))
    });
    match id {
        Some(id) if !seen.insert(id) => None,
        _ => Some(meta.len()),
    }
}

/// runtime = python・venv・uv・cache (+ asr-server のコピー)、model = models/、other = 設定・ログ
pub fn usage(paths: &DataPaths, log_dir: &Path) -> StorageUsage {
    StorageUsage {
        runtime_bytes: disk_usage(&paths.runtime_dirs()),
        model_bytes: disk_usage(&[paths.models()]),
        other_bytes: disk_usage(&[paths.settings(), paths.provisioned(), log_dir.to_path_buf()]),
    }
}

/// 開発ビルドで破壊的な操作 (アンインストール・実行環境とモデルのみ削除) をしてよいか。
/// 開発ビルドは dev のバンドルID (`.dev` で終わる) で動かす前提。本番のIDで動いている
/// (tauri.dev.conf.json を重ねずに起動した等) と、利用者の本物のデータ・設定・権限を消してしまうため拒む
pub fn destructive_ops_allowed(debug_build: bool, bundle_id: &str) -> bool {
    !debug_build || bundle_id.ends_with(".dev")
}

/// データディレクトリを削除してよいか: 目印があり、リポジトリでないこと
pub fn check_data_dir(dir: &Path) -> Result<()> {
    if !dir.join(DATA_MARKER).is_file() {
        bail!(
            "mukuchi が作ったデータディレクトリではないため削除しません ({DATA_MARKER} がない): {}",
            dir.display()
        );
    }
    if dir.join(".git").exists() {
        bail!("git リポジトリのため削除しません: {}", dir.display());
    }
    Ok(())
}

/// 実行環境とモデルを消す (設定・ログは残す)。導入済みの記録も消す
pub fn delete_runtime_and_model(paths: &DataPaths) -> Result<()> {
    check_data_dir(paths.root())?;
    // 記録を先に消す: 途中で失敗しても「導入済み」のまま残らないように
    remove_path(&paths.provisioned())?;
    let mut targets = paths.runtime_dirs();
    targets.push(paths.models());
    for p in targets {
        remove_path(&p)?;
    }
    Ok(())
}

fn remove_path(p: &Path) -> Result<()> {
    let meta = match std::fs::symlink_metadata(p) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e).with_context(|| format!("確認できません: {}", p.display())),
    };
    let r = if meta.is_dir() {
        std::fs::remove_dir_all(p)
    } else {
        std::fs::remove_file(p)
    };
    r.with_context(|| format!("削除できません: {}", p.display()))
}

// ---- アンインストール --------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UninstallTarget {
    pub path: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UninstallPlan {
    /// 削除するファイル・ディレクトリ (存在するもの)。アプリ本体は含まない
    pub files: Vec<PathBuf>,
    /// `defaults delete` で消す設定 (plist) のドメインとファイル
    pub preferences: Option<(String, PathBuf)>,
    /// ゴミ箱に入れるアプリ本体 (Windows はインストール先のフォルダ。アンインストーラーが消す)
    pub app_bundle: Option<PathBuf>,
    /// Windows: スタートアップの登録 (レジストリの値。表示用)。Mac は空
    pub registry: Vec<String>,
}

pub struct UninstallContext<'a> {
    /// macOS の ~/Library の起点 (Windows は Tauri のパスから求めたデータ・ログだけを見る)
    #[cfg_attr(windows, allow(dead_code))]
    pub home: &'a Path,
    pub bundle_id: &'a str,
    pub data_dir: &'a Path,
    pub log_dir: &'a Path,
    /// 実行中のアプリ本体 (.app。Windows は NSIS で入れたインストール先のフォルダ)。未バンドルの開発実行では None
    pub app_bundle: Option<PathBuf>,
    /// 開発ビルド: 未バンドル実行 (tauri dev) で WebKit がプロダクト名で作る場所も含める。
    /// アプリ本体は `target_dir` の中にあるものだけを対象にする
    pub dev: Option<DevScope<'a>>,
}

pub struct DevScope<'a> {
    pub product_name: &'a str,
    pub target_dir: Option<&'a Path>,
}

/// アンインストールの対象 (存在するものだけ)
pub fn uninstall_plan(ctx: &UninstallContext) -> UninstallPlan {
    let mut candidates = Vec::new();
    match check_data_dir(ctx.data_dir) {
        Ok(()) => candidates.push(ctx.data_dir.to_path_buf()),
        Err(e) => log::warn!("{e:#}"),
    }
    candidates.extend(os_candidates(ctx));
    let mut files: Vec<PathBuf> = Vec::new();
    for c in candidates {
        if std::fs::symlink_metadata(&c).is_ok() && !covered(&files, &c) {
            files.push(c);
        }
    }
    let app_bundle = ctx.app_bundle.clone().filter(|b| match &ctx.dev {
        None => true,
        Some(dev) => {
            let inside = dev.target_dir.is_some_and(|t| in_target(b, t));
            if !inside {
                log::warn!(
                    "開発ビルドのため、target ディレクトリ外のアプリ本体は対象にしない: {}",
                    b.display()
                );
            }
            inside
        }
    });
    UninstallPlan {
        files,
        preferences: preferences(ctx),
        app_bundle,
        registry: registry_entries(),
    }
}

/// データディレクトリ以外の候補 (macOS: ~/Library 配下)
#[cfg(not(windows))]
fn os_candidates(ctx: &UninstallContext) -> Vec<PathBuf> {
    let lib = ctx.home.join("Library");
    let id = ctx.bundle_id;
    let mut candidates = vec![
        lib.join("Caches").join(id),
        ctx.log_dir.to_path_buf(),
        lib.join("WebKit").join(id),
        lib.join("HTTPStorages").join(id),
        lib.join("Saved Application State")
            .join(format!("{id}.savedState")),
    ];
    if let Some(dev) = &ctx.dev {
        candidates.push(lib.join("Caches").join(dev.product_name));
        candidates.push(lib.join("WebKit").join(dev.product_name));
    }
    candidates
}

/// データディレクトリ以外の候補 (Windows): `%LOCALAPPDATA%\<バンドルID>` (WebView2 のデータ `EBWebView`・ログ)。
/// 本番はデータディレクトリと同じ場所のため 1 つにまとまる。`MUKUCHI_DEV_DATA_DIR` で差し替えた開発では別に出る
#[cfg(windows)]
fn os_candidates(ctx: &UninstallContext) -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = local_data_dir(ctx).into_iter().collect();
    candidates.push(ctx.log_dir.to_path_buf());
    candidates
}

/// Windows: Tauri の app_local_data_dir (`%LOCALAPPDATA%\<バンドルID>`)。app_log_dir はその下の `logs`
/// (tauri の path の実装) のため、ログの親から求める。名前にバンドルIDを含む時だけ
#[cfg(windows)]
fn local_data_dir(ctx: &UninstallContext) -> Option<PathBuf> {
    let dir = ctx.log_dir.parent()?;
    let name = dir.file_name()?.to_str()?;
    (name.eq_ignore_ascii_case(ctx.bundle_id)).then(|| dir.to_path_buf())
}

/// 既に対象のものと同じか、その中か (Mac は同じものだけを除く。Windows はデータの下のログ等を二重に出さない)
#[cfg(not(windows))]
fn covered(files: &[PathBuf], c: &Path) -> bool {
    files.iter().any(|f| f == c)
}

#[cfg(windows)]
fn covered(files: &[PathBuf], c: &Path) -> bool {
    files.iter().any(|f| is_within(c, f))
}

#[cfg(not(windows))]
fn in_target(bundle: &Path, target: &Path) -> bool {
    bundle.starts_with(target)
}

#[cfg(windows)]
fn in_target(bundle: &Path, target: &Path) -> bool {
    is_within(bundle, target)
}

/// `defaults delete` で消す設定 (macOS のみ)
#[cfg(not(windows))]
fn preferences(ctx: &UninstallContext) -> Option<(String, PathBuf)> {
    let id = ctx.bundle_id;
    let plist = ctx
        .home
        .join("Library")
        .join("Preferences")
        .join(format!("{id}.plist"));
    plist.exists().then(|| (id.to_string(), plist))
}

#[cfg(windows)]
fn preferences(_ctx: &UninstallContext) -> Option<(String, PathBuf)> {
    None
}

#[cfg(not(windows))]
fn registry_entries() -> Vec<String> {
    Vec::new()
}

#[cfg(windows)]
fn registry_entries() -> Vec<String> {
    crate::autostart::registry_entries()
}

impl UninstallPlan {
    /// 確認ダイアログの一覧 (大きさ付き)
    pub fn targets(&self) -> Vec<UninstallTarget> {
        let mut all: Vec<&PathBuf> = self.files.iter().collect();
        if let Some((_, p)) = &self.preferences {
            all.push(p);
        }
        if let Some(b) = &self.app_bundle {
            all.push(b);
        }
        let mut targets: Vec<UninstallTarget> = all
            .into_iter()
            .map(|p| UninstallTarget {
                path: p.display().to_string(),
                bytes: disk_usage(std::slice::from_ref(p)),
            })
            .collect();
        targets.extend(self.registry.iter().map(|r| UninstallTarget {
            path: r.clone(),
            bytes: 0,
        }));
        targets
    }
}

/// 誤って無関係の場所を消さないための確認: 名前にバンドルID (開発はプロダクト名) を含み、
/// ホームの Library 配下かデータディレクトリであること
#[cfg(not(windows))]
pub fn check_safe_target(p: &Path, ctx: &UninstallContext) -> Result<()> {
    let name = p
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| anyhow!("名前のないパス: {}", p.display()))?;
    // 開発では MUKUCHI_DEV_DATA_DIR で差し替えたデータディレクトリ (名前にプロダクト名を含むもの) も許す
    let named = name.contains(ctx.bundle_id)
        || ctx.dev.as_ref().is_some_and(|d| {
            name == d.product_name || (p == ctx.data_dir && name.contains(d.product_name))
        });
    let located = p == ctx.data_dir || p == ctx.log_dir || p.starts_with(ctx.home.join("Library"));
    if !named || !located || p.components().count() < 4 {
        bail!("削除対象として不正: {}", p.display());
    }
    if p == ctx.data_dir {
        check_data_dir(p)?;
    }
    Ok(())
}

/// Windows: データディレクトリ (目印あり) か、`%LOCALAPPDATA%\<バンドルID>` (またはその中) であること。
/// 比較は大文字小文字・`\\?\`・8.3 の短い名前を正規化して行う。Windows のアプリ内のアンインストールは
/// ファイルを消さないため、ここは dry-run の表示での確認と、将来アプリ側で消す場合の安全策
#[cfg(windows)]
pub fn check_safe_target(p: &Path, ctx: &UninstallContext) -> Result<()> {
    let name = p
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| anyhow!("名前のないパス: {}", p.display()))?;
    let is_data = comparable(p) == comparable(ctx.data_dir);
    let lower = name.to_lowercase();
    let data_named = lower.contains(&ctx.bundle_id.to_lowercase())
        || ctx
            .dev
            .as_ref()
            .is_some_and(|d| lower.contains(&d.product_name.to_lowercase()));
    let in_local = local_data_dir(ctx).is_some_and(|l| is_within(p, &l));
    if !((is_data && data_named) || in_local) || comparable(p).components().count() < 4 {
        bail!("削除対象として不正: {}", p.display());
    }
    if is_data {
        check_data_dir(p)?;
    }
    Ok(())
}

/// 本番のアンインストールの前提: 実行中のアプリ本体が分かり、App Translocation
/// (ダウンロードしたアプリを移動せずに開いた時に、読み取り専用の一時的な場所から実行される) でないこと。
/// 満たさない場合は何も消さずにエラーにする (データだけ消えて本体が残るのを防ぐ)
#[cfg(not(windows))]
pub fn check_app_bundle(app_bundle: Option<&Path>, dev: bool) -> Result<()> {
    if dev {
        return Ok(());
    }
    let Some(b) = app_bundle else {
        bail!(crate::i18n::Msg::AppBundleUnknown);
    };
    if is_translocated(b) {
        bail!(crate::i18n::Msg::AppTranslocated);
    }
    Ok(())
}

/// Windows の本番のアンインストールの前提: NSIS で入れたもの (実行ファイルの隣に uninstall.exe がある) であること。
/// `target\release` から直接動かした等で無ければ何もせずエラー (設定 > アプリ から消してもらう)
#[cfg(windows)]
pub fn check_app_bundle(app_bundle: Option<&Path>, dev: bool) -> Result<()> {
    if dev {
        return Ok(());
    }
    match app_bundle {
        Some(dir) if dir.join(UNINSTALLER).is_file() => Ok(()),
        _ => bail!(crate::i18n::Msg::UninstallerMissing),
    }
}

/// App Translocation の実行場所か。`SecTranslocateIsTranslocatedURL` は公開ヘッダにない (SPI) ため、
/// 実行場所のパス (`/private/var/folders/.../AppTranslocation/<UUID>/d/<name>.app`) で判定する
#[cfg(not(windows))]
pub fn is_translocated(bundle: &Path) -> bool {
    bundle
        .components()
        .any(|c| c.as_os_str() == "AppTranslocation")
}

/// ファイル・ディレクトリを削除する (アプリ本体・設定・TCC は呼び出し側)。
/// `dry_run` なら消さずにログに出す
pub fn delete_files(plan: &UninstallPlan, ctx: &UninstallContext, dry_run: bool) -> Result<()> {
    for p in &plan.files {
        check_safe_target(p, ctx)?;
    }
    let mut errors = Vec::new();
    for p in &plan.files {
        if dry_run {
            log::info!("[dry-run] 削除: {}", p.display());
            continue;
        }
        if let Err(e) = remove_path(p) {
            log::error!("{e:#}");
            errors.push(p.display().to_string());
        }
    }
    if !errors.is_empty() {
        bail!("削除できないものがあります: {}", errors.join(", "));
    }
    Ok(())
}

/// 実行中のアプリ本体 (.app) のパス。未バンドルの実行では None
#[cfg(not(windows))]
pub fn current_app_bundle() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?.canonicalize().ok()?;
    // <name>.app/Contents/MacOS/<exe>
    let bundle = exe.parent()?.parent()?.parent()?;
    (bundle.extension().is_some_and(|e| e == "app")
        && exe.parent()?.file_name()? == "MacOS"
        && exe.parent()?.parent()?.file_name()? == "Contents")
        .then(|| bundle.to_path_buf())
}

/// NSIS のアンインストーラー。インストール先 (`$INSTDIR`、currentUser の既定は `%LOCALAPPDATA%\<productName>`) の
/// 直下に置かれる (Tauri の NSIS テンプレート installer.nsi の `WriteUninstaller "$INSTDIR\uninstall.exe"`)
#[cfg(windows)]
pub const UNINSTALLER: &str = "uninstall.exe";

/// アンインストーラーに渡す引数。`/P`: 確認のページを出さず進捗だけ出して自動で閉じる (アプリの確認ダイアログで
/// 同意済みのため。Tauri のテンプレートの passive)。`/MUKUCHI_PURGE`: データも消す印 (NSIS のフックが見る。
/// テンプレートの GetOptions は前方一致のため、既存の `/P` `/UPDATE` `/NS` `/R` `/ARGS` で始まらない名前にする)
#[cfg(windows)]
pub const UNINSTALLER_ARGS: &str = "/P /MUKUCHI_PURGE";

/// Windows: NSIS で入れたもの (実行ファイルの隣に uninstall.exe がある) ならインストール先のフォルダ。
/// `tauri dev`・`target\release` からの実行では None (アップデート・アンインストールの対象にしない)
#[cfg(windows)]
pub fn current_app_bundle() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = strip_verbatim(exe.parent()?);
    dir.join(UNINSTALLER).is_file().then_some(dir)
}

/// Windows: アンインストーラーを起動する (待たない)。作業ディレクトリはインストール先にしない
/// (どれかのプロセスの作業ディレクトリになっているフォルダは消せないため)
#[cfg(windows)]
pub fn launch_uninstaller(install_dir: &Path) -> Result<()> {
    crate::platform::shell_run(
        &install_dir.join(UNINSTALLER),
        UNINSTALLER_ARGS,
        &std::env::temp_dir(),
    )
}

/// このビルドの target ディレクトリ (build.rs が埋め込む)
pub fn build_target_dir() -> Option<PathBuf> {
    let s = env!("MUKUCHI_TARGET_DIR");
    (!s.is_empty()).then(|| PathBuf::from(s))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(p: &Path, bytes: usize) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, vec![1u8; bytes]).unwrap();
    }

    #[test]
    fn usage_counts_categories_and_hardlinks_once() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = DataPaths::new(tmp.path().join("data"));
        let logs = tmp.path().join("logs");
        touch(&paths.venv().join("lib/a.so"), 10_000);
        touch(&paths.cache().join("x"), 5_000);
        touch(&paths.models().join("hub/blobs/b"), 20_000);
        #[cfg(unix)]
        std::os::unix::fs::symlink("../blobs/b", paths.models().join("hub/link")).unwrap();
        std::fs::create_dir_all(paths.python()).unwrap();
        std::fs::hard_link(paths.cache().join("x"), paths.python().join("x")).unwrap();
        touch(&paths.settings(), 100);
        touch(&logs.join("mukuchi.log"), 3_000);
        let u = usage(&paths, &logs);
        // ブロック単位 (4KiB 以上) で数える。ハードリンクは1回だけ
        assert!(
            u.runtime_bytes >= 15_000 && u.runtime_bytes < 30_000,
            "{u:?}"
        );
        assert!(u.model_bytes >= 20_000 && u.model_bytes < 30_000, "{u:?}");
        assert!(u.other_bytes >= 3_100 && u.other_bytes < 20_000, "{u:?}");
        assert_eq!(
            usage(&DataPaths::new(tmp.path().join("none")), &logs).runtime_bytes,
            0
        );
    }

    #[test]
    fn delete_runtime_keeps_settings_and_logs() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = DataPaths::new(tmp.path().join("data"));
        for d in paths.runtime_dirs() {
            touch(&d.join("f"), 1);
        }
        touch(&paths.models().join("hub/x"), 1);
        touch(&paths.settings(), 1);
        touch(&paths.provisioned(), 1);
        // 目印がなければ消さない
        assert!(delete_runtime_and_model(&paths).is_err());
        assert!(paths.models().exists());
        paths.ensure_root().unwrap();
        delete_runtime_and_model(&paths).unwrap();
        for d in paths.runtime_dirs() {
            assert!(!d.exists());
        }
        assert!(!paths.models().exists());
        assert!(!paths.provisioned().exists());
        assert!(paths.settings().exists());
        // もう一度呼んでもよい
        delete_runtime_and_model(&paths).unwrap();
    }

    const ID: &str = "com.example.mukuchi.test";

    #[cfg(not(windows))]
    fn fake_home(home: &Path) {
        let lib = home.join("Library");
        touch(
            &lib.join("Application Support")
                .join(ID)
                .join("settings.json"),
            10,
        );
        touch(
            &lib.join("Application Support").join(ID).join(DATA_MARKER),
            0,
        );
        touch(&lib.join("Caches").join(ID).join("c"), 10);
        touch(&lib.join("Logs").join(ID).join("mukuchi.log"), 10);
        touch(&lib.join("WebKit").join(ID).join("w"), 10);
        touch(&lib.join("HTTPStorages").join(ID).join("h"), 10);
        touch(
            &lib.join("Saved Application State")
                .join(format!("{ID}.savedState"))
                .join("s"),
            10,
        );
        touch(&lib.join("Preferences").join(format!("{ID}.plist")), 10);
        touch(&lib.join("Caches").join("mukuchi").join("dev"), 10);
        // 無関係のもの
        touch(&lib.join("Caches").join("com.other.app").join("c"), 10);
        touch(&lib.join("Preferences").join("com.other.app.plist"), 10);
    }

    fn ctx<'a>(home: &'a Path, data: &'a Path, logs: &'a Path) -> UninstallContext<'a> {
        UninstallContext {
            home,
            bundle_id: ID,
            data_dir: data,
            log_dir: logs,
            app_bundle: None,
            dev: None,
        }
    }

    /// ~/Library の構成は macOS のもの (Windows のアンインストールの対象は Phase 4 で決める)
    #[test]
    #[cfg(target_os = "macos")]
    fn uninstall_targets_in_fake_home() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        fake_home(home);
        let lib = home.join("Library");
        let data = lib.join("Application Support").join(ID);
        let logs = lib.join("Logs").join(ID);
        let mut c = ctx(home, &data, &logs);
        c.app_bundle = Some(tmp.path().join("Applications/mukuchi.app"));
        let plan = uninstall_plan(&c);
        let names: Vec<String> = plan
            .files
            .iter()
            .map(|p| p.strip_prefix(&lib).unwrap().display().to_string())
            .collect();
        assert_eq!(
            names,
            vec![
                format!("Application Support/{ID}"),
                format!("Caches/{ID}"),
                format!("Logs/{ID}"),
                format!("WebKit/{ID}"),
                format!("HTTPStorages/{ID}"),
                format!("Saved Application State/{ID}.savedState"),
            ]
        );
        assert_eq!(
            plan.preferences,
            Some((
                ID.to_string(),
                lib.join("Preferences").join(format!("{ID}.plist"))
            ))
        );
        assert_eq!(plan.app_bundle, c.app_bundle);
        let targets = plan.targets();
        assert_eq!(targets.len(), 8);
        assert!(targets[0].bytes > 0);

        delete_files(&plan, &c, true).unwrap();
        assert!(data.exists(), "dry-run では消さない");
        delete_files(&plan, &c, false).unwrap();
        for p in &plan.files {
            assert!(!p.exists(), "{}", p.display());
        }
        assert!(lib.join("Caches/com.other.app/c").exists());
        assert!(lib.join("Preferences/com.other.app.plist").exists());
        // 開発用のプロダクト名のキャッシュは本番では対象外
        assert!(lib.join("Caches/mukuchi").exists());
    }

    /// ~/Library の構成 (macOS)。Windows は *_windows のテスト
    #[test]
    #[cfg(not(windows))]
    fn dev_scope_limits_app_bundle_and_adds_product_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        fake_home(home);
        let lib = home.join("Library");
        let data = lib.join("Application Support").join(ID);
        let logs = lib.join("Logs").join(ID);
        let target = tmp.path().join("target");
        let mut c = ctx(home, &data, &logs);
        c.dev = Some(DevScope {
            product_name: "mukuchi",
            target_dir: Some(&target),
        });
        c.app_bundle = Some(PathBuf::from("/Applications/mukuchi.app"));
        let plan = uninstall_plan(&c);
        assert_eq!(plan.app_bundle, None, "target 外の本体は対象にしない");
        assert!(plan.files.contains(&lib.join("Caches/mukuchi")));
        c.app_bundle = Some(target.join("debug/bundle/macos/mukuchi.app"));
        assert_eq!(uninstall_plan(&c).app_bundle, c.app_bundle);
        c.dev.as_mut().unwrap().target_dir = None;
        assert_eq!(uninstall_plan(&c).app_bundle, None);
    }

    /// ~/Library の構成 (macOS)。Windows は *_windows のテスト
    #[test]
    #[cfg(not(windows))]
    fn unsafe_targets_are_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let data = home.join("Library/Application Support").join(ID);
        let logs = home.join("Library/Logs").join(ID);
        let c = ctx(home, &data, &logs);
        assert!(check_safe_target(&home.join("Library"), &c).is_err());
        assert!(check_safe_target(&home.join("Library/Caches/com.other"), &c).is_err());
        assert!(check_safe_target(Path::new("/"), &c).is_err());
        assert!(check_safe_target(&PathBuf::from(format!("/tmp/{ID}")), &c).is_err());
        assert!(check_safe_target(&home.join("Library/Caches").join(ID), &c).is_ok());
        std::fs::create_dir_all(&data).unwrap();
        assert!(check_safe_target(&data, &c).is_err(), "目印がない");
        touch(&data.join(DATA_MARKER), 0);
        assert!(check_safe_target(&data, &c).is_ok());
        std::fs::create_dir_all(data.join(".git")).unwrap();
        assert!(check_safe_target(&data, &c).is_err(), "リポジトリ");
        let plan = UninstallPlan {
            files: vec![home.join("Library")],
            preferences: None,
            app_bundle: None,
            registry: vec![],
        };
        std::fs::create_dir_all(home.join("Library")).unwrap();
        assert!(delete_files(&plan, &c, false).is_err());
        assert!(home.join("Library").exists());
    }

    /// ~/Library の構成 (macOS)。Windows は *_windows のテスト
    #[test]
    #[cfg(not(windows))]
    fn data_dir_without_marker_is_not_planned() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        fake_home(home);
        let lib = home.join("Library");
        let data = lib.join("Application Support").join(ID);
        std::fs::remove_file(data.join(DATA_MARKER)).unwrap();
        let logs = lib.join("Logs").join(ID);
        let c = ctx(home, &data, &logs);
        let plan = uninstall_plan(&c);
        assert!(!plan.files.contains(&data));
        delete_files(&plan, &c, false).unwrap();
        assert!(data.join("settings.json").exists());
        // 計画に紛れ込んでも消さない
        let forced = UninstallPlan {
            files: vec![data.clone()],
            preferences: None,
            app_bundle: None,
            registry: vec![],
        };
        assert!(delete_files(&forced, &c, false).is_err());
        assert!(data.exists());
    }

    #[test]
    fn debug_build_requires_dev_bundle_id() {
        assert!(destructive_ops_allowed(false, "com.minimalcorp.mukuchi"));
        assert!(destructive_ops_allowed(true, "com.minimalcorp.mukuchi.dev"));
        assert!(!destructive_ops_allowed(true, "com.minimalcorp.mukuchi"));
        assert!(!destructive_ops_allowed(
            true,
            "com.minimalcorp.mukuchi.devx"
        ));
    }

    #[test]
    #[cfg(not(windows))]
    fn release_uninstall_needs_real_app_location() {
        assert!(check_app_bundle(None, true).is_ok());
        assert!(check_app_bundle(None, false).is_err());
        let t = Path::new("/private/var/folders/ab/x/T/AppTranslocation/1234-ABCD/d/mukuchi.app");
        assert!(is_translocated(t));
        let e = check_app_bundle(Some(t), false).unwrap_err();
        assert!(format!("{e}").contains("アプリケーション"), "{e}");
        assert!(check_app_bundle(Some(Path::new("/Applications/mukuchi.app")), false).is_ok());
    }
    /// Windows の構成: `%LOCALAPPDATA%\<ID>` (データ・WebView2・ログ) とインストール先
    #[cfg(windows)]
    fn fake_local(local: &Path) -> (PathBuf, PathBuf, PathBuf) {
        let data = local.join(ID);
        touch(&data.join(DATA_MARKER), 0);
        touch(&data.join("settings.json"), 10);
        touch(&data.join("models").join("hub").join("m"), 1000);
        touch(&data.join("EBWebView").join("w"), 10);
        touch(&data.join("logs").join("mukuchi.log"), 10);
        let install = local.join("mukuchi");
        touch(&install.join("mukuchi.exe"), 10);
        touch(&install.join(UNINSTALLER), 10);
        touch(&install.join("llama-server").join("llama-server.exe"), 10);
        // 無関係のもの
        touch(&local.join("com.other.app").join("x"), 10);
        (data.clone(), data.join("logs"), install)
    }

    #[test]
    #[cfg(windows)]
    fn uninstall_targets_windows() {
        let tmp = tempfile::tempdir().unwrap();
        let local = tmp.path().join("AppData").join("Local");
        let (data, logs, install) = fake_local(&local);
        let mut c = ctx(tmp.path(), &data, &logs);
        c.app_bundle = Some(install.clone());
        let plan = uninstall_plan(&c);
        // ログ・WebView2 のデータはデータディレクトリの中のため 1 つにまとめる
        assert_eq!(plan.files, vec![data.clone()]);
        assert_eq!(plan.preferences, None);
        assert_eq!(plan.app_bundle, Some(install.clone()));
        let paths: Vec<String> = plan
            .targets()
            .into_iter()
            .filter(|t| !t.path.starts_with("HKCU"))
            .map(|t| t.path)
            .collect();
        assert_eq!(
            paths,
            vec![data.display().to_string(), install.display().to_string()]
        );
        delete_files(&plan, &c, true).unwrap();
        assert!(data.join("EBWebView").exists(), "dry-run では消さない");
        delete_files(&plan, &c, false).unwrap();
        assert!(!data.exists());
        assert!(local.join("com.other.app").exists());
        assert!(install.exists(), "本体はアンインストーラーが消す");
    }

    #[test]
    #[cfg(windows)]
    fn dev_data_dir_override_adds_local_dir_windows() {
        let tmp = tempfile::tempdir().unwrap();
        let local = tmp.path().join("Local");
        let id_dir = local.join(ID);
        touch(&id_dir.join("EBWebView").join("w"), 10);
        touch(&id_dir.join("logs").join("mukuchi.log"), 10);
        let data = tmp.path().join("dev-mukuchi-data");
        touch(&data.join(DATA_MARKER), 0);
        let logs = id_dir.join("logs");
        let target = tmp.path().join("target");
        let mut c = ctx(tmp.path(), &data, &logs);
        c.dev = Some(DevScope {
            product_name: "mukuchi",
            target_dir: Some(&target),
        });
        // target の外の本体は対象にしない。大文字小文字が違っても target の中なら対象
        c.app_bundle = Some(tmp.path().join("installed"));
        let plan = uninstall_plan(&c);
        assert_eq!(plan.files, vec![data.clone(), id_dir.clone()]);
        assert_eq!(plan.app_bundle, None);
        c.app_bundle = Some(PathBuf::from(
            target.join("debug").display().to_string().to_uppercase(),
        ));
        assert!(uninstall_plan(&c).app_bundle.is_some());
        for p in &plan.files {
            check_safe_target(p, &c).unwrap();
        }
        check_safe_target(&logs, &c).unwrap();
    }

    #[test]
    #[cfg(windows)]
    fn unsafe_targets_are_refused_windows() {
        let tmp = tempfile::tempdir().unwrap();
        let local = tmp.path().join("AppData").join("Local");
        let (data, logs, install) = fake_local(&local);
        let c = ctx(tmp.path(), &data, &logs);
        let ok = |p: &Path| check_safe_target(p, &c).is_ok();
        assert!(ok(&data));
        assert!(ok(&data.join("EBWebView")));
        assert!(ok(&logs));
        // 表記の違い (大文字・`\\?\`) でも同じものとして扱う
        assert!(ok(&PathBuf::from(
            data.display().to_string().to_uppercase()
        )));
        assert!(ok(&data.canonicalize().unwrap()));
        assert!(!ok(&local));
        assert!(!ok(&local.join("com.other.app")));
        assert!(!ok(&install));
        assert!(!ok(tmp.path()));
        assert!(!ok(Path::new(r"C:\")));
        assert!(!ok(&PathBuf::from(format!(r"C:\{ID}"))));
        std::fs::remove_file(data.join(DATA_MARKER)).unwrap();
        assert!(!ok(&data), "目印がない");
        touch(&data.join(DATA_MARKER), 0);
        std::fs::create_dir_all(data.join(".git")).unwrap();
        assert!(!ok(&data), "リポジトリ");
        let plan = UninstallPlan {
            files: vec![local.clone()],
            preferences: None,
            app_bundle: None,
            registry: vec![],
        };
        assert!(delete_files(&plan, &c, false).is_err());
        assert!(local.exists());
    }

    #[test]
    #[cfg(windows)]
    fn release_uninstall_needs_uninstaller_windows() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(check_app_bundle(None, true).is_ok());
        let e = check_app_bundle(None, false).unwrap_err();
        assert_eq!(
            e.downcast_ref::<crate::i18n::Msg>(),
            Some(&crate::i18n::Msg::UninstallerMissing)
        );
        assert!(check_app_bundle(Some(tmp.path()), false).is_err());
        touch(&tmp.path().join(UNINSTALLER), 1);
        assert!(check_app_bundle(Some(tmp.path()), false).is_ok());
        assert_eq!(UNINSTALLER_ARGS, "/P /MUKUCHI_PURGE");
    }
}
