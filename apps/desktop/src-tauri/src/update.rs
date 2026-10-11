//! 自動アップデート (docs/architecture.md「アップデート」)。
//!
//! `tauri-plugin-updater` を Rust からのみ使う。確認・取得・インストールは同時に1つ (`op`)。
//! 状態の遷移は `Machine` (Tauri に依存しない) に分け、テストできるようにする。
//! 版の比較・署名の検証 (requireSignedVersion を含む) は updater に任せる。

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::i18n::Msg;

pub const EVENT_STATUS_CHANGED: &str = "update-status-changed";

/// 開発用: デバッグビルドでこの URL の latest.json を確認・取得する (インストールは常にしない。UI の確認用)
pub const ENV_DEV_UPDATE_ENDPOINT: &str = "MUKUCHI_DEV_UPDATE_ENDPOINT";

/// 起動からの最初の自動確認まで (起動直後の ASR の読み込み等と重ねない)
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(30);
/// 自動確認の間隔。前回の確認 (手動を含む) からの壁時計の経過で判定する
const CHECK_INTERVAL_SECS: u64 = 6 * 60 * 60;
/// 経過を見る間隔。tokio の時計はスリープ中に進まないため、壁時計の経過を短い間隔で見て追いつく
const TICK: Duration = Duration::from_secs(10 * 60);
/// 取得中の進捗の送信間隔 (約4Hz)
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);
/// latest.json の取得の時間制限
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// 取得が止まったとみなす無通信の時間。全体の時間制限は回線の遅さで失敗するため付けない
const READ_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdateState {
    Unavailable,
    Idle,
    Checking,
    Downloading,
    Ready,
    Installing,
    Error,
}

/// docs/architecture.md の `UpdateStatus`
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub state: UpdateState,
    pub current_version: String,
    pub latest_version: Option<String>,
    pub notes: Option<String>,
    pub bytes_done: u64,
    pub bytes_total: Option<u64>,
    pub checked_at: Option<u64>,
    /// 表示用 (送る時点の表示言語)
    pub error: Option<Msg>,
}

// ---- 実行場所の判定 -------------------------------------------------------------

/// このプロセスでアップデートを扱えるか
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Availability {
    /// 本番: 確認・取得・インストール
    Production,
    /// 開発 (MUKUCHI_DEV_UPDATE_ENDPOINT): 確認・取得のみ
    DevEndpoint(url::Url),
    /// 扱わない (表示用の理由)
    Unavailable(Msg),
}

impl Availability {
    /// `dev_endpoint` はデバッグビルドでのみ渡す。`bundle` は実行中の .app (正規化済み)
    pub fn resolve(debug: bool, dev_endpoint: Option<&str>, bundle: Option<&Path>) -> Self {
        if debug {
            return match dev_endpoint.filter(|s| !s.is_empty()) {
                Some(s) => match url::Url::parse(s) {
                    Ok(u) => Self::DevEndpoint(u),
                    Err(e) => {
                        log::warn!("{ENV_DEV_UPDATE_ENDPOINT} が不正: {e}");
                        Self::Unavailable(Msg::UpdateDevBuild)
                    }
                },
                None => Self::Unavailable(Msg::UpdateDevBuild),
            };
        }
        let Some(bundle) = bundle else {
            return Self::Unavailable(Msg::UpdateLocationUnknown);
        };
        if !installable_location(bundle) {
            return Self::Unavailable(Msg::UpdateMoveToApplications);
        }
        Self::Production
    }
}

/// .app を置き換えてよい場所か。App Translocation (移動せずに開いた) は読み取り専用の一時的な場所、
/// `/Volumes/` 配下は dmg から直接起動したもので、どちらも置き換えても次の起動に残らない
#[cfg(not(target_os = "windows"))]
pub fn installable_location(bundle: &Path) -> bool {
    !crate::storage::is_translocated(bundle) && !bundle.starts_with("/Volumes")
}

/// Windows: 場所では判定しない。`bundle` は NSIS で入れたインストール先 (storage::current_app_bundle が
/// uninstall.exe のある場所だけを返す) で、インストーラーが同じ場所 (レジストリに記録したインストール先) に入れ直す。
/// 書き込めない場所ならインストーラーがエラーを出す (アプリは終了した後のため、アプリには戻らない)
#[cfg(target_os = "windows")]
pub fn installable_location(_bundle: &Path) -> bool {
    true
}

/// 自動確認をする時期か。`last_attempt` は前回の確認の開始 (UNIX 秒、手動を含む)
pub fn auto_check_due(now: u64, last_attempt: Option<u64>, since_start: Duration) -> bool {
    match last_attempt {
        None => since_start >= FIRST_CHECK_DELAY,
        // 時計が戻された場合も確認する (戻った分だけ待たされないように)
        Some(t) => now < t || now - t >= CHECK_INTERVAL_SECS,
    }
}

/// `found` が `pending` より新しい版か (semver)。updater が返す版は semver として解釈済みだが、
/// 解釈できなければ取り直さない (取得済みを捨てて古い版にしないため)
fn is_newer(found: &str, pending: &str) -> bool {
    match (
        semver::Version::parse(found),
        semver::Version::parse(pending),
    ) {
        (Ok(f), Ok(p)) => f > p,
        _ => {
            log::warn!("アップデートの版を比較できません: {found} / {pending}");
            false
        }
    }
}

// ---- 状態の遷移 -----------------------------------------------------------------

/// 確認の結果、次にすること
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Next {
    /// 新しい版を取得する
    Download,
    /// 何もしない (最新・取得済みと同じ版)
    Nothing,
}

/// 取得済みのアップデート。`P` は本体 (updater の Update と中身)。テストでは任意の型
struct Pending<P> {
    version: String,
    notes: Option<String>,
    payload: P,
}

/// UpdateStatus の状態機械。`Unavailable` からは遷移しない
pub struct Machine<P> {
    status: UpdateStatus,
    pending: Option<Pending<P>>,
}

impl<P: Clone> Machine<P> {
    pub fn new(current_version: String, unavailable: Option<Msg>) -> Self {
        Self {
            status: UpdateStatus {
                state: if unavailable.is_some() {
                    UpdateState::Unavailable
                } else {
                    UpdateState::Idle
                },
                current_version,
                latest_version: None,
                notes: None,
                bytes_done: 0,
                bytes_total: None,
                checked_at: None,
                error: unavailable,
            },
            pending: None,
        }
    }

    pub fn status(&self) -> &UpdateStatus {
        &self.status
    }

    pub fn is_installing(&self) -> bool {
        self.status.state == UpdateState::Installing
    }

    pub fn is_unavailable(&self) -> bool {
        self.status.state == UpdateState::Unavailable
    }

    /// 取得済み (`ready`) の版
    pub fn ready_version(&self) -> Option<&str> {
        match (self.status.state, &self.pending) {
            (UpdateState::Ready, Some(p)) => Some(&p.version),
            _ => None,
        }
    }

    /// 取得済みの表示に戻す (確認・取り直しの失敗・同じ版)
    fn show_pending(&mut self) -> bool {
        let Some(p) = &self.pending else {
            return false;
        };
        self.status.state = UpdateState::Ready;
        self.status.latest_version = Some(p.version.clone());
        self.status.notes = p.notes.clone();
        self.status.error = None;
        true
    }

    /// 確認を始める。取得済みなら `ready` のまま裏で確認する (メニューの項目を消さないため)
    pub fn begin_check(&mut self) {
        if self.is_unavailable() || self.pending.is_some() {
            return;
        }
        self.status.state = UpdateState::Checking;
        self.status.error = None;
    }

    /// 新しい版が見つかった
    pub fn found(&mut self, version: String, notes: Option<String>, now: u64) -> Next {
        if self.is_unavailable() {
            return Next::Nothing;
        }
        self.status.checked_at = Some(now);
        if let Some(p) = &self.pending {
            // 取得済みより新しい時だけ取り直す。同じ・古い版 (公開の取り下げで Latest が戻った等) では
            // 取得済みを捨てない
            if !is_newer(&version, &p.version) {
                self.show_pending();
                return Next::Nothing;
            }
        }
        self.status.state = UpdateState::Downloading;
        self.status.latest_version = Some(version);
        self.status.notes = notes;
        self.status.bytes_done = 0;
        self.status.bytes_total = None;
        self.status.error = None;
        Next::Download
    }

    /// 最新だった
    pub fn up_to_date(&mut self, now: u64) {
        if self.is_unavailable() {
            return;
        }
        self.status.checked_at = Some(now);
        // 公開を取り下げた等で見えなくなっても、取得済みのもの (署名済みで今より新しい) は残す
        if !self.show_pending() {
            self.status.state = UpdateState::Idle;
            self.status.latest_version = None;
            self.status.notes = None;
        }
    }

    pub fn check_failed(&mut self, message: Msg) {
        if self.is_unavailable() || self.show_pending() {
            return;
        }
        self.status.state = UpdateState::Error;
        self.status.latest_version = None;
        self.status.notes = None;
        self.status.error = Some(message);
    }

    pub fn progress(&mut self, chunk: u64, total: Option<u64>) {
        if self.status.state == UpdateState::Downloading {
            self.status.bytes_done = self.status.bytes_done.saturating_add(chunk);
            self.status.bytes_total = total;
        }
    }

    pub fn downloaded(&mut self, payload: P) {
        if self.status.state != UpdateState::Downloading {
            return;
        }
        let Some(version) = self.status.latest_version.clone() else {
            return;
        };
        self.pending = Some(Pending {
            version,
            notes: self.status.notes.clone(),
            payload,
        });
        self.show_pending();
    }

    /// 取得に失敗した。前に取得済みのものがあればそれに戻す
    pub fn download_failed(&mut self, message: Msg) {
        if self.status.state != UpdateState::Downloading || self.show_pending() {
            return;
        }
        // latest_version は残す (どの版の取得に失敗したかを出す)
        self.status.state = UpdateState::Error;
        self.status.error = Some(message);
    }

    /// インストールを始める。`ready` でなければエラー
    pub fn begin_install(&mut self) -> Result<P> {
        let p = match (&self.status.state, &self.pending) {
            (UpdateState::Ready, Some(p)) => p.payload.clone(),
            _ => return Err(anyhow!(Msg::UpdateNotInstallable)),
        };
        self.status.state = UpdateState::Installing;
        self.status.error = None;
        Ok(p)
    }

    /// インストールの前に中止した (他の処理の実行中等)。取得済みに戻す
    pub fn install_aborted(&mut self) {
        if self.status.state == UpdateState::Installing {
            self.show_pending();
        }
    }

    /// インストールに失敗した。.app が途中まで置き換わっている可能性があるため、取得したものは捨てる
    /// (次の確認で取り直す)
    pub fn install_failed(&mut self, message: Msg) {
        self.pending = None;
        self.status.state = UpdateState::Error;
        self.status.error = Some(message);
    }
}

// ---- 本体 -----------------------------------------------------------------------

/// 取得済みの本体。updater の Update と検証済みの中身 (約40MB。メモリに持ち、終了で捨てる。Windows は NSIS のインストーラー)
#[derive(Clone)]
struct Payload {
    update: Update,
    bytes: Arc<Vec<u8>>,
}

struct Inner {
    machine: Machine<Payload>,
    /// 前回の確認の開始 (UNIX 秒)。自動確認の時期の判定に使う
    last_attempt: Option<u64>,
    last_progress_emit: Option<Instant>,
}

pub struct UpdateManager {
    app: AppHandle,
    availability: Availability,
    inner: Mutex<Inner>,
    /// 確認・取得・インストールを同時に1つにする
    op: Arc<tokio::sync::Mutex<()>>,
    /// 自動確認の条件 (設定・セットアップ完了) が変わった時に見直させる
    wake: tokio::sync::Notify,
    /// Windows: install の中で終了前の後始末 (ASR の停止) を済ませたか。その後に install が失敗したら
    /// アプリは止めたままのため起動し直す
    #[cfg(target_os = "windows")]
    exiting: Arc<std::sync::atomic::AtomicBool>,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

impl UpdateManager {
    pub fn new(app: AppHandle) -> Arc<Self> {
        let dev_endpoint = if cfg!(debug_assertions) {
            std::env::var(ENV_DEV_UPDATE_ENDPOINT).ok()
        } else {
            None
        };
        let availability = Availability::resolve(
            cfg!(debug_assertions),
            dev_endpoint.as_deref(),
            crate::storage::current_app_bundle().as_deref(),
        );
        match &availability {
            Availability::Production => log::info!("アップデート: 有効"),
            Availability::DevEndpoint(u) => {
                log::info!("アップデート: 開発用の確認先 {u} (インストールはしない)")
            }
            Availability::Unavailable(reason) => log::info!("アップデート: 無効 ({reason})"),
        }
        let unavailable = match &availability {
            Availability::Unavailable(r) => Some(r.clone()),
            _ => None,
        };
        let version = app.package_info().version.to_string();
        Arc::new(Self {
            app,
            availability,
            inner: Mutex::new(Inner {
                machine: Machine::new(version, unavailable),
                last_attempt: None,
                last_progress_emit: None,
            }),
            op: Arc::new(tokio::sync::Mutex::new(())),
            wake: tokio::sync::Notify::new(),
            #[cfg(target_os = "windows")]
            exiting: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn status(&self) -> UpdateStatus {
        self.lock().machine.status().clone()
    }

    /// インストール中 (置き換え・再起動待ち)。セットアップ・モデルの取得等を始めさせない判定に使う
    pub fn is_installing(&self) -> bool {
        self.lock().machine.is_installing()
    }

    /// メニューに「再起動してアップデート」を出す版
    pub fn ready_version(&self) -> Option<String> {
        self.lock().machine.ready_version().map(str::to_string)
    }

    /// 状態を変えて送る。取得済みの版が変わればメニューも作り直す
    fn update(&self, f: impl FnOnce(&mut Machine<Payload>)) -> UpdateStatus {
        let (status, menu_changed) = {
            let mut inner = self.lock();
            let before = inner.machine.ready_version().map(str::to_string);
            f(&mut inner.machine);
            inner.last_progress_emit = None;
            let after = inner.machine.ready_version().map(str::to_string);
            (inner.machine.status().clone(), before != after)
        };
        let _ = self.app.emit(EVENT_STATUS_CHANGED, &status);
        if menu_changed {
            crate::tray::refresh_menu(&self.app);
        }
        status
    }

    /// 表示言語の変更時: 今の状態を送り直す (error は送る時点の表示言語で文字列になる)
    pub fn emit_status(&self) {
        let _ = self.app.emit(EVENT_STATUS_CHANGED, self.status());
    }

    /// 自動確認の条件が変わった (設定の autoCheckUpdates・セットアップの完了)
    pub fn wake(&self) {
        self.wake.notify_one();
    }

    /// 自動確認を始める。`enabled` は autoCheckUpdates かつセットアップ完了か
    pub fn spawn_scheduler(self: &Arc<Self>, enabled: impl Fn() -> bool + Send + Sync + 'static) {
        if self.availability_unavailable() {
            return;
        }
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            let started = Instant::now();
            tokio::time::sleep(FIRST_CHECK_DELAY).await;
            loop {
                let last = this.lock().last_attempt;
                if enabled() && auto_check_due(now_secs(), last, started.elapsed()) {
                    log::info!("アップデートを自動で確認する");
                    this.check().await;
                }
                tokio::select! {
                    _ = tokio::time::sleep(TICK) => {}
                    _ = this.wake.notified() => {}
                }
            }
        });
    }

    fn availability_unavailable(&self) -> bool {
        matches!(self.availability, Availability::Unavailable(_))
    }

    /// 確認する (手動・自動共通)。新しい版があれば取得を始め、確認が終わった時点の状態を返す。
    /// 確認・取得・インストール中なら何もせず今の状態を返す
    pub async fn check(self: &Arc<Self>) -> UpdateStatus {
        if self.availability_unavailable() {
            return self.status();
        }
        let Ok(guard) = self.op.clone().try_lock_owned() else {
            return self.status();
        };
        self.lock().last_attempt = Some(now_secs());
        self.update(|m| m.begin_check());
        let found = match self.build_updater() {
            Ok(u) => u.check().await.map_err(anyhow::Error::from),
            Err(e) => Err(e),
        };
        match found {
            Ok(Some(update)) => {
                log::info!("新しい版があります: {}", update.version);
                let mut next = Next::Nothing;
                let status = self.update(|m| {
                    next = m.found(update.version.clone(), update.body.clone(), now_secs())
                });
                if next == Next::Download {
                    let this = self.clone();
                    tauri::async_runtime::spawn(async move {
                        this.download(update).await;
                        drop(guard);
                    });
                }
                status
            }
            Ok(None) => {
                log::info!("アップデートはありません");
                self.update(|m| m.up_to_date(now_secs()))
            }
            Err(e) => {
                log::warn!("アップデートを確認できません: {e:#}");
                self.update(|m| m.check_failed(Msg::UpdateCheckFailed))
            }
        }
    }

    fn build_updater(&self) -> Result<tauri_plugin_updater::Updater> {
        let mut b = self
            .app
            .updater_builder()
            .timeout(CHECK_TIMEOUT)
            .configure_client(|c| {
                c.connect_timeout(CONNECT_TIMEOUT)
                    .read_timeout(READ_TIMEOUT)
            });
        if let Availability::DevEndpoint(url) = &self.availability {
            b = b
                .endpoints(vec![url.clone()])
                .context("開発用の確認先を設定できません")?;
        }
        // Windows の install はインストーラーを起動して std::process::exit(0) で終わり、RunEvent::Exit を経ない
        // (tauri-plugin-updater 2.13 の updater.rs)。そのため lib.rs の終了時の後始末 (ASR = llama-server の停止) を
        // 直前のフックで行う。Job Object (KILL_ON_JOB_CLOSE) でもプロセスの終了で子は終わるが、インストーラーが
        // インストール先の llama-server を上書きする前に確実に止めておく。プラグイン既定のフック
        // (cleanup_before_exit: トレイ・ウィンドウの片付け) はこれで置き換わるため、ここでも呼ぶ
        #[cfg(target_os = "windows")]
        {
            let app = self.app.clone();
            let exiting = self.exiting.clone();
            b = b.on_before_exit(move || {
                exiting.store(true, std::sync::atomic::Ordering::SeqCst);
                if let Some(core) = tauri::Manager::try_state::<Arc<crate::core::Core>>(&app) {
                    core.shutdown();
                }
                log::info!("アップデートのインストーラーを起動して終了する");
                app.cleanup_before_exit();
            });
        }
        b.build().context("updater を作成できません")
    }

    /// 取得する (署名の検証は updater が行う)。`op` を持った呼び出し元から呼ぶ
    async fn download(self: &Arc<Self>, update: Update) {
        let this = self.clone();
        let result = update
            .download(
                move |chunk, total| this.on_progress(chunk as u64, total),
                || {},
            )
            .await;
        match result {
            Ok(bytes) => {
                log::info!(
                    "アップデートを取得しました: {} ({} bytes)",
                    update.version,
                    bytes.len()
                );
                let payload = Payload {
                    update,
                    bytes: Arc::new(bytes),
                };
                self.update(|m| m.downloaded(payload));
            }
            Err(e) => {
                log::warn!("アップデートを取得できません: {e}");
                self.update(|m| m.download_failed(Msg::UpdateDownloadFailed));
            }
        }
    }

    fn on_progress(&self, chunk: u64, total: Option<u64>) {
        let status = {
            let mut inner = self.lock();
            inner.machine.progress(chunk, total);
            let due = inner
                .last_progress_emit
                .is_none_or(|t| t.elapsed() >= PROGRESS_INTERVAL);
            if !due {
                return;
            }
            inner.last_progress_emit = Some(Instant::now());
            inner.machine.status().clone()
        };
        let _ = self.app.emit(EVENT_STATUS_CHANGED, &status);
    }

    /// インストールして再起動する。`prepare` (他の処理の確認・音声入力の OFF) が失敗したら取得済みに戻す。
    /// 成功したら `request_restart` を呼んで戻る (イベントループが RunEvent::Exit を経て起動し直す)
    pub async fn install<F, Fut>(self: &Arc<Self>, prepare: F) -> Result<()>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<()>>,
    {
        match &self.availability {
            Availability::Production => {}
            Availability::DevEndpoint(_) => return Err(anyhow!(Msg::UpdateDevNoInstall)),
            Availability::Unavailable(_) => return Err(anyhow!(Msg::UpdateNotInstallable)),
        }
        let _guard = match self.op.clone().try_lock_owned() {
            Ok(g) => g,
            // 取得済みのまま裏で確認している (数秒): 終わるのを待つ。新しい版が見つかればその取得も待ち、
            // 終わった時点で ready なら (取り直した版を) インストールする。std の Mutex は持たずに待つ
            Err(_) if self.ready_version().is_some() => self.op.clone().lock_owned().await,
            Err(_) => return Err(anyhow!(Msg::UpdateChecking)),
        };
        let mut payload = None;
        let mut begin = Ok(());
        self.update(|m| match m.begin_install() {
            Ok(p) => payload = Some(p),
            Err(e) => begin = Err(e),
        });
        begin?;
        let Some(payload) = payload else {
            return Err(anyhow!(Msg::UpdateNotInstallable));
        };
        if let Err(e) = prepare().await {
            self.update(|m| m.install_aborted());
            return Err(e);
        }
        log::info!("アップデートをインストールする: {}", payload.update.version);
        // .app の置き換え (書き込めなければ管理者の確認を AppleScript で出し、メインスレッドの完了を待つ) は
        // ブロッキングのため async ランタイムの外で行う。
        // Windows はインストーラー (passive: 進捗だけ出し、終わるとアプリを起動し直す `/P /R`) を起動して
        // このプロセスを終了するため、成功すると戻らない。再起動もインストーラーが行う
        let result = tauri::async_runtime::spawn_blocking(move || {
            payload.update.install(payload.bytes.as_slice())
        })
        .await;
        match result {
            Ok(Ok(())) => {
                log::info!("アップデートをインストールした。再起動する");
                // メインスレッド以外から request_restart を使う (restart はメインスレッドでは RunEvent::Exit を
                // 経ずに起動し直すため、single-instance のソケットが残り、新しいプロセスが2つ目とみなされて終わる:
                // plugins-workspace#1692)。ExitRequested の code は RESTART_EXIT_CODE で、prevent_exit されない
                self.app.request_restart();
                Ok(())
            }
            Ok(Err(e)) => {
                log::error!("アップデートをインストールできません: {e}");
                self.update(|m| m.install_failed(Msg::UpdateInstallFailed));
                // Windows: 終了前の後始末 (ASR の停止) の後にインストーラーを起動できなかった。止めたままにせず、
                // 今の版のまま起動し直す (取得したものは捨てたため、次の確認で取り直す)
                #[cfg(target_os = "windows")]
                if self
                    .exiting
                    .swap(false, std::sync::atomic::Ordering::SeqCst)
                {
                    log::warn!("後始末の後のため、今の版のまま起動し直す");
                    self.app.request_restart();
                }
                Err(anyhow!(Msg::UpdateInstallFailed))
            }
            Err(e) => {
                log::error!("アップデートのインストールが異常終了しました: {e}");
                self.update(|m| m.install_failed(Msg::UpdateInstallFailed));
                Err(anyhow!(Msg::UpdateInstallFailed))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn m() -> Machine<u32> {
        Machine::new("0.1.4".into(), None)
    }

    #[test]
    fn availability_per_build_and_location() {
        let apps = PathBuf::from("/Applications/mukuchi.app");
        assert_eq!(
            Availability::resolve(false, None, Some(&apps)),
            Availability::Production
        );
        // リリースビルドは開発用の確認先を渡されない (呼び出し側で無視する) が、渡されても場所で決まる
        assert_eq!(
            Availability::resolve(false, Some("http://x"), Some(&apps)),
            Availability::Production
        );
        let home = PathBuf::from("/Users/a/Applications/mukuchi.app");
        assert_eq!(
            Availability::resolve(false, None, Some(&home)),
            Availability::Production
        );
        // Windows は場所で判定しない (NSIS で入れたものかは storage::current_app_bundle が決める)
        #[cfg(not(target_os = "windows"))]
        for p in [
            "/private/var/folders/ab/x/T/AppTranslocation/1234-ABCD/d/mukuchi.app",
            "/Volumes/mukuchi/mukuchi.app",
        ] {
            assert_eq!(
                Availability::resolve(false, None, Some(Path::new(p))),
                Availability::Unavailable(Msg::UpdateMoveToApplications),
                "{p}"
            );
        }
        assert!(matches!(
            Availability::resolve(false, None, None),
            Availability::Unavailable(_)
        ));
        // 開発: 確認先がなければ無効、あれば (http も) 確認・取得のみ
        assert!(matches!(
            Availability::resolve(true, None, Some(&apps)),
            Availability::Unavailable(_)
        ));
        assert!(matches!(
            Availability::resolve(true, Some(""), None),
            Availability::Unavailable(_)
        ));
        assert!(matches!(
            Availability::resolve(true, Some("not a url"), None),
            Availability::Unavailable(_)
        ));
        assert_eq!(
            Availability::resolve(true, Some("http://127.0.0.1:8000/latest.json"), None),
            Availability::DevEndpoint(
                url::Url::parse("http://127.0.0.1:8000/latest.json").unwrap()
            )
        );
        // "/Volumes" という名前の前方一致だけで判定しない
        assert!(installable_location(Path::new("/VolumesX/mukuchi.app")));
        #[cfg(target_os = "windows")]
        {
            let installed = PathBuf::from(r"C:\Users\a\AppData\Local\mukuchi");
            assert_eq!(
                Availability::resolve(false, None, Some(&installed)),
                Availability::Production
            );
            assert!(installable_location(Path::new(
                "/Volumes/mukuchi/mukuchi.app"
            )));
        }
    }

    #[test]
    fn auto_check_timing() {
        let first = FIRST_CHECK_DELAY;
        assert!(!auto_check_due(1000, None, first - Duration::from_secs(1)));
        assert!(auto_check_due(1000, None, first));
        let t = 1_000_000;
        assert!(!auto_check_due(t + CHECK_INTERVAL_SECS - 1, Some(t), first));
        assert!(auto_check_due(t + CHECK_INTERVAL_SECS, Some(t), first));
        // スリープ明け (壁時計が大きく進んだ) にも追いつく
        assert!(auto_check_due(t + 10 * CHECK_INTERVAL_SECS, Some(t), first));
        // 時計が戻された
        assert!(auto_check_due(t - 10, Some(t), first));
    }

    #[test]
    fn unavailable_never_changes() {
        let mut m: Machine<u32> = Machine::new("0.1.4".into(), Some(Msg::UpdateDevBuild));
        assert_eq!(m.status().state, UpdateState::Unavailable);
        assert_eq!(m.status().error, Some(Msg::UpdateDevBuild));
        m.begin_check();
        assert_eq!(m.found("0.2.0".into(), None, 1), Next::Nothing);
        m.up_to_date(1);
        m.check_failed(Msg::UpdateCheckFailed);
        assert_eq!(m.status().state, UpdateState::Unavailable);
        assert!(m.begin_install().is_err());
    }

    #[test]
    fn check_download_ready_install() {
        let mut m = m();
        assert_eq!(m.status().state, UpdateState::Idle);
        m.begin_check();
        assert_eq!(m.status().state, UpdateState::Checking);
        assert_eq!(
            m.found("0.1.5".into(), Some("n".into()), 100),
            Next::Download
        );
        let s = m.status();
        assert_eq!(s.state, UpdateState::Downloading);
        assert_eq!(s.latest_version.as_deref(), Some("0.1.5"));
        assert_eq!(s.notes.as_deref(), Some("n"));
        assert_eq!(s.checked_at, Some(100));
        assert!(m.begin_install().is_err(), "取得中はインストールできない");
        m.progress(10, Some(30));
        m.progress(5, Some(30));
        assert_eq!(
            (m.status().bytes_done, m.status().bytes_total),
            (15, Some(30))
        );
        assert_eq!(m.ready_version(), None);
        m.downloaded(7);
        assert_eq!(m.status().state, UpdateState::Ready);
        assert_eq!(m.ready_version(), Some("0.1.5"));
        assert_eq!(m.begin_install().unwrap(), 7);
        assert_eq!(m.status().state, UpdateState::Installing);
        assert_eq!(m.ready_version(), None);
        // 他の処理の実行中で中止 → ready に戻る
        m.install_aborted();
        assert_eq!(m.ready_version(), Some("0.1.5"));
        assert_eq!(m.begin_install().unwrap(), 7);
        m.install_failed(Msg::UpdateInstallFailed);
        let s = m.status();
        assert_eq!(s.state, UpdateState::Error);
        assert_eq!(s.latest_version.as_deref(), Some("0.1.5"));
        assert!(
            m.begin_install().is_err(),
            "失敗後は取得し直すまでインストールできない"
        );
        // 次の確認で取り直す
        m.begin_check();
        assert_eq!(m.status().error, None);
        assert_eq!(m.found("0.1.5".into(), None, 200), Next::Download);
    }

    #[test]
    fn up_to_date_and_failures() {
        let mut m = m();
        m.begin_check();
        m.up_to_date(5);
        let s = m.status();
        assert_eq!(
            (s.state, s.latest_version.clone(), s.checked_at),
            (UpdateState::Idle, None, Some(5))
        );
        m.begin_check();
        m.check_failed(Msg::UpdateCheckFailed);
        let s = m.status();
        assert_eq!(s.state, UpdateState::Error);
        assert_eq!(s.error, Some(Msg::UpdateCheckFailed));
        assert_eq!(s.checked_at, Some(5), "成功した確認の時刻は残す");
        m.begin_check();
        m.found("0.2.0".into(), None, 6);
        m.download_failed(Msg::UpdateDownloadFailed);
        let s = m.status();
        assert_eq!(s.state, UpdateState::Error);
        assert_eq!(s.latest_version.as_deref(), Some("0.2.0"));
    }

    #[test]
    fn checks_after_ready_keep_or_replace_pending() {
        let mut m = m();
        m.begin_check();
        m.found("0.1.5".into(), None, 1);
        m.downloaded(1);
        // ready のまま裏で確認する
        m.begin_check();
        assert_eq!(m.status().state, UpdateState::Ready);
        // 同じ版・最新・失敗では取得済みのまま
        assert_eq!(m.found("0.1.5".into(), None, 2), Next::Nothing);
        assert_eq!(m.ready_version(), Some("0.1.5"));
        assert_eq!(m.status().checked_at, Some(2));
        m.up_to_date(3);
        assert_eq!(m.ready_version(), Some("0.1.5"));
        m.check_failed(Msg::UpdateCheckFailed);
        assert_eq!(m.ready_version(), Some("0.1.5"));
        assert_eq!(m.status().error, None);
        // さらに新しい版は取り直す。失敗したら前の取得済みに戻る
        assert_eq!(m.found("0.1.6".into(), None, 4), Next::Download);
        assert_eq!(m.status().state, UpdateState::Downloading);
        m.download_failed(Msg::UpdateDownloadFailed);
        assert_eq!(m.ready_version(), Some("0.1.5"));
        assert_eq!(m.found("0.1.6".into(), None, 5), Next::Download);
        m.downloaded(2);
        assert_eq!(m.ready_version(), Some("0.1.6"));
        assert_eq!(m.begin_install().unwrap(), 2);
    }

    #[test]
    fn older_or_same_version_keeps_pending() {
        let mut m = m();
        m.begin_check();
        m.found("0.1.10".into(), Some("a".into()), 1);
        m.downloaded(1);
        // 古い版 (Latest の取り下げ等)。文字列比較では "0.1.9" > "0.1.10" になるが semver で比べる
        m.begin_check();
        assert_eq!(m.found("0.1.9".into(), None, 2), Next::Nothing);
        assert_eq!(m.ready_version(), Some("0.1.10"));
        assert_eq!(m.status().notes.as_deref(), Some("a"));
        assert_eq!(m.found("0.1.10-rc.1".into(), None, 3), Next::Nothing);
        assert_eq!(m.found("0.1.10".into(), None, 4), Next::Nothing);
        // 解釈できない版でも取得済みを捨てない
        assert_eq!(m.found("x".into(), None, 5), Next::Nothing);
        assert_eq!(m.ready_version(), Some("0.1.10"));
        assert_eq!(m.status().checked_at, Some(5));
        assert_eq!(m.found("0.1.11".into(), None, 6), Next::Download);
        assert!(is_newer("0.2.0", "0.1.10"));
        assert!(is_newer("1.0.0", "1.0.0-rc.1"));
        assert!(!is_newer("0.1.10", "0.1.10"));
    }

    #[test]
    fn installing_flag() {
        let mut m = m();
        assert!(!m.is_installing());
        m.begin_check();
        m.found("0.1.5".into(), None, 1);
        m.downloaded(1);
        assert!(!m.is_installing());
        m.begin_install().unwrap();
        assert!(m.is_installing());
        m.install_aborted();
        assert!(!m.is_installing());
    }

    #[test]
    fn status_serializes_per_contract() {
        let m = m();
        let v = serde_json::to_value(m.status()).unwrap();
        assert_eq!(v["state"], "idle");
        assert_eq!(v["currentVersion"], "0.1.4");
        for k in ["latestVersion", "notes", "bytesTotal", "checkedAt", "error"] {
            assert!(v[k].is_null(), "{k}");
        }
        assert_eq!(v["bytesDone"], 0);
        let states = [
            (UpdateState::Unavailable, "unavailable"),
            (UpdateState::Checking, "checking"),
            (UpdateState::Downloading, "downloading"),
            (UpdateState::Ready, "ready"),
            (UpdateState::Installing, "installing"),
            (UpdateState::Error, "error"),
        ];
        for (s, name) in states {
            assert_eq!(serde_json::to_value(s).unwrap(), name);
        }
    }
}
