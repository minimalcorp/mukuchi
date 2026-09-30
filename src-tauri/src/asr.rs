//! ASRサーバーのクライアントとプロセス管理 (HTTP API は docs/architecture.md)。
//!
//! 開発時は環境変数 `MUKUCHI_ASR_URL` のサーバーに接続するだけで、自分では起動しない。
//! 本番の起動 (空きポート・`uv run`・/health 待ち・自動再起動) は P4 で実装する。

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use anyhow::{Context, Result};
use serde::Deserialize;

pub const ENV_ASR_URL: &str = "MUKUCHI_ASR_URL";

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

/// 文字起こしクライアント。テストや別実装に差し替えられるようにtraitにする。
pub trait AsrClient: Send + Sync {
    /// 16kHz/mono/16bit の WAV を送り、認識結果の文字列を返す。
    fn transcribe(&self, wav: Vec<u8>, context: Option<String>) -> BoxFuture<Result<String>>;
}

#[derive(Debug, Deserialize)]
struct TranscribeResponse {
    text: String,
    elapsed_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct HealthResponse {
    status: String,
    model: Option<String>,
}

#[derive(Clone)]
pub struct HttpAsrClient {
    base: String,
    http: reqwest::Client,
}

impl HttpAsrClient {
    pub fn new(base: impl Into<String>) -> Result<Self> {
        let http = reqwest::Client::builder()
            // ループバックへの接続にプロキシを使わない
            .no_proxy()
            .build()
            .context("HTTPクライアントを作成できません")?;
        Ok(Self {
            base: base.into().trim_end_matches('/').to_string(),
            http,
        })
    }

    pub fn base_url(&self) -> &str {
        &self.base
    }

    /// `/health` が ok を返せば、読み込み済みのモデル名を返す。
    pub async fn health(&self) -> Result<String> {
        let res = self
            .http
            .get(format!("{}/health", self.base))
            .timeout(Duration::from_secs(3))
            .send()
            .await
            .context("ASRサーバーに接続できません")?
            .error_for_status()
            .context("ASRサーバーの /health がエラー")?;
        let h: HealthResponse = res.json().await.context("/health の応答が不正")?;
        if h.status != "ok" {
            anyhow::bail!("ASRサーバーの状態: {}", h.status);
        }
        Ok(h.model.unwrap_or_default())
    }
}

impl AsrClient for HttpAsrClient {
    fn transcribe(&self, wav: Vec<u8>, context: Option<String>) -> BoxFuture<Result<String>> {
        let this = self.clone();
        Box::pin(async move {
            let mut query: Vec<(&str, String)> = vec![("language", "Japanese".to_string())];
            if let Some(c) = context.filter(|c| !c.is_empty()) {
                query.push(("context", c));
            }
            let bytes = wav.len();
            let started = std::time::Instant::now();
            let res = this
                .http
                .post(format!("{}/transcribe", this.base))
                .query(&query)
                .header(reqwest::header::CONTENT_TYPE, "audio/wav")
                .body(wav)
                // 推論は直列のため、前の発話の処理待ちも含めて余裕を持たせる
                .timeout(Duration::from_secs(120))
                .send()
                .await
                .context("ASRサーバーに接続できません")?;
            let status = res.status();
            if !status.is_success() {
                let body = res.text().await.unwrap_or_default();
                anyhow::bail!("ASRサーバーがエラーを返しました: {status} {body}");
            }
            let r: TranscribeResponse = res.json().await.context("/transcribe の応答が不正")?;
            log::info!(
                "文字起こし: {bytes}B, サーバー {}ms, 往復 {}ms",
                r.elapsed_ms.unwrap_or(0),
                started.elapsed().as_millis()
            );
            Ok(r.text)
        })
    }
}

/// 接続先の決定。開発時は環境変数、本番はサーバーを起動する (P4)。
pub fn resolve_endpoint() -> Option<String> {
    std::env::var(ENV_ASR_URL).ok().filter(|s| !s.is_empty())
    // TODO(P4): 本番は空きポートを選び、データディレクトリの venv で
    // `mukuchi-asr --port <port> --exit-on-stdin-eof` を起動して /health を待つ。
    // 異常終了時は3回まで自動再起動し、失敗したら asr_stopped にする。
}

/// 語彙ヒントを ASR の context に渡す形 (空白区切り) にする。
pub fn vocabulary_context(vocabulary: &[String]) -> Option<String> {
    let s = vocabulary
        .iter()
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    (!s.is_empty()).then_some(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vocabulary_joined_with_spaces() {
        assert_eq!(vocabulary_context(&[]), None);
        assert_eq!(
            vocabulary_context(&["Tauri".into(), " ".into(), "mukuchi".into()]).as_deref(),
            Some("Tauri mukuchi")
        );
    }
}
