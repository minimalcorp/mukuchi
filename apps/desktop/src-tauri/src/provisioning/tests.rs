//! セットアップの状態遷移のテスト (Hugging Face はテスト用サーバー、runtime・verify は偽物)。

use std::sync::atomic::{AtomicBool, AtomicUsize};
use std::time::Duration;

use super::test_server::{Behavior, File, MockHf, REPO, REVISION};
use super::*;

struct FakeRuntime {
    paths: DataPaths,
    version: Mutex<String>,
    calls: AtomicUsize,
}

impl RuntimeStep for FakeRuntime {
    fn version(&self) -> Option<String> {
        Some(lock(&self.version).clone())
    }
    fn is_present(&self) -> bool {
        self.paths.venv_python().exists()
    }
    fn install(&self, _cancel: Cancel) -> BoxFuture<Result<(), StepError>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let py = self.paths.venv_python();
        Box::pin(async move {
            std::fs::create_dir_all(py.parent().unwrap()).unwrap();
            std::fs::write(&py, "").unwrap();
            Ok(())
        })
    }
}

#[derive(Default)]
struct FakeVerify {
    calls: AtomicUsize,
    fail: AtomicBool,
}

impl VerifyStep for FakeVerify {
    fn verify(&self, _cancel: Cancel) -> BoxFuture<Result<(), StepError>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let fail = self.fail.load(Ordering::SeqCst);
        Box::pin(async move {
            if fail {
                Err(failed("動作確認に失敗", anyhow!("fake")))
            } else {
                Ok(())
            }
        })
    }
}

struct Fixture {
    _tmp: tempfile::TempDir,
    paths: DataPaths,
    server: MockHf,
    runtime: Arc<FakeRuntime>,
    verify: Arc<FakeVerify>,
    events: Arc<Mutex<Vec<ProvisioningStatus>>>,
}

fn content(n: usize, seed: u8) -> Vec<u8> {
    (0..n)
        .map(|i| (i as u8).wrapping_mul(31).wrapping_add(seed))
        .collect()
}

impl Fixture {
    fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let paths = DataPaths::new(tmp.path().join("data"));
        // 起動時と同じく目印を書く
        paths.ensure_root().unwrap();
        let server = MockHf::start(vec![
            File {
                path: "config.json".into(),
                content: b"{\"a\":1}".to_vec(),
                lfs: false,
            },
            File {
                path: "model.safetensors".into(),
                content: content(64 * 1024, 7),
                lfs: true,
            },
            File {
                path: "sub/vocab.txt".into(),
                content: content(3000, 3),
                lfs: false,
            },
        ]);
        Self {
            runtime: Arc::new(FakeRuntime {
                paths: paths.clone(),
                version: Mutex::new("rt-1".into()),
                calls: AtomicUsize::new(0),
            }),
            verify: Arc::new(FakeVerify::default()),
            events: Arc::new(Mutex::new(Vec::new())),
            _tmp: tmp,
            paths,
            server,
        }
    }

    fn model(&self) -> HfModel {
        HfModel {
            endpoint: self.server.endpoint.clone(),
            repo: REPO.into(),
            revision: REVISION.into(),
        }
    }

    fn provisioner(&self) -> Arc<Provisioner> {
        let ev = self.events.clone();
        Provisioner::new(
            self.paths.clone(),
            self.model(),
            self.runtime.clone(),
            self.verify.clone(),
            move |s| ev.lock().unwrap().push(s.clone()),
        )
        .unwrap()
    }

    fn storage(&self) -> PathBuf {
        self.model().storage_dir(&self.paths.models())
    }
}

fn block_on<F: Future>(f: F) -> F::Output {
    tauri::async_runtime::block_on(f)
}

/// 実行が終わる (完了・一時停止・失敗) まで待つ
async fn wait_finished(p: &Provisioner) -> ProvisioningStatus {
    for _ in 0..1000 {
        let fin = lock(&p.running)
            .as_ref()
            .is_none_or(|r| *r.finished.borrow());
        if fin {
            return p.status();
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("終わらない: {:?}", p.status());
}

#[test]
fn full_run_writes_hf_layout_and_skips_on_rerun() {
    let fx = Fixture::new();
    let p = fx.provisioner();
    assert_eq!(p.status().stage, Stage::Idle);
    assert!(!p.is_done());
    p.start();
    let s = block_on(wait_finished(&p));
    assert_eq!(s.stage, Stage::Done, "{s:?}");
    assert!(p.is_done());
    let total = 7 + 64 * 1024 + 3000;
    assert_eq!((s.bytes_done, s.bytes_total), (total, Some(total)));
    assert!(s.items.iter().all(|i| i.state == ItemState::Done));
    assert_eq!(s.items[1].bytes_total, Some(total));
    assert_eq!(s.items[0].bytes_total, None);

    // キャッシュのレイアウト
    let snap = fx.storage().join("snapshots").join(REVISION);
    assert_eq!(
        std::fs::read(snap.join("config.json")).unwrap(),
        b"{\"a\":1}"
    );
    assert_eq!(
        std::fs::read(snap.join("model.safetensors")).unwrap(),
        content(64 * 1024, 7)
    );
    assert!(std::fs::read_link(snap.join("sub/vocab.txt"))
        .unwrap()
        .starts_with("../../../blobs"));
    assert!(!fx
        .storage()
        .join("snapshots")
        .join(REVISION)
        .join("README.md")
        .exists());
    assert_eq!(
        std::fs::read_to_string(fx.storage().join("refs/main")).unwrap(),
        REVISION
    );
    let incomplete = std::fs::read_dir(fx.storage().join("blobs"))
        .unwrap()
        .flatten()
        .any(|e| e.file_name().to_string_lossy().ends_with(".incomplete"));
    assert!(!incomplete);

    // provisioned.json
    let rec = Provisioned::load(&fx.paths.provisioned());
    assert_eq!(rec.runtime.as_ref().unwrap().version, "rt-1");
    assert_eq!(
        rec.model.as_ref().unwrap().version,
        format!("{REPO}@{REVISION}")
    );
    assert_eq!(rec.verify.as_ref().unwrap().runtime, "rt-1");

    // 段階の通知の順序
    let stages: Vec<Stage> = {
        let ev = fx.events.lock().unwrap();
        let mut v: Vec<Stage> = ev.iter().map(|s| s.stage).collect();
        v.dedup();
        v
    };
    assert_eq!(
        stages,
        vec![
            Stage::Idle,
            Stage::Runtime,
            Stage::Model,
            Stage::Verify,
            Stage::Done
        ]
    );

    // 作り直しても完了扱い。start は何もしない
    let p2 = fx.provisioner();
    assert!(p2.is_done());
    assert_eq!(p2.status().stage, Stage::Done);
    p2.start();
    block_on(wait_finished(&p2));
    assert_eq!(fx.runtime.calls.load(Ordering::SeqCst), 1);
    assert_eq!(fx.verify.calls.load(Ordering::SeqCst), 1);
}

#[test]
fn interrupted_download_fails_then_resumes_with_range() {
    let fx = Fixture::new();
    let p = fx.provisioner();
    {
        // model.safetensors を最初に取らせ、20000 バイトで切断 → 以後 503 で再試行 (3回) を使い切る
        let mut st = fx.server.state();
        st.files.swap(0, 1);
        st.script.push_back(Behavior::Cut(20_000));
        for _ in 0..3 {
            st.script.push_back(Behavior::Fail(503));
        }
    }
    p.start();
    let s = block_on(wait_finished(&p));
    assert_eq!(s.stage, Stage::Error, "{s:?}");
    assert!(s.error.as_deref().unwrap().contains("中断"), "{s:?}");
    assert_eq!(s.items[1].bytes_done, 20_000);
    assert!(!p.is_done());
    let blob = super::test_server::sha256(&content(64 * 1024, 7));
    let inc = fx
        .storage()
        .join("blobs")
        .join(format!("{blob}.incomplete"));
    assert_eq!(std::fs::metadata(&inc).unwrap().len(), 20_000);
    // runtime は済んでいる
    assert!(Provisioned::load(&fx.paths.provisioned()).runtime.is_some());

    // 再試行: 続きから取る
    p.start();
    let s = block_on(wait_finished(&p));
    assert_eq!(s.stage, Stage::Done, "{s:?}");
    assert_eq!(s.error, None);
    assert_eq!(
        fx.runtime.calls.load(Ordering::SeqCst),
        1,
        "runtime はやり直さない"
    );
    let reqs = fx.server.state().requests.clone();
    assert!(
        reqs.iter()
            .any(|(p, r)| p == "model.safetensors" && *r == Some(20_000)),
        "{reqs:?}"
    );
    assert!(fx.storage().join("blobs").join(&blob).is_file());
    assert!(!inc.exists());
}

#[test]
fn pause_keeps_partial_and_resume_continues() {
    let fx = Fixture::new();
    {
        let mut st = fx.server.state();
        st.files.swap(0, 1);
        st.throttle = Some(Duration::from_millis(20));
    }
    let p = fx.provisioner();
    p.start();
    block_on(async {
        for _ in 0..500 {
            if p.status().items[1].bytes_done > 4096 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        p.pause().await;
    });
    let s = p.status();
    assert_eq!(s.stage, Stage::Paused, "{s:?}");
    let done_at_pause = s.items[1].bytes_done;
    assert!(done_at_pause > 0 && done_at_pause < 64 * 1024, "{s:?}");
    assert_eq!(s.eta_seconds, None);

    fx.server.state().throttle = None;
    p.start();
    let s = block_on(wait_finished(&p));
    assert_eq!(s.stage, Stage::Done, "{s:?}");
    let reqs = fx.server.state().requests.clone();
    let resumed = reqs
        .iter()
        .filter(|(p, _)| p == "model.safetensors")
        .filter_map(|(_, r)| *r)
        .next()
        .expect("Range 付きで再開する");
    assert!(resumed > 0 && resumed <= done_at_pause, "{reqs:?}");
}

#[test]
fn corrupt_download_is_discarded() {
    let fx = Fixture::new();
    fx.server.state().corrupt = true;
    let p = fx.provisioner();
    p.start();
    let s = block_on(wait_finished(&p));
    assert_eq!(s.stage, Stage::Error);
    assert!(s.error.as_deref().unwrap().contains("壊れて"), "{s:?}");
    let leftovers: Vec<_> = std::fs::read_dir(fx.storage().join("blobs"))
        .unwrap()
        .flatten()
        .collect();
    assert!(leftovers.is_empty(), "壊れたファイルを残さない");
    assert_eq!(fx.verify.calls.load(Ordering::SeqCst), 0);

    fx.server.state().corrupt = false;
    p.start();
    assert_eq!(block_on(wait_finished(&p)).stage, Stage::Done);
}

/// model.safetensors を先頭にし、20000 バイトで切断させた後の応答を `then` にする
fn cut_then(fx: &Fixture, then: &[Behavior]) {
    let mut st = fx.server.state();
    st.files.swap(0, 1);
    st.script.push_back(Behavior::Cut(20_000));
    st.script.extend(then.iter().copied());
}

fn safetensors_incomplete(fx: &Fixture) -> PathBuf {
    let blob = super::test_server::sha256(&content(64 * 1024, 7));
    fx.storage()
        .join("blobs")
        .join(format!("{blob}.incomplete"))
}

#[test]
fn range_ignored_restarts_from_zero() {
    let fx = Fixture::new();
    cut_then(&fx, &[Behavior::IgnoreRange]);
    let p = fx.provisioner();
    p.start();
    let s = block_on(wait_finished(&p));
    assert_eq!(s.stage, Stage::Done, "{s:?}");
    let total = 7 + 64 * 1024 + 3000;
    assert_eq!(s.bytes_done, total, "やり直した分を二重に数えない");
    let reqs = fx.server.state().requests.clone();
    let st: Vec<_> = reqs
        .iter()
        .filter(|(p, _)| p == "model.safetensors")
        .map(|(_, r)| *r)
        .collect();
    assert_eq!(st, vec![None, Some(20_000)]);
}

#[test]
fn mismatched_content_range_is_not_written() {
    let fx = Fixture::new();
    // 1回ずれた応答の後は正しく返す: 続きから取り直して完了する (ずれた分をつないでいればハッシュで失敗する)
    cut_then(&fx, &[Behavior::WrongRange(10_000)]);
    let p = fx.provisioner();
    p.start();
    let s = block_on(wait_finished(&p));
    assert_eq!(s.stage, Stage::Done, "{s:?}");
    let reqs = fx.server.state().requests.clone();
    let ranged = reqs
        .iter()
        .filter(|(p, r)| p == "model.safetensors" && *r == Some(20_000))
        .count();
    assert_eq!(ranged, 2, "{reqs:?}");

    // ずっとずれている: 書かずに一時的な失敗として再試行を使い切る
    let fx = Fixture::new();
    cut_then(&fx, &[Behavior::WrongRange(0); 4]);
    let p = fx.provisioner();
    p.start();
    let s = block_on(wait_finished(&p));
    assert_eq!(s.stage, Stage::Error, "{s:?}");
    assert!(s.error.as_deref().unwrap().contains("中断"), "{s:?}");
    assert_eq!(
        std::fs::metadata(safetensors_incomplete(&fx))
            .unwrap()
            .len(),
        20_000
    );
    assert_eq!(s.items[1].bytes_done, 20_000);
}

#[test]
fn suspend_blocks_start_and_clears_done() {
    let fx = Fixture::new();
    fx.server.state().throttle = Some(Duration::from_millis(20));
    let p = fx.provisioner();
    p.start();
    let guard = block_on(async {
        for _ in 0..500 {
            if p.status().stage == Stage::Model {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        p.suspend().await.unwrap()
    });
    assert!(p.is_suspended());
    assert_eq!(p.status().stage, Stage::Paused, "実行中のものは止まる");
    // 2つ目の削除は拒む
    assert!(block_on(p.suspend()).is_err());
    // 削除中は開始しない
    fx.server.state().throttle = None;
    let requests = fx.server.state().requests.len();
    p.start();
    block_on(wait_finished(&p));
    assert_eq!(p.status().stage, Stage::Paused);
    assert_eq!(fx.server.state().requests.len(), requests);
    drop(guard);
    assert!(!p.is_suspended());
    p.start();
    assert_eq!(block_on(wait_finished(&p)).stage, Stage::Done);
    assert!(p.is_done());

    // 導入済みでも、削除を始めた時点で未導入扱いになる
    let guard = block_on(p.suspend()).unwrap();
    assert!(!p.is_done());
    drop(guard);
}

#[test]
fn shutdown_stops_running_provisioning() {
    let fx = Fixture::new();
    fx.server.state().throttle = Some(Duration::from_millis(50));
    let p = fx.provisioner();
    p.start();
    block_on(async {
        for _ in 0..500 {
            if p.status().items[1].bytes_done > 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    });
    let t = std::time::Instant::now();
    p.shutdown_blocking(Duration::from_secs(3));
    assert!(t.elapsed() < Duration::from_secs(3));
    assert_eq!(p.status().stage, Stage::Paused);
    // 実行していなければすぐ戻る
    Fixture::new()
        .provisioner()
        .shutdown_blocking(Duration::from_secs(3));
}

#[test]
fn http_errors_are_reported_in_japanese() {
    let fx = Fixture::new();
    fx.server.state().script.push_back(Behavior::Fail(404));
    let p = fx.provisioner();
    p.start();
    let s = block_on(wait_finished(&p));
    assert_eq!(s.stage, Stage::Error);
    assert_eq!(
        s.error.as_deref(),
        Some("モデルを取得できません (HTTP 404)")
    );
}

#[test]
fn verify_failure_then_retry_only_verifies() {
    let fx = Fixture::new();
    fx.verify.fail.store(true, Ordering::SeqCst);
    let p = fx.provisioner();
    p.start();
    let s = block_on(wait_finished(&p));
    assert_eq!(s.stage, Stage::Error);
    assert_eq!(s.error.as_deref(), Some("動作確認に失敗"));
    assert_eq!(s.items[2].state, ItemState::Active);
    let n = fx.server.state().requests.len();

    fx.verify.fail.store(false, Ordering::SeqCst);
    p.start();
    assert_eq!(block_on(wait_finished(&p)).stage, Stage::Done);
    assert_eq!(fx.runtime.calls.load(Ordering::SeqCst), 1);
    assert_eq!(fx.verify.calls.load(Ordering::SeqCst), 2);
    assert_eq!(fx.server.state().requests.len(), n, "モデルは取り直さない");
}

#[test]
fn only_stale_steps_rerun() {
    let fx = Fixture::new();
    let p = fx.provisioner();
    p.start();
    assert_eq!(block_on(wait_finished(&p)).stage, Stage::Done);
    let n = fx.server.state().requests.len();

    // アプリの更新で runtime の版が変わった: runtime と verify だけ
    *lock(&fx.runtime.version) = "rt-2".into();
    let p = fx.provisioner();
    assert!(!p.is_done());
    let s = p.status();
    assert_eq!(
        s.items.iter().map(|i| i.state).collect::<Vec<_>>(),
        vec![ItemState::Pending, ItemState::Done, ItemState::Pending]
    );
    assert!(p.has_record());
    p.start();
    assert_eq!(block_on(wait_finished(&p)).stage, Stage::Done);
    assert_eq!(fx.runtime.calls.load(Ordering::SeqCst), 2);
    assert_eq!(fx.verify.calls.load(Ordering::SeqCst), 2);
    assert_eq!(fx.server.state().requests.len(), n, "モデルは取り直さない");
    assert_eq!(
        Provisioned::load(&fx.paths.provisioned())
            .verify
            .unwrap()
            .runtime,
        "rt-2"
    );

    // モデルが消されていたら model と verify
    std::fs::remove_dir_all(fx.paths.models()).unwrap();
    let p = fx.provisioner();
    assert_eq!(
        p.status().items.iter().map(|i| i.state).collect::<Vec<_>>(),
        vec![ItemState::Done, ItemState::Pending, ItemState::Pending]
    );

    // 削除後は記録ごと消えて自動ではやり直さない
    crate::storage::delete_runtime_and_model(&fx.paths).unwrap();
    let p = fx.provisioner();
    assert!(!p.has_record());
    p.reset();
    assert_eq!(p.status().stage, Stage::Idle);
}

#[test]
fn plan_rules() {
    let rec = |rt: Option<&str>, m: Option<&str>, v: Option<(&str, &str)>| Provisioned {
        runtime: rt.map(|v| StepRecord {
            version: v.into(),
            completed_at: 1,
        }),
        model: m.map(|v| StepRecord {
            version: v.into(),
            completed_at: 1,
        }),
        verify: v.map(|(r, m)| VerifyRecord {
            runtime: r.into(),
            model: m.into(),
            completed_at: 1,
        }),
    };
    let all = |r, m, v| Plan {
        runtime: r,
        model: m,
        verify: v,
    };
    let full = rec(Some("r1"), Some("m1"), Some(("r1", "m1")));
    assert_eq!(
        plan(&full, Some("r1"), true, "m1", true),
        all(false, false, false)
    );
    assert_eq!(
        plan(&full, Some("r2"), true, "m1", true),
        all(true, false, true)
    );
    assert_eq!(
        plan(&full, Some("r1"), true, "m2", true),
        all(false, true, true)
    );
    assert_eq!(
        plan(&full, Some("r1"), false, "m1", true),
        all(true, false, true)
    );
    assert_eq!(
        plan(&full, Some("r1"), true, "m1", false),
        all(false, true, true)
    );
    // 版が分からない (開発で同梱物なし) なら記録を信じる
    assert_eq!(
        plan(&full, None, true, "m1", true),
        all(false, false, false)
    );
    assert_eq!(
        plan(
            &rec(Some("r1"), Some("m1"), None),
            Some("r1"),
            true,
            "m1",
            true
        ),
        all(false, false, true)
    );
    assert_eq!(
        plan(&Provisioned::default(), Some("r1"), true, "m1", true),
        all(true, true, true)
    );
}

#[test]
fn status_serializes_per_contract() {
    let mut s = ProvisioningStatus::new([true, false, false]);
    s.stage = Stage::Model;
    s.item(ItemId::Model).bytes_total = Some(10);
    s.item(ItemId::Model).bytes_done = 4;
    s.recompute_total();
    assert_eq!(
        serde_json::to_value(&s).unwrap(),
        serde_json::json!({
            "stage": "model",
            "items": [
                {"id": "runtime", "state": "done", "bytesDone": 0, "bytesTotal": null},
                {"id": "model", "state": "pending", "bytesDone": 4, "bytesTotal": 10},
                {"id": "verify", "state": "pending", "bytesDone": 0, "bytesTotal": null},
            ],
            "bytesDone": 4, "bytesTotal": 10, "etaSeconds": null, "error": null
        })
    );
}

#[test]
fn eta_from_recent_rate() {
    let mut r = RateMeter::default();
    let t = Instant::now();
    r.push(t, 0);
    r.push(t + Duration::from_secs(1), 100);
    assert_eq!(r.eta(1000), None, "2秒未満は出さない");
    r.push(t + Duration::from_secs(4), 400);
    assert_eq!(r.eta(1000), Some(10));
    // やり直しで減ったら測り直す
    r.push(t + Duration::from_secs(5), 0);
    assert_eq!(r.eta(1000), None);
}
