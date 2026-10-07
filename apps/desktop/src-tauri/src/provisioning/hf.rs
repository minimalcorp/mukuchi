//! モデルの取得 (Hugging Face)。
//!
//! huggingface_hub を使わず Rust が HTTP で直接取得する (進捗・一時停止・部分ファイルからの再開のため)。
//! 書き込み先は huggingface_hub のキャッシュと同じレイアウトにし、`HF_HOME` を向ければ
//! huggingface_hub / mlx-qwen3-asr がオフラインで読める (huggingface_hub 2.0 の file_download.py /
//! _snapshot_download.py で確認):
//!
//! ```text
//! <HF_HOME>/hub/models--<org>--<name>/
//!   blobs/<etag>                       ファイル本体。etag は LFS なら sha256、それ以外は git の blob id
//!   blobs/<etag>.incomplete            取得途中 (huggingface_hub と同じ名前)
//!   snapshots/<commit>/<path>          -> ../../blobs/<etag> (相対シンボリックリンク)
//!   refs/main                          commit (改行なし)
//! ```
//!
//! `trees/<commit>.json` (huggingface_hub 2.0 のファイル一覧のキャッシュ) も取得したファイルだけを載せて書く
//! (`Cache::write_tree`。revision に commit を指定したオフラインの snapshot_download が一覧を取りにネットワークへ出ないため)。
//! サーバーの起動ではスナップショットのディレクトリを直接 `--model` に渡すため、huggingface_hub の解決には依存しない。

use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, Context};
use serde::Deserialize;
use sha1::Digest;
use tokio::io::AsyncWriteExt;

use super::{failed, Cancel, StepError};
use crate::i18n::Msg;

pub const HF_ENDPOINT: &str = "https://huggingface.co";
// 取得するモデル (リポジトリと revision) は models.rs の CATALOG で固定する

/// 取得するファイル。mlx-qwen3-asr (load_models._resolve_path) の snapshot_download の allow_patterns と同じ。
/// fnmatch の `*` は `/` も含むため、末尾の一致で判定する
const ALLOW_SUFFIXES: [&str; 4] = [".json", ".safetensors", ".txt", ".model"];

/// 通信の一時的な失敗 (切断・タイムアウト) で、同じファイルを続きから取り直す回数
const RETRIES: u32 = 3;
/// 取り直すまでの待ち (1, 2, 4 倍)。テストでは短くする
const RETRY_BASE: Duration = if cfg!(test) {
    Duration::from_millis(10)
} else {
    Duration::from_secs(1)
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HfModel {
    pub endpoint: String,
    pub repo: String,
    pub revision: String,
}

impl HfModel {
    /// Hugging Face 本体から取るモデル
    pub fn hub(repo: &str, revision: &str) -> Self {
        Self {
            endpoint: HF_ENDPOINT.into(),
            repo: repo.into(),
            revision: revision.into(),
        }
    }

    /// provisioned.json に記録する版
    pub fn version(&self) -> String {
        format!("{}@{}", self.repo, self.revision)
    }

    /// `<HF_HOME>/hub/models--<org>--<name>` (huggingface_hub の repo_folder_name)
    pub fn storage_dir(&self, hf_home: &Path) -> PathBuf {
        hf_home
            .join("hub")
            .join(format!("models--{}", self.repo.replace('/', "--")))
    }

    /// ASR サーバーの `--model` に渡すスナップショットのディレクトリ
    pub fn snapshot_dir(&self, hf_home: &Path) -> PathBuf {
        self.storage_dir(hf_home)
            .join("snapshots")
            .join(&self.revision)
    }

    fn api_tree_url(&self) -> anyhow::Result<reqwest::Url> {
        let mut url = reqwest::Url::parse(&self.endpoint).context("endpoint が不正")?;
        url.path_segments_mut()
            .map_err(|_| anyhow!("endpoint が不正"))?
            .pop_if_empty()
            .extend(["api", "models"])
            .extend(self.repo.split('/'))
            .push("tree")
            .push(&self.revision);
        url.query_pairs_mut().append_pair("recursive", "true");
        Ok(url)
    }

    fn resolve_url(&self, path: &str) -> anyhow::Result<reqwest::Url> {
        let mut url = reqwest::Url::parse(&self.endpoint).context("endpoint が不正")?;
        url.path_segments_mut()
            .map_err(|_| anyhow!("endpoint が不正"))?
            .pop_if_empty()
            .extend(self.repo.split('/'))
            .push("resolve")
            .push(&self.revision)
            .extend(path.split('/'));
        Ok(url)
    }
}

/// ファイルの検証方法
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BlobHash {
    /// LFS: 内容の sha256
    Sha256(String),
    /// 通常のファイル: git の blob id (`sha1("blob <size>\0" + 内容)`)
    GitSha1(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteFile {
    /// リポジトリ内のパス
    pub path: String,
    pub size: u64,
    /// blobs/ でのファイル名 (huggingface_hub の etag と同じ)
    pub blob: String,
    pub hash: BlobHash,
    /// git の blob id (LFS ではポインタファイルのもの)。trees/<commit>.json に書く
    pub git_oid: String,
}

#[derive(Debug, Deserialize)]
struct TreeEntry {
    #[serde(rename = "type")]
    kind: String,
    oid: String,
    size: u64,
    path: String,
    lfs: Option<TreeLfs>,
}

#[derive(Debug, Deserialize)]
struct TreeLfs {
    oid: String,
    size: u64,
}

pub fn http_client() -> anyhow::Result<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(concat!("mukuchi/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(20))
        // 大きなファイルの全体には時間制限を設けず、無通信だけを検知する
        .read_timeout(Duration::from_secs(60))
        // 配布ビルドは https 以外 (リダイレクト先を含む) を拒む。開発ビルドはテスト用の http サーバーを使うため許す
        .https_only(!cfg!(debug_assertions) && !cfg!(test))
        .build()
        .context("HTTPクライアントを作成できません")
}

fn network_error(e: reqwest::Error) -> StepError {
    failed(Msg::FetchNetwork, e.without_url())
}

/// 固定した revision のファイル一覧を API から取得する (取得対象のみ)。
pub async fn list_files(
    http: &reqwest::Client,
    model: &HfModel,
    cancel: &Cancel,
) -> Result<Vec<RemoteFile>, StepError> {
    let mut url = Some(model.api_tree_url().map_err(|e| failed(MODEL_ERROR, e))?);
    let mut out = Vec::new();
    // 大きなリポジトリでは一覧がページ分割される (Link: <...>; rel="next")
    while let Some(u) = url.take() {
        let res = tokio::select! {
            r = http.get(u).send() => r.map_err(network_error)?,
            _ = cancel.cancelled() => return Err(StepError::Paused),
        };
        let status = res.status();
        if !status.is_success() {
            return Err(failed(
                Msg::FetchListHttp {
                    status: status.as_u16(),
                },
                anyhow!("tree API: {status}"),
            ));
        }
        url = next_link(res.headers());
        let entries: Vec<TreeEntry> = res.json().await.map_err(network_error)?;
        for e in entries {
            if let Some(f) = to_remote_file(e).map_err(|e| failed(MODEL_ERROR, e))? {
                out.push(f);
            }
        }
    }
    if !out.iter().any(|f| f.path == "config.json") {
        return Err(failed(MODEL_ERROR, anyhow!("config.json がない")));
    }
    Ok(out)
}

const MODEL_ERROR: Msg = Msg::ModelInfoInvalid;

fn to_remote_file(e: TreeEntry) -> anyhow::Result<Option<RemoteFile>> {
    if e.kind != "file" || !ALLOW_SUFFIXES.iter().any(|s| e.path.ends_with(s)) {
        return Ok(None);
    }
    // サーバーからのパス・名前をそのままファイルシステムに使うため検証する
    if !is_safe_relative(&e.path) {
        anyhow::bail!("不正なパス: {}", e.path);
    }
    let git_oid = e.oid.to_ascii_lowercase();
    let (blob, size, hash) = match e.lfs {
        Some(lfs) => (lfs.oid.clone(), lfs.size, BlobHash::Sha256(lfs.oid)),
        None => (e.oid.clone(), e.size, BlobHash::GitSha1(e.oid)),
    };
    let hex_len = match hash {
        BlobHash::Sha256(_) => 64,
        BlobHash::GitSha1(_) => 40,
    };
    let is_hex = |s: &str, len: usize| s.len() == len && s.bytes().all(|b| b.is_ascii_hexdigit());
    if !is_hex(&blob, hex_len) || !is_hex(&git_oid, 40) {
        anyhow::bail!("不正な blob id: {blob}");
    }
    Ok(Some(RemoteFile {
        path: e.path,
        size,
        blob: blob.to_ascii_lowercase(),
        hash,
        git_oid,
    }))
}

fn is_safe_relative(p: &str) -> bool {
    !p.is_empty()
        && !p.contains('\\')
        && Path::new(p)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
}

/// `Link: <https://...>; rel="next"` の URL
fn next_link(headers: &reqwest::header::HeaderMap) -> Option<reqwest::Url> {
    let link = headers.get(reqwest::header::LINK)?.to_str().ok()?;
    link.split(',').find_map(|part| {
        let (url, params) = part.split_once(';')?;
        params
            .split(';')
            .any(|p| p.trim() == "rel=\"next\"")
            .then(|| url.trim().trim_start_matches('<').trim_end_matches('>'))
            .and_then(|u| reqwest::Url::parse(u).ok())
    })
}

/// キャッシュのレイアウトへの書き込み
pub struct Cache<'a> {
    model: &'a HfModel,
    storage: PathBuf,
}

impl<'a> Cache<'a> {
    pub fn new(model: &'a HfModel, hf_home: &Path) -> Self {
        Self {
            model,
            storage: model.storage_dir(hf_home),
        }
    }

    fn blob_path(&self, f: &RemoteFile) -> PathBuf {
        self.storage.join("blobs").join(&f.blob)
    }

    fn incomplete_path(&self, f: &RemoteFile) -> PathBuf {
        self.storage
            .join("blobs")
            .join(format!("{}.incomplete", f.blob))
    }

    fn snapshot_path(&self, f: &RemoteFile) -> PathBuf {
        self.storage
            .join("snapshots")
            .join(&self.model.revision)
            .join(&f.path)
    }

    /// 取得済みのバイト数 (完了した blob と途中のファイル)。再開時の進捗の初期値
    pub fn bytes_on_disk(&self, files: &[RemoteFile]) -> u64 {
        files
            .iter()
            .map(|f| {
                if self.is_complete(f) {
                    f.size
                } else {
                    file_len(&self.incomplete_path(f)).min(f.size)
                }
            })
            .sum()
    }

    /// blob は検証を終えてから最終の名前にするため、名前と大きさが合えば取得済み
    fn is_complete(&self, f: &RemoteFile) -> bool {
        std::fs::metadata(self.blob_path(f)).is_ok_and(|m| m.is_file() && m.len() == f.size)
    }

    /// snapshots/<commit>/<path> -> ../../blobs/<etag> (huggingface_hub の _create_symlink と同じ相対リンク)
    pub fn link(&self, f: &RemoteFile) -> anyhow::Result<()> {
        let link = self.snapshot_path(f);
        let parent = link.parent().context("スナップショットのパスが不正")?;
        std::fs::create_dir_all(parent)
            .with_context(|| format!("作成できません: {}", parent.display()))?;
        // snapshots/<commit>/ からの深さ + 2 (snapshots/<commit>) だけ上がる
        let depth = Path::new(&f.path).components().count() - 1 + 2;
        let mut target = PathBuf::new();
        for _ in 0..depth {
            target.push("..");
        }
        target.push("blobs");
        target.push(&f.blob);
        if std::fs::symlink_metadata(&link).is_ok() {
            std::fs::remove_file(&link)
                .with_context(|| format!("削除できません: {}", link.display()))?;
        }
        std::os::unix::fs::symlink(&target, &link)
            .with_context(|| format!("リンクを作成できません: {}", link.display()))
    }

    /// refs/main に commit を書く。revision を省略した (main の) 読み込みでも同じスナップショットを使えるように
    pub fn write_ref(&self) -> anyhow::Result<()> {
        let refs = self.storage.join("refs");
        std::fs::create_dir_all(&refs)?;
        std::fs::write(refs.join("main"), &self.model.revision)?;
        Ok(())
    }

    /// trees/<commit>.json (huggingface_hub 2.0 のファイル一覧のキャッシュ, _tree_cache.py の format_version 1)。
    /// revision に commit を指定したオフラインの snapshot_download は、これがないと一覧を取りにネットワークへ出て
    /// 失敗する。取得したファイルだけを載せる (載せたのに無いファイルがあると不完全とみなされるため)
    pub fn write_tree(&self, files: &[RemoteFile]) -> anyhow::Result<()> {
        let mut map = serde_json::Map::new();
        for f in files {
            let mut info = serde_json::json!({ "size": f.size, "blob_id": f.git_oid });
            if let BlobHash::Sha256(sha) = &f.hash {
                info["lfs_sha256"] = sha.clone().into();
                info["lfs_size"] = f.size.into();
            }
            map.insert(f.path.clone(), info);
        }
        let data = serde_json::json!({ "format_version": 1, "files": map });
        let dir = self.storage.join("trees");
        std::fs::create_dir_all(&dir)?;
        let path = dir.join(format!("{}.json", self.model.revision));
        let tmp = dir.join(format!("{}.json.tmp", self.model.revision));
        std::fs::write(&tmp, serde_json::to_vec_pretty(&data)?)?;
        std::fs::rename(&tmp, &path)?;
        Ok(())
    }

    /// 同じリポジトリの他の revision のもの (snapshots/<他>・trees/<他>.json・今の revision から参照されない blobs)
    /// を消す。アプリの更新で revision が変わった時に古い版を残さないため。取得の完了後に呼ぶ
    pub fn prune_other_revisions(&self, files: &[RemoteFile]) -> anyhow::Result<()> {
        let keep_blobs: std::collections::HashSet<&str> =
            files.iter().map(|f| f.blob.as_str()).collect();
        let tree = format!("{}.json", self.model.revision);
        let targets = [
            (
                "snapshots",
                Box::new(|n: &str| n == self.model.revision) as Box<dyn Fn(&str) -> bool>,
            ),
            ("trees", Box::new(|n: &str| n == tree)),
            ("blobs", Box::new(|n: &str| keep_blobs.contains(n))),
        ];
        for (dir, keep) in targets {
            let dir = self.storage.join(dir);
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for e in entries.flatten() {
                if keep(&e.file_name().to_string_lossy()) {
                    continue;
                }
                let p = e.path();
                let r = if e.file_type().is_ok_and(|t| t.is_dir()) {
                    std::fs::remove_dir_all(&p)
                } else {
                    std::fs::remove_file(&p)
                };
                r.with_context(|| format!("削除できません: {}", p.display()))?;
            }
        }
        Ok(())
    }

    /// スナップショットが揃っているか (全ファイルのリンク先が取得済み)
    pub fn snapshot_complete(&self, files: &[RemoteFile]) -> bool {
        files
            .iter()
            .all(|f| std::fs::metadata(self.snapshot_path(f)).is_ok_and(|m| m.len() == f.size))
    }
}

fn file_len(p: &Path) -> u64 {
    std::fs::metadata(p).map(|m| m.len()).unwrap_or(0)
}

/// 取得。`progress` には増減したバイト数を渡す (最初からやり直す時は負)。
pub struct Downloader<'a> {
    pub http: &'a reqwest::Client,
    pub model: &'a HfModel,
    pub cache: &'a Cache<'a>,
    pub cancel: &'a Cancel,
    pub progress: &'a (dyn Fn(i64) + Send + Sync),
}

enum Attempt {
    Done,
    /// 通信の一時的な失敗。続きから取り直す
    Transient(anyhow::Error),
}

impl Downloader<'_> {
    pub async fn download_all(&self, files: &[RemoteFile]) -> Result<(), StepError> {
        for f in files {
            self.download(f).await?;
            self.cache.link(f).map_err(|e| failed(DISK_ERROR, e))?;
        }
        self.cache.write_ref().map_err(|e| failed(DISK_ERROR, e))?;
        self.cache
            .write_tree(files)
            .map_err(|e| failed(DISK_ERROR, e))?;
        Ok(())
    }

    async fn download(&self, f: &RemoteFile) -> Result<(), StepError> {
        if self.cache.is_complete(f) {
            return Ok(());
        }
        let incomplete = self.cache.incomplete_path(f);
        if let Some(dir) = incomplete.parent() {
            std::fs::create_dir_all(dir).map_err(|e| failed(DISK_ERROR, e))?;
        }
        let mut retries = 0;
        loop {
            match self.attempt(f, &incomplete).await? {
                Attempt::Done => break,
                Attempt::Transient(e) => {
                    retries += 1;
                    log::warn!("モデルの取得が中断 ({}, {retries}回目): {e:#}", f.path);
                    if retries > RETRIES {
                        return Err(failed(Msg::FetchInterrupted, e));
                    }
                    let wait = RETRY_BASE * (1 << (retries - 1));
                    tokio::select! {
                        _ = tokio::time::sleep(wait) => {}
                        _ = self.cancel.cancelled() => return Err(StepError::Paused),
                    }
                }
            }
        }
        self.verify(f, &incomplete).await?;
        std::fs::rename(&incomplete, self.cache.blob_path(f)).map_err(|e| failed(DISK_ERROR, e))?;
        Ok(())
    }

    async fn attempt(&self, f: &RemoteFile, incomplete: &Path) -> Result<Attempt, StepError> {
        let mut start = file_len(incomplete);
        if start > f.size {
            self.truncate(incomplete, start)?;
            start = 0;
        }
        if start == f.size {
            return Ok(Attempt::Done);
        }
        let url = self
            .model
            .resolve_url(&f.path)
            .map_err(|e| failed(MODEL_ERROR, e))?;
        let mut req = self.http.get(url);
        if start > 0 {
            req = req.header(reqwest::header::RANGE, format!("bytes={start}-"));
        }
        let res = tokio::select! {
            r = req.send() => match r {
                Ok(r) => r,
                Err(e) => return Ok(Attempt::Transient(e.without_url().into())),
            },
            _ = self.cancel.cancelled() => return Err(StepError::Paused),
        };
        let status = res.status();
        let append = match status.as_u16() {
            206 => {
                // 範囲が要求と合わない応答は書かずに取り直す (続きとしてつなぐと壊れるため)
                if content_range(res.headers()) != Some((start, f.size)) {
                    return Ok(Attempt::Transient(anyhow!(
                        "Content-Range が要求 (bytes={start}-/{}) と合わない: {:?}",
                        f.size,
                        res.headers().get(reqwest::header::CONTENT_RANGE)
                    )));
                }
                true
            }
            // 範囲指定を無視された (全体が返った): 最初から取り直す
            200 => false,
            416 => {
                // 手元の途中ファイルがサーバーの大きさ以上。壊れているとみなして最初から
                self.truncate(incomplete, start)?;
                return Ok(Attempt::Transient(anyhow!("416 Range Not Satisfiable")));
            }
            s if s == 429 || s >= 500 => {
                return Ok(Attempt::Transient(anyhow!("HTTP {status}")));
            }
            _ => {
                return Err(failed(
                    Msg::FetchHttp {
                        status: status.as_u16(),
                    },
                    anyhow!("{}: HTTP {status}", f.path),
                ))
            }
        };
        if !append && start > 0 {
            self.truncate(incomplete, start)?;
        }
        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(append)
            .write(true)
            .truncate(!append)
            .open(incomplete)
            .await
            .map_err(disk_error)?;
        let mut res = res;
        loop {
            let chunk = tokio::select! {
                c = res.chunk() => c,
                _ = self.cancel.cancelled() => {
                    // 書き込み済みの分は残す (再開時に続きから取る)
                    let _ = file.flush().await;
                    return Err(StepError::Paused);
                }
            };
            match chunk {
                Ok(Some(bytes)) => {
                    file.write_all(&bytes).await.map_err(disk_error)?;
                    (self.progress)(bytes.len() as i64);
                }
                Ok(None) => break,
                Err(e) => {
                    let _ = file.flush().await;
                    return Ok(Attempt::Transient(e.without_url().into()));
                }
            }
        }
        file.flush().await.map_err(disk_error)?;
        drop(file);
        let len = file_len(incomplete);
        if len != f.size {
            // 応答の途中で切れた (Content-Length より短い) 等。続きから取り直す
            return Ok(Attempt::Transient(anyhow!(
                "大きさが一致しない: {len} / {}",
                f.size
            )));
        }
        Ok(Attempt::Done)
    }

    fn truncate(&self, incomplete: &Path, had: u64) -> Result<(), StepError> {
        if let Err(e) = std::fs::remove_file(incomplete) {
            if e.kind() != std::io::ErrorKind::NotFound {
                return Err(failed(DISK_ERROR, e));
            }
        }
        (self.progress)(-(had as i64));
        Ok(())
    }

    async fn verify(&self, f: &RemoteFile, incomplete: &Path) -> Result<(), StepError> {
        let path = incomplete.to_path_buf();
        let hash = f.hash.clone();
        let size = f.size;
        let ok = tauri::async_runtime::spawn_blocking(move || hash_matches(&path, &hash, size))
            .await
            .map_err(|e| failed(DISK_ERROR, anyhow!("{e}")))?
            .map_err(|e| failed(DISK_ERROR, e))?;
        if !ok {
            // 壊れた部分から再開しても直らないため捨てる
            self.truncate(incomplete, f.size)?;
            return Err(failed(
                Msg::ModelCorrupted,
                anyhow!("{} のハッシュが一致しない", f.path),
            ));
        }
        Ok(())
    }
}

const DISK_ERROR: Msg = Msg::ModelSaveFailed;

fn disk_error(e: std::io::Error) -> StepError {
    if e.kind() == std::io::ErrorKind::StorageFull {
        failed(Msg::DiskFull, e)
    } else {
        failed(DISK_ERROR, e)
    }
}

/// `Content-Range: bytes <start>-<end>/<total>` の (start, total)。end は total - 1 であること
fn content_range(headers: &reqwest::header::HeaderMap) -> Option<(u64, u64)> {
    let v = headers.get(reqwest::header::CONTENT_RANGE)?.to_str().ok()?;
    let (range, total) = v.strip_prefix("bytes ")?.split_once('/')?;
    let (start, end) = range.split_once('-')?;
    let (start, end, total): (u64, u64, u64) = (
        start.trim().parse().ok()?,
        end.trim().parse().ok()?,
        total.trim().parse().ok()?,
    );
    (start <= end && end.checked_add(1)? == total).then_some((start, total))
}

pub fn hash_matches(path: &Path, hash: &BlobHash, size: u64) -> anyhow::Result<bool> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut buf = vec![0u8; 1 << 20];
    let mut feed = |h: &mut dyn FnMut(&[u8])| -> anyhow::Result<()> {
        loop {
            let n = file.read(&mut buf)?;
            if n == 0 {
                return Ok(());
            }
            h(&buf[..n]);
        }
    };
    let (actual, expected) = match hash {
        BlobHash::Sha256(expected) => {
            let mut h = sha2::Sha256::new();
            feed(&mut |b| h.update(b))?;
            (hex::encode(h.finalize()), expected)
        }
        BlobHash::GitSha1(expected) => {
            let mut h = sha1::Sha1::new();
            h.update(format!("blob {size}\0").as_bytes());
            feed(&mut |b| h.update(b))?;
            (hex::encode(h.finalize()), expected)
        }
    };
    Ok(actual.eq_ignore_ascii_case(expected))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model() -> HfModel {
        HfModel {
            endpoint: "http://127.0.0.1:1".into(),
            repo: "org/name".into(),
            revision: "0123456789abcdef0123456789abcdef01234567".into(),
        }
    }

    #[test]
    fn urls_are_encoded_per_segment() {
        let m = model();
        assert_eq!(
            m.api_tree_url().unwrap().as_str(),
            "http://127.0.0.1:1/api/models/org/name/tree/0123456789abcdef0123456789abcdef01234567?recursive=true"
        );
        assert_eq!(
            m.resolve_url("sub dir/a.json").unwrap().as_str(),
            "http://127.0.0.1:1/org/name/resolve/0123456789abcdef0123456789abcdef01234567/sub%20dir/a.json"
        );
    }

    #[test]
    fn tree_entries_are_filtered_and_validated() {
        let e = |path: &str, lfs: bool| TreeEntry {
            kind: "file".into(),
            oid: "a".repeat(40),
            size: 3,
            path: path.into(),
            lfs: lfs.then(|| TreeLfs {
                oid: "B".repeat(64),
                size: 9,
            }),
        };
        let f = to_remote_file(e("config.json", false)).unwrap().unwrap();
        assert_eq!(f.blob, "a".repeat(40));
        assert_eq!(f.hash, BlobHash::GitSha1("a".repeat(40)));
        let f = to_remote_file(e("model.safetensors", true))
            .unwrap()
            .unwrap();
        assert_eq!((f.blob.as_str(), f.size), ("b".repeat(64).as_str(), 9));
        assert!(to_remote_file(e("README.md", false)).unwrap().is_none());
        assert!(to_remote_file(e("../x.json", false)).is_err());
        assert!(to_remote_file(e("/abs.json", false)).is_err());
        assert!(to_remote_file(e("a/./b.json", false)).is_ok());
        let mut bad = e("c.json", false);
        bad.oid = "zz".into();
        assert!(to_remote_file(bad).is_err());
    }

    #[test]
    fn content_range_is_parsed_strictly() {
        let h = |v: &str| {
            let mut h = reqwest::header::HeaderMap::new();
            h.insert(reqwest::header::CONTENT_RANGE, v.parse().unwrap());
            content_range(&h)
        };
        assert_eq!(h("bytes 100-199/200"), Some((100, 200)));
        assert_eq!(h("bytes 100-150/200"), None, "途中までの範囲");
        assert_eq!(h("bytes 100-199/*"), None);
        assert_eq!(h("bytes */200"), None);
        assert_eq!(content_range(&reqwest::header::HeaderMap::new()), None);
    }

    #[test]
    fn link_header_next() {
        let mut h = reqwest::header::HeaderMap::new();
        h.insert(
            reqwest::header::LINK,
            "<https://huggingface.co/api/x?cursor=abc>; rel=\"next\""
                .parse()
                .unwrap(),
        );
        assert_eq!(
            next_link(&h).unwrap().as_str(),
            "https://huggingface.co/api/x?cursor=abc"
        );
        assert!(next_link(&reqwest::header::HeaderMap::new()).is_none());
    }

    #[test]
    fn cache_layout_matches_huggingface_hub() {
        let tmp = tempfile::tempdir().unwrap();
        let m = model();
        let cache = Cache::new(&m, tmp.path());
        let files = [
            RemoteFile {
                path: "config.json".into(),
                size: 2,
                blob: "a".repeat(40),
                hash: BlobHash::GitSha1("a".repeat(40)),
                git_oid: "a".repeat(40),
            },
            RemoteFile {
                path: "sub/w.safetensors".into(),
                size: 3,
                blob: "b".repeat(64),
                hash: BlobHash::Sha256("b".repeat(64)),
                git_oid: "c".repeat(40),
            },
        ];
        let storage = tmp.path().join("hub/models--org--name");
        std::fs::create_dir_all(storage.join("blobs")).unwrap();
        std::fs::write(storage.join("blobs").join("a".repeat(40)), b"{}").unwrap();
        std::fs::write(storage.join("blobs").join("b".repeat(64)), b"abc").unwrap();
        for f in &files {
            cache.link(f).unwrap();
        }
        // 張り直しても壊れない
        cache.link(&files[0]).unwrap();
        cache.write_ref().unwrap();
        cache.write_tree(&files).unwrap();
        let tree: serde_json::Value = serde_json::from_slice(
            &std::fs::read(storage.join("trees").join(format!("{}.json", m.revision))).unwrap(),
        )
        .unwrap();
        assert_eq!(
            tree,
            serde_json::json!({"format_version": 1, "files": {
                "config.json": {"size": 2, "blob_id": "a".repeat(40)},
                "sub/w.safetensors": {"size": 3, "blob_id": "c".repeat(40),
                    "lfs_sha256": "b".repeat(64), "lfs_size": 3},
            }})
        );

        let snap = storage.join("snapshots").join(&m.revision);
        assert_eq!(
            std::fs::read_link(snap.join("config.json")).unwrap(),
            PathBuf::from(format!("../../blobs/{}", "a".repeat(40)))
        );
        assert_eq!(
            std::fs::read_link(snap.join("sub/w.safetensors")).unwrap(),
            PathBuf::from(format!("../../../blobs/{}", "b".repeat(64)))
        );
        assert_eq!(
            std::fs::read(snap.join("sub/w.safetensors")).unwrap(),
            b"abc"
        );
        assert_eq!(
            std::fs::read_to_string(storage.join("refs/main")).unwrap(),
            m.revision
        );
        assert_eq!(m.snapshot_dir(tmp.path()), snap);
        assert!(cache.snapshot_complete(&files));
        assert_eq!(cache.bytes_on_disk(&files), 5);
    }

    #[test]
    fn hashes_follow_git_and_lfs() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("f");
        std::fs::write(&p, b"hello\n").unwrap();
        // `git hash-object` と同じ値
        assert!(hash_matches(
            &p,
            &BlobHash::GitSha1("ce013625030ba8dba906f756967f9e9ca394464a".into()),
            6
        )
        .unwrap());
        // `shasum -a 256`
        assert!(hash_matches(
            &p,
            &BlobHash::Sha256(
                "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03".into()
            ),
            6
        )
        .unwrap());
        assert!(!hash_matches(&p, &BlobHash::Sha256("00".repeat(32)), 6).unwrap());
    }
}
