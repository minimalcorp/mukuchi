//! モデルの管理 (docs/architecture.md「モデルの管理」)。
//!
//! - 候補はアプリに固定 (`CATALOG`)。常に「取得済みのモデルが1つ選択されている」状態を保つ
//! - 取得はモデルごとに開始・一時停止・再開・中止でき、同時に取得するのは1つ。処理はセットアップの model と同じ (hf.rs)
//! - 選択は provisioned.json の `selectedModel`。ASR サーバーの起動し直しは呼び出し側 (core.rs) が行う

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;

use anyhow::{anyhow, bail, Context};
use serde::Serialize;
use tokio::sync::watch;

use super::hf::{self, Cache, Downloader, HfModel};
use super::{
    failed, lock, model_present, now_secs, Cancel, ModelRecord, Provisioned, RateMeter, StepError,
    EMIT_INTERVAL,
};
use crate::paths::DataPaths;

// ---- カタログ ---------------------------------------------------------------

pub struct CatalogEntry {
    pub id: &'static str,
    pub repo: &'static str,
    /// commit で固定する (同じ名前で中身が変わらないように)
    pub revision: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    /// 取得するファイル (hf.rs の ALLOW_SUFFIXES) の合計。固定した revision の tree API の値
    pub size_bytes: u64,
}

/// 既定・推奨。新規のセットアップで取得する
pub const DEFAULT_MODEL_ID: &str = "ja-8bit";

/// 根拠: spikes/asr-bench/MODEL_DECISION.md
pub const CATALOG: [CatalogEntry; 2] = [
    CatalogEntry {
        id: "ja-8bit",
        repo: "minimalcorp/Qwen3-ASR-1.7B-JA-MLX-8bit",
        revision: "698eff963b084561b12a045c95bc4a208898337f",
        name: "日本語 (8bit)",
        description: "元のモデルと同等の精度で、より速く、メモリの使用量が少ない (約3GB)",
        size_bytes: 2_185_804_096,
    },
    CatalogEntry {
        id: "ja-bf16",
        repo: "neosophie/Qwen3-ASR-1.7B-JA",
        revision: "987bda160f2dabfa6757550bcff7cdda2ba0648c",
        name: "日本語 (bf16)",
        description: "量子化していない元のモデル。容量とメモリの使用量 (約8.5GB) が大きい",
        size_bytes: 4_092_092_275,
    },
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelDef {
    pub id: String,
    pub hf: HfModel,
    pub name: String,
    pub description: String,
    pub size_bytes: u64,
}

impl ModelDef {
    fn from_entry(e: &CatalogEntry) -> Self {
        Self {
            id: e.id.into(),
            hf: HfModel::hub(e.repo, e.revision),
            name: e.name.into(),
            description: e.description.into(),
            size_bytes: e.size_bytes,
        }
    }
}

/// 候補の一覧。先頭が既定 (テストでは別の候補を渡す)
#[derive(Debug, Clone)]
pub struct Catalog {
    models: Vec<ModelDef>,
}

impl Catalog {
    pub fn distributed() -> Self {
        let mut models: Vec<ModelDef> = CATALOG.iter().map(ModelDef::from_entry).collect();
        // 既定を先頭に (表示順もカタログ順のため、定数でも先頭に置いている)
        models.sort_by_key(|m| m.id != DEFAULT_MODEL_ID);
        Self { models }
    }

    /// 先頭が既定。空であってはならない
    #[cfg(test)]
    pub fn new(models: Vec<ModelDef>) -> Self {
        assert!(!models.is_empty(), "カタログが空");
        Self { models }
    }

    pub fn default_model(&self) -> &ModelDef {
        &self.models[0]
    }

    pub fn get(&self, id: &str) -> Option<&ModelDef> {
        self.models.iter().find(|m| m.id == id)
    }

    pub fn iter(&self) -> impl Iterator<Item = &ModelDef> {
        self.models.iter()
    }
}

/// 取得済み: 現在の revision の記録があり、スナップショットの config.json がある
fn is_installed(rec: &Provisioned, paths: &DataPaths, m: &ModelDef) -> bool {
    rec.has_model(&m.hf.version()) && model_present(paths, &m.hf)
}

/// 選択を残してよい: そのリポジトリの記録 (revision は問わない) とディレクトリがある。
/// revision が変わった選択中のモデル (アプリの更新) はセットアップの自動やり直しで取り直す
fn is_usable(rec: &Provisioned, paths: &DataPaths, m: &ModelDef) -> bool {
    let prefix = format!("{}@", m.hf.repo);
    rec.models.keys().any(|k| k.starts_with(&prefix)) && m.hf.storage_dir(&paths.models()).is_dir()
}

/// 起動時に選択中のモデルを決める (docs/architecture.md「モデルの管理」の移行)。
/// 記録の選択が使えればそれ、無ければ既定、既定も無ければ記録のある他のモデル (カタログ順)、どれも無ければ既定
pub fn resolve_selection(catalog: &Catalog, rec: &Provisioned, paths: &DataPaths) -> String {
    let usable = |m: &ModelDef| is_usable(rec, paths, m);
    if let Some(m) = rec.selected_model.as_deref().and_then(|id| catalog.get(id)) {
        if usable(m) {
            return m.id.clone();
        }
    }
    let default = catalog.default_model();
    if usable(default) {
        return default.id.clone();
    }
    catalog
        .iter()
        .find(|m| usable(m))
        .unwrap_or(default)
        .id
        .clone()
}

// ---- 型 (docs/architecture.md「型」ModelInfo) --------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelState {
    NotDownloaded,
    Downloading,
    Paused,
    Error,
    Downloaded,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub size_bytes: u64,
    pub recommended: bool,
    pub selected: bool,
    pub state: ModelState,
    pub bytes_done: u64,
    pub eta_seconds: Option<u64>,
    pub error: Option<String>,
    pub disk_bytes: u64,
}

// ---- 本体 -------------------------------------------------------------------

/// 取得中・一時停止・失敗の進捗 (メモリ上のみ。起動し直した後は手元のファイルから目安を出す)
#[derive(Debug, Clone)]
struct Progress {
    state: ModelState,
    bytes_done: u64,
    /// 一覧の取得後に決まる (それまではカタログの値)
    total: u64,
    eta: Option<u64>,
    error: Option<String>,
}

struct Active {
    id: String,
    cancel: watch::Sender<bool>,
    finished: watch::Receiver<bool>,
}

impl Active {
    fn running(&self) -> bool {
        !*self.finished.borrow()
    }
}

#[derive(Default)]
struct Inner {
    active: Option<Active>,
    progress: HashMap<String, Progress>,
    /// 削除 (アンインストール・実行環境とモデルのみ削除) の実行中。この間は取得を始めない
    suspended: bool,
    /// ディレクトリを削除中のモデル (削除・中止)。削除はロックの外で行うため、この間は同じモデルの取得を始めない
    removing: HashSet<String>,
}

/// 削除中の印。落とすと外す (削除の失敗・panic でも残さない)
struct Removing<'a> {
    inner: &'a Mutex<Inner>,
    id: String,
}

impl Drop for Removing<'_> {
    fn drop(&mut self) {
        lock(self.inner).removing.remove(&self.id);
    }
}

type Emit = Arc<dyn Fn(&[ModelInfo]) + Send + Sync>;

pub struct ModelManager {
    paths: DataPaths,
    catalog: Catalog,
    http: reqwest::Client,
    selected: RwLock<String>,
    inner: Mutex<Inner>,
    rate: Mutex<RateMeter>,
    dirty: AtomicBool,
    emit: Emit,
}

/// 削除の実行中を表す。落とすと解除する
pub struct ModelsSuspended {
    owner: Arc<ModelManager>,
}

impl Drop for ModelsSuspended {
    fn drop(&mut self) {
        lock(&self.owner.inner).suspended = false;
    }
}

impl ModelManager {
    /// 選択中のモデルを決める (移行を含む)。導入の記録があれば決めた選択を書き込む
    pub fn new(
        paths: DataPaths,
        catalog: Catalog,
        emit: impl Fn(&[ModelInfo]) + Send + Sync + 'static,
    ) -> anyhow::Result<Arc<Self>> {
        let rec = Provisioned::load(&paths.provisioned());
        let selected = resolve_selection(&catalog, &rec, &paths);
        if rec.selected_model.as_deref() != Some(selected.as_str()) {
            log::info!(
                "選択中のモデルを決めた: {selected} (記録: {:?})",
                rec.selected_model
            );
        }
        let this = Arc::new(Self {
            http: hf::http_client()?,
            paths,
            catalog,
            selected: RwLock::new(selected),
            inner: Mutex::new(Inner::default()),
            rate: Mutex::new(RateMeter::default()),
            dirty: AtomicBool::new(false),
            emit: Arc::new(emit),
        });
        this.persist_selection();
        Ok(this)
    }

    pub fn selected_id(&self) -> String {
        self.selected
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    pub fn selected(&self) -> ModelDef {
        let id = self.selected_id();
        self.catalog
            .get(&id)
            .unwrap_or_else(|| self.catalog.default_model())
            .clone()
    }

    fn def(&self, id: &str) -> anyhow::Result<&ModelDef> {
        self.catalog
            .get(id)
            .ok_or_else(|| anyhow!("不明なモデルです"))
    }

    fn storage_dir(&self, m: &ModelDef) -> PathBuf {
        m.hf.storage_dir(&self.paths.models())
    }

    /// 導入の記録があれば選択を provisioned.json に書き込む (記録が無い新規の導入・削除の後は書かない)。
    /// 起動時と、セットアップの完了時に呼ぶ
    pub fn persist_selection(&self) {
        let path = self.paths.provisioned();
        if Provisioned::load(&path).is_empty() {
            return;
        }
        let id = self.selected_id();
        if let Err(e) = Provisioned::update(&path, |r| r.selected_model = Some(id)) {
            log::warn!("モデルの選択を保存できません: {e:#}");
        }
    }

    // ---- 一覧 ------------------------------------------------------------------

    pub fn list(&self) -> Vec<ModelInfo> {
        let rec = Provisioned::load(&self.paths.provisioned());
        let selected = self.selected_id();
        let inner = lock(&self.inner);
        let active = inner
            .active
            .as_ref()
            .filter(|a| a.running())
            .map(|a| a.id.clone());
        self.catalog
            .iter()
            .enumerate()
            .map(|(i, m)| {
                let storage = self.storage_dir(m);
                let progress = inner.progress.get(&m.id);
                let (state, bytes_done, eta_seconds, error) =
                    if active.as_deref() == Some(m.id.as_str()) {
                        let p = progress;
                        (
                            ModelState::Downloading,
                            p.map_or(0, |p| p.bytes_done),
                            p.and_then(|p| p.eta),
                            None,
                        )
                    } else if is_installed(&rec, &self.paths, m) {
                        (ModelState::Downloaded, m.size_bytes, None, None)
                    } else if let Some(p) = progress {
                        (p.state, p.bytes_done, None, p.error.clone())
                    } else if storage.is_dir() {
                        // 起動し直した後の途中のファイル (または古い revision)。進捗は手元のファイルからの目安
                        (
                            ModelState::Paused,
                            partial_bytes(&storage).min(m.size_bytes),
                            None,
                            None,
                        )
                    } else {
                        (ModelState::NotDownloaded, 0, None, None)
                    };
                ModelInfo {
                    id: m.id.clone(),
                    name: m.name.clone(),
                    description: m.description.clone(),
                    size_bytes: m.size_bytes,
                    recommended: i == 0,
                    selected: m.id == selected,
                    state,
                    bytes_done,
                    eta_seconds,
                    error,
                    disk_bytes: crate::storage::disk_usage(&[storage]),
                }
            })
            .collect()
    }

    pub fn emit_now(&self) {
        self.dirty.store(false, Ordering::SeqCst);
        let list = self.list();
        (self.emit)(&list);
    }

    // ---- 選択 ------------------------------------------------------------------

    /// 選べるモデル (取得済み) かを確かめて返す。選択は変えない (起動を確かめてから `select` する)
    pub fn selectable(&self, id: &str) -> anyhow::Result<ModelDef> {
        let m = self.def(id)?;
        if !is_installed(
            &Provisioned::load(&self.paths.provisioned()),
            &self.paths,
            m,
        ) {
            bail!("ダウンロードが済んでいないモデルは選べません");
        }
        Ok(m.clone())
    }

    /// 選択を切り替えて記録する (取得済みのみ)。ASR サーバーの起動し直しは呼び出し側が行う
    pub fn select(&self, id: &str) -> anyhow::Result<()> {
        let id = self.selectable(id)?.id;
        Provisioned::update(&self.paths.provisioned(), |r| {
            r.selected_model = Some(id.clone())
        })
        .context("モデルの選択を保存できません")?;
        *self.selected.write().unwrap_or_else(|p| p.into_inner()) = id;
        self.emit_now();
        Ok(())
    }

    // ---- 取得 ------------------------------------------------------------------

    /// 取得の開始・再開・再試行。取得済み・取得中なら何もしない。他のモデルが取得中ならエラー
    pub fn download(self: &Arc<Self>, id: &str) -> anyhow::Result<()> {
        let m = self.def(id)?.clone();
        {
            let mut inner = lock(&self.inner);
            if inner.suspended {
                bail!("削除を実行中です");
            }
            if inner.removing.contains(&m.id) {
                bail!("モデルを削除しています");
            }
            if let Some(a) = inner.active.as_ref().filter(|a| a.running()) {
                if a.id == m.id {
                    return Ok(());
                }
                bail!("他のモデルをダウンロード中です");
            }
            if is_installed(
                &Provisioned::load(&self.paths.provisioned()),
                &self.paths,
                &m,
            ) {
                return Ok(());
            }
            let (cancel_tx, cancel) = Cancel::pair();
            let (fin_tx, fin_rx) = watch::channel(false);
            inner.active = Some(Active {
                id: m.id.clone(),
                cancel: cancel_tx,
                finished: fin_rx,
            });
            let prev = inner.progress.get(&m.id).map_or_else(
                || partial_bytes(&self.storage_dir(&m)).min(m.size_bytes),
                |p| p.bytes_done,
            );
            inner.progress.insert(
                m.id.clone(),
                Progress {
                    state: ModelState::Downloading,
                    bytes_done: prev,
                    total: m.size_bytes,
                    eta: None,
                    error: None,
                },
            );
            lock(&self.rate).reset();
            let this = self.clone();
            tauri::async_runtime::spawn(async move {
                let ticker = {
                    let this = this.clone();
                    tauri::async_runtime::spawn(async move {
                        loop {
                            tokio::time::sleep(EMIT_INTERVAL).await;
                            this.tick();
                        }
                    })
                };
                log::info!("モデルの取得を開始: {}", m.id);
                let result = this.fetch(&m, &cancel).await;
                ticker.abort();
                this.finish(&m, result);
                let _ = fin_tx.send(true);
                this.emit_now();
            });
        }
        self.emit_now();
        Ok(())
    }

    async fn fetch(&self, m: &ModelDef, cancel: &Cancel) -> Result<(), StepError> {
        let files = hf::list_files(&self.http, &m.hf, cancel).await?;
        let total: u64 = files.iter().map(|f| f.size).sum();
        let cache = Cache::new(&m.hf, &self.paths.models());
        let on_disk = cache.bytes_on_disk(&files);
        self.set_progress(&m.id, |p| {
            p.total = total;
            p.bytes_done = on_disk;
        });
        let progress = |delta: i64| {
            self.set_progress(&m.id, |p| {
                p.bytes_done = p.bytes_done.saturating_add_signed(delta).min(p.total);
            });
        };
        Downloader {
            http: &self.http,
            model: &m.hf,
            cache: &cache,
            cancel,
            progress: &progress,
        }
        .download_all(&files)
        .await?;
        if !cache.snapshot_complete(&files) {
            return Err(failed(
                "モデルを保存できません",
                anyhow!("スナップショットが揃っていない"),
            ));
        }
        if let Err(e) = cache.prune_other_revisions(&files) {
            log::warn!("古い版のモデルを消せません: {e:#}");
        }
        let version = m.hf.version();
        Provisioned::update(&self.paths.provisioned(), |r| {
            r.models.insert(
                version,
                ModelRecord {
                    completed_at: now_secs(),
                },
            );
        })
        .map_err(|e| failed(super::SAVE_ERROR, e))?;
        Ok(())
    }

    fn set_progress(&self, id: &str, f: impl FnOnce(&mut Progress)) {
        if let Some(p) = lock(&self.inner).progress.get_mut(id) {
            f(p);
        }
        self.dirty.store(true, Ordering::SeqCst);
    }

    fn finish(&self, m: &ModelDef, result: Result<(), StepError>) {
        let mut inner = lock(&self.inner);
        match result {
            Ok(()) => {
                log::info!("モデルの取得が完了: {}", m.id);
                inner.progress.remove(&m.id);
            }
            Err(StepError::Paused) => {
                log::info!("モデルの取得を一時停止: {}", m.id);
                if let Some(p) = inner.progress.get_mut(&m.id) {
                    p.state = ModelState::Paused;
                    p.eta = None;
                }
            }
            Err(StepError::Failed { message, source }) => {
                log::error!("モデルの取得に失敗 ({}): {message}: {source:#}", m.id);
                if let Some(p) = inner.progress.get_mut(&m.id) {
                    p.state = ModelState::Error;
                    p.eta = None;
                    p.error = Some(message);
                }
            }
        }
    }

    /// 定期送信: 残り時間を見積もり、変化があれば送る
    fn tick(&self) {
        {
            let mut inner = lock(&self.inner);
            let Some(id) = inner
                .active
                .as_ref()
                .filter(|a| a.running())
                .map(|a| a.id.clone())
            else {
                return;
            };
            if let Some(p) = inner.progress.get_mut(&id) {
                let mut r = lock(&self.rate);
                r.push(Instant::now(), p.bytes_done);
                let eta = r.eta(p.total.saturating_sub(p.bytes_done));
                if eta != p.eta {
                    p.eta = eta;
                    self.dirty.store(true, Ordering::SeqCst);
                }
            }
        }
        if self.dirty.load(Ordering::SeqCst) {
            self.emit_now();
        }
    }

    /// 取得中のものを止め、止まるまで待つ (`id` が None なら何でも)。止めたかを返す
    async fn stop_active(&self, id: Option<&str>) -> bool {
        let fin = {
            let inner = lock(&self.inner);
            let Some(a) = inner
                .active
                .as_ref()
                .filter(|a| a.running() && id.is_none_or(|id| a.id == id))
            else {
                return false;
            };
            let _ = a.cancel.send(true);
            a.finished.clone()
        };
        let mut fin = fin;
        crate::asr_process::until_true(&mut fin).await;
        true
    }

    /// 一時停止 (止まるまで待つ)。途中のファイルは残す。取得中でなければ何もしない
    pub async fn pause(&self, id: &str) -> anyhow::Result<()> {
        self.def(id)?;
        self.stop_active(Some(id)).await;
        Ok(())
    }

    /// 中止: 取得中なら止め、途中のファイルを消して未取得に戻す。取得済みならエラー
    pub async fn cancel(self: &Arc<Self>, id: &str) -> anyhow::Result<()> {
        let m = self.def(id)?.clone();
        if is_installed(
            &Provisioned::load(&self.paths.provisioned()),
            &self.paths,
            &m,
        ) {
            bail!("ダウンロード済みです");
        }
        if m.id == self.selected_id() {
            // セットアップの取得中のもの (セットアップ完了後に選択中が未取得になることはない)
            bail!("使用中のモデルは削除できません");
        }
        self.stop_active(Some(id)).await;
        // ディレクトリの削除は数GBになりうるため async ランタイムを塞がない
        let this = self.clone();
        let target = m.clone();
        tauri::async_runtime::spawn_blocking(move || this.remove(&target))
            .await
            .map_err(|e| anyhow!("削除処理が異常終了しました: {e}"))??;
        log::info!("モデルの取得を中止: {}", m.id);
        Ok(())
    }

    /// 削除: 選択中・取得中はエラー。ディレクトリを消すため async ランタイムの外から呼ぶ
    pub fn delete(&self, id: &str) -> anyhow::Result<()> {
        let m = self.def(id)?.clone();
        if m.id == self.selected_id() {
            bail!("使用中のモデルは削除できません");
        }
        self.remove(&m)?;
        log::info!("モデルを削除: {}", m.id);
        Ok(())
    }

    /// 記録を先に消してから (途中で失敗しても取得済みのまま残らない) ディレクトリを消す
    /// ブロッキング (ディレクトリの削除) のため async ランタイムの外から呼ぶ
    fn remove(&self, m: &ModelDef) -> anyhow::Result<()> {
        let result = self.remove_files(m);
        self.emit_now();
        result
    }

    fn remove_files(&self, m: &ModelDef) -> anyhow::Result<()> {
        let cannot = |e: anyhow::Error| {
            log::error!("モデルを削除できません ({}): {e:#}", m.id);
            anyhow!("モデルを削除できません")
        };
        // 確認と記録の削除はロックの中で行い、取得の開始と重ねない。ディレクトリの削除は時間がかかるため
        // ロックの外で行い (他のモデルの進捗・一覧を止めない)、その間は `removing` で同じモデルの取得を拒む
        let _removing = {
            let mut inner = lock(&self.inner);
            if inner.suspended {
                bail!("削除を実行中です");
            }
            if inner.removing.contains(&m.id) {
                bail!("モデルを削除しています");
            }
            if inner
                .active
                .as_ref()
                .is_some_and(|a| a.running() && a.id == m.id)
            {
                bail!("ダウンロード中のモデルは削除できません。中止してください");
            }
            crate::storage::check_data_dir(self.paths.root()).map_err(cannot)?;
            let prefix = format!("{}@", m.hf.repo);
            Provisioned::update(&self.paths.provisioned(), |r| {
                r.models.retain(|k, _| !k.starts_with(&prefix));
            })
            .map_err(cannot)?;
            inner.progress.remove(&m.id);
            inner.removing.insert(m.id.clone());
            Removing {
                inner: &self.inner,
                id: m.id.clone(),
            }
        };
        let dir = self.storage_dir(m);
        match std::fs::remove_dir_all(&dir) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(cannot(anyhow!(e).context(dir.display().to_string()))),
        }
    }

    // ---- 削除 (アンインストール・実行環境とモデルのみ削除) ------------------------

    /// 削除の前に呼ぶ: 以後の取得を止め、取得中のものを止めて待つ。既に別の削除が実行中ならエラー
    pub async fn suspend(self: &Arc<Self>) -> anyhow::Result<ModelsSuspended> {
        {
            let mut inner = lock(&self.inner);
            if inner.suspended {
                bail!("削除を実行中です");
            }
            inner.suspended = true;
        }
        let guard = ModelsSuspended {
            owner: self.clone(),
        };
        self.stop_active(None).await;
        Ok(guard)
    }

    /// 全モデルを消した後: 進捗を捨て、選択を既定に戻す (記録ごと消えているため書き込まない)
    pub fn reset(&self) {
        lock(&self.inner).progress.clear();
        *self.selected.write().unwrap_or_else(|p| p.into_inner()) =
            self.catalog.default_model().id.clone();
        self.emit_now();
    }

    /// アプリの終了時: 取得中のものを止め、最大 `timeout` 待つ (async ランタイムの外から呼ぶ)
    pub fn shutdown_blocking(&self, timeout: std::time::Duration) {
        let fin = {
            let inner = lock(&self.inner);
            let Some(a) = inner.active.as_ref().filter(|a| a.running()) else {
                return;
            };
            let _ = a.cancel.send(true);
            a.finished.clone()
        };
        let deadline = Instant::now() + timeout;
        while !*fin.borrow() && Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }
}

/// blobs/ のファイルの大きさの合計 (取得途中を含む)。起動し直した後の進捗の目安
fn partial_bytes(storage: &std::path::Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(storage.join("blobs")) else {
        return 0;
    };
    entries
        .flatten()
        .filter_map(|e| e.metadata().ok())
        .filter(|m| m.is_file())
        .map(|m| m.len())
        .sum()
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::super::test_server::{Behavior, File, MockHf, Repo, REPO, REVISION};
    use super::*;

    const B_REPO: &str = "org/b";
    const B_REV: &str = "3333333333333333333333333333333333333333";

    fn content(n: usize, seed: u8) -> Vec<u8> {
        (0..n)
            .map(|i| (i as u8).wrapping_mul(17).wrapping_add(seed))
            .collect()
    }

    fn files(seed: u8, big: usize) -> Vec<File> {
        vec![
            File {
                path: "config.json".into(),
                content: format!("{{\"m\":{seed}}}").into_bytes(),
                lfs: false,
            },
            File {
                path: "weights.safetensors".into(),
                content: content(big, seed),
                lfs: true,
            },
        ]
    }

    fn size(files: &[File]) -> u64 {
        files.iter().map(|f| f.content.len() as u64).sum()
    }

    struct Fx {
        _tmp: tempfile::TempDir,
        paths: DataPaths,
        server: MockHf,
        catalog: Catalog,
        events: Arc<Mutex<Vec<Vec<ModelInfo>>>>,
    }

    impl Fx {
        fn new() -> Self {
            let tmp = tempfile::tempdir().unwrap();
            let paths = DataPaths::new(tmp.path().join("data"));
            paths.ensure_root().unwrap();
            let a = files(1, 40_000);
            let b = files(2, 30_000);
            let (sa, sb) = (size(&a), size(&b));
            let server = MockHf::start(a);
            server.state().other_repos.push(Repo {
                repo: B_REPO.into(),
                revision: B_REV.into(),
                files: b,
            });
            let def = |id: &str, repo: &str, rev: &str, size_bytes| ModelDef {
                id: id.into(),
                hf: HfModel {
                    endpoint: server.endpoint.clone(),
                    repo: repo.into(),
                    revision: rev.into(),
                },
                name: format!("名前 {id}"),
                description: String::new(),
                size_bytes,
            };
            let catalog = Catalog::new(vec![
                def("a", REPO, REVISION, sa),
                def("b", B_REPO, B_REV, sb),
            ]);
            Self {
                _tmp: tmp,
                paths,
                server,
                catalog,
                events: Arc::new(Mutex::new(Vec::new())),
            }
        }

        fn manager(&self) -> Arc<ModelManager> {
            let ev = self.events.clone();
            ModelManager::new(self.paths.clone(), self.catalog.clone(), move |l| {
                ev.lock().unwrap().push(l.to_vec())
            })
            .unwrap()
        }

        fn def(&self, id: &str) -> &ModelDef {
            self.catalog.get(id).unwrap()
        }

        fn rec(&self) -> Provisioned {
            Provisioned::load(&self.paths.provisioned())
        }

        /// セットアップで取得した時と同じ状態にする (記録とファイル)
        fn install(&self, id: &str) {
            let m = self.manager();
            // 選択中は download で取れないため、選択の外にあるものとして取る
            let d = self.def(id).clone();
            block_on(async {
                let (_tx, never) = Cancel::pair();
                m.fetch(&d, &never).await.unwrap();
            });
        }
    }

    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        tauri::async_runtime::block_on(f)
    }

    fn info(m: &ModelManager, id: &str) -> ModelInfo {
        m.list().into_iter().find(|i| i.id == id).unwrap()
    }

    fn wait_idle(m: &ModelManager) -> Vec<ModelInfo> {
        block_on(async {
            for _ in 0..1000 {
                let idle = lock(&m.inner).active.as_ref().is_none_or(|a| !a.running());
                if idle {
                    return m.list();
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            panic!("終わらない: {:?}", m.list());
        })
    }

    fn wait_bytes(m: &ModelManager, id: &str, at_least: u64) {
        block_on(async {
            for _ in 0..1000 {
                if info(m, id).bytes_done >= at_least {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            panic!("進まない: {:?}", m.list());
        })
    }

    #[test]
    fn distributed_catalog_is_consistent() {
        let c = Catalog::distributed();
        assert_eq!(c.default_model().id, DEFAULT_MODEL_ID);
        let ids: Vec<&str> = c.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, vec!["ja-8bit", "ja-bf16"]);
        // リポジトリが重なると、削除・古い版の掃除が他のモデルのファイルを消すため
        let mut repos: Vec<&str> = c.iter().map(|m| m.hf.repo.as_str()).collect();
        repos.dedup();
        assert_eq!(repos.len(), 2);
        for m in c.iter() {
            assert_eq!(m.hf.revision.len(), 40, "{}: commit で固定する", m.id);
            assert!(m.hf.endpoint.starts_with("https://"));
        }
    }

    #[test]
    fn fresh_install_selects_default_without_writing() {
        let fx = Fx::new();
        let m = fx.manager();
        assert_eq!(m.selected_id(), "a");
        assert!(!fx.paths.provisioned().exists(), "記録が無ければ書かない");
        let l = m.list();
        assert_eq!(l.len(), 2);
        assert!(l[0].selected && l[0].recommended);
        assert!(!l[1].selected && !l[1].recommended);
        assert!(l
            .iter()
            .all(|i| i.state == ModelState::NotDownloaded && i.bytes_done == 0));
        assert_eq!(
            serde_json::to_value(&l[0]).unwrap(),
            serde_json::json!({
                "id": "a", "name": "名前 a", "description": "", "sizeBytes": l[0].size_bytes,
                "recommended": true, "selected": true, "state": "not_downloaded",
                "bytesDone": 0, "etaSeconds": null, "error": null, "diskBytes": 0
            })
        );
    }

    #[test]
    fn legacy_install_keeps_the_installed_model_selected() {
        let fx = Fx::new();
        // 旧形式で b だけ導入済み (選択の記録なし)
        fx.install("b");
        Provisioned::update(&fx.paths.provisioned(), |r| r.selected_model = None).unwrap();
        let m = fx.manager();
        assert_eq!(m.selected_id(), "b", "既定を自動では取得しない");
        assert_eq!(fx.rec().selected_model.as_deref(), Some("b"), "記録する");
        assert_eq!(info(&m, "b").state, ModelState::Downloaded);
        assert_eq!(info(&m, "a").state, ModelState::NotDownloaded);
    }

    #[test]
    fn resolve_selection_rules() {
        let fx = Fx::new();
        let sel = |rec: &Provisioned| resolve_selection(&fx.catalog, rec, &fx.paths);
        assert_eq!(sel(&Provisioned::default()), "a");
        fx.install("a");
        fx.install("b");
        let mut rec = fx.rec();
        rec.selected_model = None;
        assert_eq!(sel(&rec), "a", "両方あれば既定");
        rec.selected_model = Some("b".into());
        assert_eq!(sel(&rec), "b");
        rec.selected_model = Some("gone".into());
        assert_eq!(sel(&rec), "a", "カタログに無い id");
        // 選択中のディレクトリが消されていたら他の取得済みへ
        rec.selected_model = Some("b".into());
        std::fs::remove_dir_all(fx.def("b").hf.storage_dir(&fx.paths.models())).unwrap();
        assert_eq!(sel(&rec), "a");
        // 既定が無く b だけ (revision は問わない: アプリの更新で変わった選択中はセットアップが取り直す)
        let mut rec = Provisioned::default();
        rec.models.insert(
            format!("{B_REPO}@{}", "9".repeat(40)),
            ModelRecord { completed_at: 1 },
        );
        std::fs::create_dir_all(fx.def("b").hf.storage_dir(&fx.paths.models())).unwrap();
        std::fs::remove_dir_all(fx.def("a").hf.storage_dir(&fx.paths.models())).unwrap();
        assert_eq!(sel(&rec), "b");
    }

    #[test]
    fn download_select_and_delete() {
        let fx = Fx::new();
        fx.install("a");
        let m = fx.manager();
        assert_eq!(fx.rec().selected_model.as_deref(), Some("a"));

        // 未取得は選べない
        let e = m.select("b").unwrap_err();
        assert_eq!(
            e.to_string(),
            "ダウンロードが済んでいないモデルは選べません"
        );
        assert_eq!(m.select("zz").unwrap_err().to_string(), "不明なモデルです");

        m.download("b").unwrap();
        let l = wait_idle(&m);
        let b = l.iter().find(|i| i.id == "b").unwrap();
        assert_eq!(b.state, ModelState::Downloaded, "{l:?}");
        assert_eq!(b.bytes_done, b.size_bytes);
        assert!(b.disk_bytes > 0);
        assert!(!b.selected, "取得しても選択は変えない");
        assert!(fx.rec().has_model(&fx.def("b").hf.version()));
        // 状態の変化を送っている
        let states: Vec<ModelState> = fx
            .events
            .lock()
            .unwrap()
            .iter()
            .map(|l| l[1].state)
            .collect();
        assert!(states.contains(&ModelState::Downloading), "{states:?}");
        assert_eq!(states.last(), Some(&ModelState::Downloaded));
        // 取得済みなら何もしない
        let n = fx.server.state().requests.len();
        m.download("b").unwrap();
        wait_idle(&m);
        assert_eq!(fx.server.state().requests.len(), n);

        // 選択中は消せない
        assert_eq!(
            m.delete("a").unwrap_err().to_string(),
            "使用中のモデルは削除できません"
        );
        m.select("b").unwrap();
        assert_eq!(m.selected_id(), "b");
        assert_eq!(fx.rec().selected_model.as_deref(), Some("b"));
        assert!(info(&m, "b").selected && !info(&m, "a").selected);
        m.delete("a").unwrap();
        assert_eq!(info(&m, "a").state, ModelState::NotDownloaded);
        assert!(!fx.def("a").hf.storage_dir(&fx.paths.models()).exists());
        assert!(!fx.rec().has_model(&fx.def("a").hf.version()));
        // 取得済みのものは中止できない
        assert_eq!(
            block_on(m.cancel("b")).unwrap_err().to_string(),
            "ダウンロード済みです"
        );
    }

    #[test]
    fn pause_resume_and_one_at_a_time() {
        let fx = Fx::new();
        fx.install("a");
        let m = fx.manager();
        fx.server.state().throttle = Some(Duration::from_millis(20));
        m.download("b").unwrap();
        wait_bytes(&m, "b", 4096);
        // 同時に取るのは1つ
        assert_eq!(
            m.download("a").unwrap_err().to_string(),
            "他のモデルをダウンロード中です"
        );
        assert_eq!(
            m.delete("b").unwrap_err().to_string(),
            "ダウンロード中のモデルは削除できません。中止してください"
        );
        block_on(m.pause("b")).unwrap();
        let b = info(&m, "b");
        assert_eq!(b.state, ModelState::Paused);
        let at_pause = b.bytes_done;
        assert!(at_pause > 0 && at_pause < b.size_bytes, "{b:?}");
        assert_eq!(b.eta_seconds, None);

        // 起動し直しても途中のファイルから目安を出す
        let m2 = fx.manager();
        let b2 = info(&m2, "b");
        assert_eq!(b2.state, ModelState::Paused);
        assert!(b2.bytes_done > 0, "{b2:?}");
        drop(m2);

        // 一時停止中に他のモデルは取れる
        fx.server.state().throttle = None;
        m.download("a").unwrap();
        wait_idle(&m);
        m.download("b").unwrap();
        let l = wait_idle(&m);
        assert!(l.iter().all(|i| i.state == ModelState::Downloaded), "{l:?}");
        let resumed = fx
            .server
            .state()
            .requests
            .iter()
            .filter(|(p, r)| p == "weights.safetensors" && r.is_some())
            .count();
        assert!(resumed >= 1, "続きから取る");
    }

    #[test]
    fn download_is_refused_while_removing() {
        let fx = Fx::new();
        fx.install("a");
        let m = fx.manager();
        // ディレクトリの削除はロックの外で行う。その間に同じモデルの取得・削除を始めない
        lock(&m.inner).removing.insert("b".into());
        assert_eq!(
            m.download("b").unwrap_err().to_string(),
            "モデルを削除しています"
        );
        assert_eq!(
            m.delete("b").unwrap_err().to_string(),
            "モデルを削除しています"
        );
        lock(&m.inner).removing.clear();
        m.download("b").unwrap();
        wait_idle(&m);
        m.delete("b").unwrap();
        assert!(lock(&m.inner).removing.is_empty(), "削除を終えたら印を外す");
        assert_eq!(info(&m, "b").state, ModelState::NotDownloaded);
    }

    #[test]
    fn cancel_removes_partial_files() {
        let fx = Fx::new();
        fx.install("a");
        let m = fx.manager();
        fx.server.state().throttle = Some(Duration::from_millis(20));
        m.download("b").unwrap();
        wait_bytes(&m, "b", 2048);
        block_on(m.cancel("b")).unwrap();
        let b = info(&m, "b");
        assert_eq!(
            (b.state, b.bytes_done, b.disk_bytes),
            (ModelState::NotDownloaded, 0, 0)
        );
        assert!(!fx.def("b").hf.storage_dir(&fx.paths.models()).exists());
        assert_eq!(
            block_on(m.cancel("a")).unwrap_err().to_string(),
            "ダウンロード済みです"
        );
    }

    #[test]
    fn failure_is_reported_and_retry_resumes() {
        let fx = Fx::new();
        fx.install("a");
        let m = fx.manager();
        {
            let mut st = fx.server.state();
            // b の config.json → weights.safetensors の順。weights を途中で切り、再試行を使い切る
            st.script.push_back(Behavior::Cut(usize::MAX));
            st.script.push_back(Behavior::Cut(10_000));
            for _ in 0..3 {
                st.script.push_back(Behavior::Fail(503));
            }
        }
        m.download("b").unwrap();
        let l = wait_idle(&m);
        let b = l.iter().find(|i| i.id == "b").unwrap();
        assert_eq!(b.state, ModelState::Error, "{l:?}");
        assert!(b.error.as_deref().unwrap().contains("中断"), "{b:?}");
        assert!(b.bytes_done >= 10_000, "{b:?}");
        m.download("b").unwrap();
        let b = wait_idle(&m).into_iter().find(|i| i.id == "b").unwrap();
        assert_eq!((b.state, b.error), (ModelState::Downloaded, None));
    }

    #[test]
    fn new_revision_replaces_old_files() {
        let fx = Fx::new();
        fx.install("a");
        // b の古い revision を取得済み (アプリの更新前)
        let old_rev = "4444444444444444444444444444444444444444";
        fx.server.state().other_repos.push(Repo {
            repo: B_REPO.into(),
            revision: old_rev.into(),
            files: files(9, 5000),
        });
        let old = HfModel {
            revision: old_rev.into(),
            ..fx.def("b").hf.clone()
        };
        let old_def = ModelDef {
            hf: old.clone(),
            ..fx.def("b").clone()
        };
        let m = fx.manager();
        block_on(async {
            let (_tx, never) = Cancel::pair();
            m.fetch(&old_def, &never).await.unwrap();
        });
        // 現在の revision の記録は無いため取得済みではない (古いファイルがあるので paused)
        assert_eq!(info(&m, "b").state, ModelState::Paused);
        m.download("b").unwrap();
        wait_idle(&m);
        assert_eq!(info(&m, "b").state, ModelState::Downloaded);
        let storage = old.storage_dir(&fx.paths.models());
        let snaps: Vec<String> = std::fs::read_dir(storage.join("snapshots"))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(snaps, vec![B_REV.to_string()], "古い版は消す");
        assert!(!storage
            .join("trees")
            .join(format!("{old_rev}.json"))
            .exists());
        let blobs = std::fs::read_dir(storage.join("blobs")).unwrap().count();
        assert_eq!(blobs, 2, "今の版のファイルだけ");
        // 削除は全 revision の記録を消す
        m.delete("b").unwrap();
        let prefix = format!("{B_REPO}@");
        assert!(!fx.rec().models.keys().any(|k| k.starts_with(&prefix)));
    }

    #[test]
    fn suspend_stops_and_blocks_downloads() {
        let fx = Fx::new();
        fx.install("a");
        let m = fx.manager();
        fx.server.state().throttle = Some(Duration::from_millis(20));
        m.download("b").unwrap();
        wait_bytes(&m, "b", 2048);
        let guard = block_on(m.suspend()).unwrap();
        assert_eq!(
            info(&m, "b").state,
            ModelState::Paused,
            "取得中のものは止まる"
        );
        assert!(block_on(m.suspend()).is_err());
        assert_eq!(m.download("b").unwrap_err().to_string(), "削除を実行中です");
        assert_eq!(m.delete("b").unwrap_err().to_string(), "削除を実行中です");
        // 削除の後: 選択を既定に戻し、進捗を捨てる
        crate::storage::delete_runtime_and_model(&fx.paths).unwrap();
        m.reset();
        drop(guard);
        let l = m.list();
        assert_eq!(m.selected_id(), "a");
        assert!(
            l.iter().all(|i| i.state == ModelState::NotDownloaded),
            "{l:?}"
        );
        assert!(!fx.paths.provisioned().exists());
    }
}
