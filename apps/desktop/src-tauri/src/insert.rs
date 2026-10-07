//! 前面アプリへの入力。単一キュー (専用スレッド1本) で直列に実行する。
//!
//! 確定リクエストは発話ごとに並行して送るが、入力は発話順に行う (貼り付けと Enter の順序保証)。
//! そのため、発話の確定時点で「結果の受け口」を発話順にキューへ積み、
//! キュー側は先頭の結果が届くまで待ってから次へ進む。

use std::sync::mpsc;
use std::sync::Arc;

use anyhow::Result;
use serde::Serialize;
use tokio::sync::oneshot;

use crate::settings::{ExcludedApp, KeyCombo, VoiceCommand};
use crate::state::{AppError, ErrorCode};
use crate::voice_command;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrontApp {
    pub name: String,
    pub bundle_id: Option<String>,
}

/// OSへの入力操作。macOS実装とテスト用のモックを差し替える。
pub trait InsertBackend: Send + Sync {
    fn frontmost_app(&self) -> Option<FrontApp>;
    fn is_trusted(&self) -> bool;
    /// クリップボード経由で貼り付け、元のクリップボードを復元する。
    fn paste_text(&self, text: &str) -> Result<()>;
    fn send_key(&self, key: &KeyCombo) -> Result<()>;
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum UtteranceResult {
    Inserted {
        id: u64,
        text: String,
        app_name: String,
    },
    Command {
        id: u64,
        text: String,
        key: String,
    },
    SkippedExcluded {
        id: u64,
        text: String,
        app_name: String,
    },
    Empty {
        id: u64,
    },
    Discarded {
        id: u64,
    },
    Failed {
        id: u64,
        text: String,
        error: AppError,
    },
}

impl UtteranceResult {
    /// ログ用の要約。発話内容はログに残さない (ログはファイルに残り、共有されることがあるため)
    pub fn summary(&self) -> String {
        match self {
            Self::Inserted { id, text, app_name } => {
                format!("#{id} inserted {}文字 → {app_name}", text.chars().count())
            }
            Self::Command { id, key, .. } => format!("#{id} command {key}"),
            Self::SkippedExcluded { id, app_name, .. } => {
                format!("#{id} skipped_excluded {app_name}")
            }
            Self::Empty { id } => format!("#{id} empty"),
            Self::Discarded { id } => format!("#{id} discarded"),
            Self::Failed { id, error, .. } => {
                format!("#{id} failed {:?}: {}", error.code, error.message)
            }
        }
    }

    /// 前面アプリに何かを送ったか (「完了」表示の対象)
    pub fn is_delivered(&self) -> bool {
        matches!(self, Self::Inserted { .. } | Self::Command { .. })
    }

    pub fn error_code(&self) -> Option<ErrorCode> {
        match self {
            Self::Failed { error, .. } => Some(error.code),
            _ => None,
        }
    }
}

/// 入力時点の設定のスナップショット
#[derive(Debug, Clone, Default)]
pub struct InsertConfig {
    pub voice_commands_enabled: bool,
    pub voice_commands: Vec<VoiceCommand>,
    pub excluded_apps: Vec<ExcludedApp>,
    /// 開発時の自動テスト用: 指定したアプリが前面にある時だけ入力する (他のアプリに誤って入力しない)
    pub only_bundle_id: Option<String>,
}

/// 確定待ちの発話。`result` には ASR の結果 (または失敗) が届く。
pub struct Job {
    pub id: u64,
    pub result: oneshot::Receiver<Result<String>>,
}

#[derive(Clone)]
pub struct InsertQueue {
    tx: mpsc::Sender<Job>,
}

impl InsertQueue {
    /// キューのスレッドを起動する。`on_result` はキューのスレッドから発話順に呼ばれる。
    pub fn spawn(
        backend: Arc<dyn InsertBackend>,
        config: impl Fn() -> InsertConfig + Send + 'static,
        on_result: impl Fn(UtteranceResult) + Send + 'static,
    ) -> Result<Self> {
        let (tx, rx) = mpsc::channel::<Job>();
        std::thread::Builder::new()
            .name("mukuchi-insert".into())
            .spawn(move || {
                for job in rx {
                    let result = match job.result.blocking_recv() {
                        Ok(Ok(text)) => handle_text(job.id, &text, backend.as_ref(), &config()),
                        Ok(Err(e)) => {
                            log::error!("発話 {} の文字起こしに失敗: {e:#}", job.id);
                            UtteranceResult::Failed {
                                id: job.id,
                                text: String::new(),
                                error: AppError::asr_stopped(format!("{e:#}")),
                            }
                        }
                        Err(_) => UtteranceResult::Failed {
                            id: job.id,
                            text: String::new(),
                            error: AppError::asr_stopped("処理が中断されました"),
                        },
                    };
                    on_result(result);
                }
            })?;
        Ok(Self { tx })
    }

    /// 発話順に呼ぶこと。
    pub fn enqueue(&self, job: Job) -> Result<()> {
        self.tx
            .send(job)
            .map_err(|_| anyhow::anyhow!("入力キューが停止しています"))
    }
}

/// 認識結果の文字列を前面アプリへ送る。
pub fn handle_text(
    id: u64,
    text: &str,
    backend: &dyn InsertBackend,
    cfg: &InsertConfig,
) -> UtteranceResult {
    if text.trim().is_empty() {
        return UtteranceResult::Empty { id };
    }
    let app = backend.frontmost_app();
    let app_name = app.as_ref().map(|a| a.name.clone()).unwrap_or_default();
    let bundle = app.as_ref().and_then(|a| a.bundle_id.as_deref());
    let excluded = bundle.is_some_and(|b| cfg.excluded_apps.iter().any(|e| e.bundle_id == b))
        || cfg
            .only_bundle_id
            .as_deref()
            .is_some_and(|only| bundle != Some(only));
    if excluded {
        return UtteranceResult::SkippedExcluded {
            id,
            text: text.to_string(),
            app_name,
        };
    }
    if !backend.is_trusted() {
        return UtteranceResult::Failed {
            id,
            text: text.to_string(),
            error: AppError::accessibility_denied(),
        };
    }
    let command = cfg
        .voice_commands_enabled
        .then(|| voice_command::match_command(text, &cfg.voice_commands))
        .flatten();
    let outcome = match command {
        Some(key) => backend.send_key(key).map(|_| UtteranceResult::Command {
            id,
            text: text.to_string(),
            key: key.display(),
        }),
        None => backend.paste_text(text).map(|_| UtteranceResult::Inserted {
            id,
            text: text.to_string(),
            app_name,
        }),
    };
    outcome.unwrap_or_else(|e| {
        log::error!("発話 {id} の入力に失敗: {e:#}");
        UtteranceResult::Failed {
            id,
            text: text.to_string(),
            error: AppError::insert_failed(format!("{e:#}")),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::default_voice_commands;
    use std::sync::Mutex;
    use std::time::Duration;

    #[derive(Default)]
    struct Mock {
        log: Mutex<Vec<String>>,
        untrusted: bool,
        bundle: Option<String>,
    }

    impl InsertBackend for Mock {
        fn frontmost_app(&self) -> Option<FrontApp> {
            Some(FrontApp {
                name: "TextEdit".into(),
                bundle_id: self.bundle.clone().or(Some("com.apple.TextEdit".into())),
            })
        }
        fn is_trusted(&self) -> bool {
            !self.untrusted
        }
        fn paste_text(&self, text: &str) -> Result<()> {
            self.log.lock().unwrap().push(format!("paste:{text}"));
            Ok(())
        }
        fn send_key(&self, key: &KeyCombo) -> Result<()> {
            self.log
                .lock()
                .unwrap()
                .push(format!("key:{}", key.display()));
            Ok(())
        }
    }

    fn cfg() -> InsertConfig {
        InsertConfig {
            voice_commands_enabled: true,
            voice_commands: default_voice_commands(crate::i18n::Locale::Ja),
            excluded_apps: vec![ExcludedApp {
                bundle_id: "com.example.secret".into(),
                name: "Secret".into(),
            }],
            only_bundle_id: None,
        }
    }

    #[test]
    fn inserts_in_utterance_order_even_if_results_arrive_out_of_order() {
        let mock = Arc::new(Mock::default());
        let (res_tx, res_rx) = mpsc::channel();
        let q = InsertQueue::spawn(mock.clone(), cfg, move |r| {
            res_tx.send(r).unwrap();
        })
        .unwrap();

        let mut senders = Vec::new();
        for id in 1..=4 {
            let (tx, rx) = oneshot::channel();
            q.enqueue(Job { id, result: rx }).unwrap();
            senders.push((id, tx));
        }
        // 後の発話から先に結果が届く
        let texts = ["一つ目", "二つ目", "確定。", "四つ目"];
        for (id, tx) in senders.into_iter().rev() {
            tx.send(Ok(texts[id as usize - 1].to_string())).unwrap();
            std::thread::sleep(Duration::from_millis(10));
        }
        let ids: Vec<u64> = (0..4)
            .map(
                |_| match res_rx.recv_timeout(Duration::from_secs(5)).unwrap() {
                    UtteranceResult::Inserted { id, .. } | UtteranceResult::Command { id, .. } => {
                        id
                    }
                    other => panic!("{other:?}"),
                },
            )
            .collect();
        assert_eq!(ids, vec![1, 2, 3, 4]);
        assert_eq!(
            *mock.log.lock().unwrap(),
            vec!["paste:一つ目", "paste:二つ目", "key:Enter", "paste:四つ目"]
        );
    }

    #[test]
    fn asr_failure_does_not_block_following_utterances() {
        let mock = Arc::new(Mock::default());
        let (res_tx, res_rx) = mpsc::channel();
        let q = InsertQueue::spawn(mock.clone(), cfg, move |r| res_tx.send(r).unwrap()).unwrap();
        let (tx1, rx1) = oneshot::channel();
        let (tx2, rx2) = oneshot::channel::<Result<String>>();
        q.enqueue(Job { id: 1, result: rx1 }).unwrap();
        q.enqueue(Job { id: 2, result: rx2 }).unwrap();
        tx2.send(Ok("あと".into())).unwrap();
        tx1.send(Err(anyhow::anyhow!("boom"))).unwrap();
        let r1 = res_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(r1.error_code(), Some(ErrorCode::AsrStopped));
        let r2 = res_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(r2.is_delivered());
    }

    #[test]
    fn empty_excluded_untrusted_and_disabled_commands() {
        let mock = Mock::default();
        assert_eq!(
            handle_text(1, "  ", &mock, &cfg()),
            UtteranceResult::Empty { id: 1 }
        );

        let excluded = Mock {
            bundle: Some("com.example.secret".into()),
            ..Default::default()
        };
        assert!(matches!(
            handle_text(2, "こんにちは", &excluded, &cfg()),
            UtteranceResult::SkippedExcluded { .. }
        ));
        assert!(excluded.log.lock().unwrap().is_empty());

        let untrusted = Mock {
            untrusted: true,
            ..Default::default()
        };
        assert_eq!(
            handle_text(3, "こんにちは", &untrusted, &cfg()).error_code(),
            Some(ErrorCode::AccessibilityDenied)
        );

        let mut c = cfg();
        c.only_bundle_id = Some("com.example.other".into());
        assert!(matches!(
            handle_text(5, "こんにちは", &mock, &c),
            UtteranceResult::SkippedExcluded { .. }
        ));

        let mut c = cfg();
        c.voice_commands_enabled = false;
        assert!(matches!(
            handle_text(4, "確定", &mock, &c),
            UtteranceResult::Inserted { .. }
        ));
    }

    #[test]
    fn serializes_per_contract() {
        let v = serde_json::to_value(UtteranceResult::SkippedExcluded {
            id: 3,
            text: "a".into(),
            app_name: "X".into(),
        })
        .unwrap();
        assert_eq!(v["kind"], "skipped_excluded");
        assert_eq!(v["appName"], "X");
        let v = serde_json::to_value(UtteranceResult::Discarded { id: 1 }).unwrap();
        assert_eq!(v, serde_json::json!({ "kind": "discarded", "id": 1 }));
    }
}
