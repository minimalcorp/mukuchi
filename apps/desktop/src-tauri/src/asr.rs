//! ASRサーバーのクライアント (HTTP API は docs/architecture.md)。
//!
//! パイプライン・セットアップは `AsrBackend` だけを見る。実装は OS で選ぶ (`connect`):
//! Mac は Python + MLX のサーバー (`/transcribe`、`HttpAsrClient`)、Windows は llama-server
//! (`/v1/chat/completions`、llama.rs の `LlamaClient`)。プロセスの起動・自動再起動は asr_process.rs。
//!
//! 開発時 (デバッグビルドのみ) は環境変数 `MUKUCHI_ASR_URL` のサーバーに接続するだけで、自分では起動しない。
//!
//! リクエストの URL には認識のヒント (`context`) が含まれるため、reqwest のエラーは `without_url()` で
//! URL を外してからログ・画面に出す。

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use serde::Deserialize;

use crate::i18n::Locale;

pub const ENV_ASR_URL: &str = "MUKUCHI_ASR_URL";

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

/// 文字起こしの結果
#[derive(Debug, Clone, PartialEq)]
pub struct Transcript {
    pub text: String,
    /// 処理時間 (受信完了から応答まで。推論待ちを含む)。Mac はサーバーの報告 (古いサーバーでは無い)、
    /// Windows はクライアントで測った値
    pub server_ms: Option<u64>,
}

/// 文字起こしの実装。テストや OS ごとの実装に差し替えられるようにtraitにする。
pub trait AsrBackend: Send + Sync {
    /// 接続先 (ログ用)
    fn base_url(&self) -> &str;

    /// 準備完了 (モデルの読み込み済み) なら、読み込み済みのモデル名 (分からなければ空) を返す
    fn health(&self) -> BoxFuture<Result<String>>;

    /// 16kHz/mono/16bit の WAV を送り、認識結果を返す。`language` は話す言語 (常に明示する。
    /// 省くとサーバーの自動判定になり、英語の精度が大きく崩れるため)
    fn transcribe(
        &self,
        wav: Vec<u8>,
        language: Locale,
        context: Option<String>,
    ) -> BoxFuture<Result<Transcript>>;
}

/// ベース URL のサーバーに接続するクライアント (OS の ASR の実装)
pub fn connect(base: impl Into<String>) -> Result<Arc<dyn AsrBackend>> {
    #[cfg(not(target_os = "windows"))]
    return Ok(Arc::new(HttpAsrClient::new(base)?));
    #[cfg(target_os = "windows")]
    return Ok(Arc::new(crate::llama::LlamaClient::new(base)?));
}

#[derive(Debug, Deserialize)]
struct HealthResponse {
    status: String,
    model: Option<String>,
}

/// ループバックのサーバー用の HTTP クライアント
pub(crate) fn loopback_http_client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        // ループバックへの接続にプロキシを使わない
        .no_proxy()
        // サーバー (uvicorn) は5秒で待機中の接続を閉じる。閉じかけの接続を再利用して
        // 失敗しないよう、それより早く手放す
        .pool_idle_timeout(Duration::from_secs(2))
        .build()
        .context("HTTPクライアントを作成できません")
}

/// `/health` が ok を返せば、読み込み済みのモデル名を返す (llama-server は model を返さないため空)。
/// 読み込み中は Mac のサーバーは応答せず、llama-server は 503 を返す
pub(crate) async fn health(http: &reqwest::Client, base: &str) -> Result<String> {
    let res = http
        .get(format!("{base}/health"))
        .timeout(Duration::from_secs(3))
        .send()
        .await
        .map_err(reqwest::Error::without_url)
        .context("ASRサーバーに接続できません")?
        .error_for_status()
        .map_err(reqwest::Error::without_url)
        .context("ASRサーバーの /health がエラー")?;
    let h: HealthResponse = res
        .json()
        .await
        .map_err(reqwest::Error::without_url)
        .context("/health の応答が不正")?;
    if h.status != "ok" {
        anyhow::bail!("ASRサーバーの状態: {}", h.status);
    }
    Ok(h.model.unwrap_or_default())
}

/// Mac の ASR サーバー (Python + MLX。`/transcribe`)
#[cfg(not(target_os = "windows"))]
#[derive(Debug, Deserialize)]
struct TranscribeResponse {
    text: String,
    elapsed_ms: Option<u64>,
}

#[cfg(not(target_os = "windows"))]
#[derive(Clone)]
pub struct HttpAsrClient {
    base: String,
    http: reqwest::Client,
}

#[cfg(not(target_os = "windows"))]
impl HttpAsrClient {
    pub fn new(base: impl Into<String>) -> Result<Self> {
        Ok(Self {
            base: base.into().trim_end_matches('/').to_string(),
            http: loopback_http_client()?,
        })
    }
}

#[cfg(not(target_os = "windows"))]
impl AsrBackend for HttpAsrClient {
    fn base_url(&self) -> &str {
        &self.base
    }

    fn health(&self) -> BoxFuture<Result<String>> {
        let this = self.clone();
        Box::pin(async move { health(&this.http, &this.base).await })
    }

    fn transcribe(
        &self,
        wav: Vec<u8>,
        language: Locale,
        context: Option<String>,
    ) -> BoxFuture<Result<Transcript>> {
        let this = self.clone();
        Box::pin(async move {
            let mut query: Vec<(&str, String)> =
                vec![("language", language.asr_language().to_string())];
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
                .map_err(reqwest::Error::without_url)
                .context("ASRサーバーに接続できません")?;
            let status = res.status();
            if !status.is_success() {
                // 本文はサーバーのエラー詳細 (WAV形式違い等)。念のため長さを制限する
                let body: String = res
                    .text()
                    .await
                    .unwrap_or_default()
                    .chars()
                    .take(200)
                    .collect();
                anyhow::bail!("ASRサーバーがエラーを返しました: {status} {body}");
            }
            let r: TranscribeResponse = res
                .json()
                .await
                .map_err(reqwest::Error::without_url)
                .context("/transcribe の応答が不正")?;
            log::info!(
                "文字起こし: {bytes}B, サーバー {}ms, 往復 {}ms",
                r.elapsed_ms.unwrap_or(0),
                started.elapsed().as_millis()
            );
            Ok(Transcript {
                text: r.text,
                server_ms: r.elapsed_ms,
            })
        })
    }
}

/// 接続先の決定。開発時 (デバッグビルド) は環境変数、本番はサーバーを起動する (P4)。
pub fn resolve_endpoint() -> Option<String> {
    // 本番ビルドでは環境変数を見ない (音声と認識のヒントを外部へ送らせないため)
    if !cfg!(debug_assertions) {
        return None;
    }
    let url = std::env::var(ENV_ASR_URL).ok().filter(|s| !s.is_empty())?;
    match loopback_http_url(&url) {
        Ok(u) => Some(u),
        Err(e) => {
            log::error!("{ENV_ASR_URL} を無視する: {e:#}");
            None
        }
    }
    // TODO(P4): 本番は空きポートを選び、データディレクトリの venv で
    // `mukuchi-asr --port <port> --exit-on-stdin-eof` を起動して /health を待つ。
    // 異常終了時は3回まで自動再起動し、失敗したら asr_stopped にする。
}

/// ループバック (127.0.0.0/8・::1・localhost) の http URL だけを受け付ける。
fn loopback_http_url(s: &str) -> Result<String> {
    let url = reqwest::Url::parse(s).context("URLが不正")?;
    if url.scheme() != "http" {
        anyhow::bail!("http 以外のスキーム: {}", url.scheme());
    }
    let ok = match url.host() {
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        None => false,
    };
    if !ok {
        anyhow::bail!("ループバック以外のホスト");
    }
    Ok(url.as_str().trim_end_matches('/').to_string())
}

/// 認識のヒント (`Settings.asr_context`) を ASR の context に渡す形にする。
/// 文章には手を加えず前後の空白だけ除く (Qwen3-ASR のシステムメッセージにそのまま入るため)。空なら送らない。
pub fn asr_context(text: &str) -> Option<String> {
    let s = text.trim();
    (!s.is_empty()).then(|| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_loopback_urls_are_accepted() {
        assert_eq!(
            loopback_http_url("http://127.0.0.1:18765/").unwrap(),
            "http://127.0.0.1:18765"
        );
        assert!(loopback_http_url("http://localhost:1").is_ok());
        assert!(loopback_http_url("http://[::1]:1").is_ok());
        assert!(loopback_http_url("http://example.com:18765").is_err());
        assert!(loopback_http_url("http://192.168.1.2:18765").is_err());
        assert!(loopback_http_url("https://127.0.0.1:1").is_err());
        assert!(loopback_http_url("nonsense").is_err());
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn errors_do_not_contain_query() {
        // context (認識のヒント) を含む URL がエラー文言に出ないこと
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let client = HttpAsrClient::new("http://127.0.0.1:9").unwrap();
        let err = rt
            .block_on(client.transcribe(vec![0; 10], Locale::Ja, Some("ひみつのヒント".into())))
            .unwrap_err();
        let msg = format!("{err:#}");
        assert!(!msg.contains("127.0.0.1"), "{msg}");
        assert!(!msg.contains("context"), "{msg}");
    }

    #[test]
    fn asr_context_is_trimmed_and_otherwise_verbatim() {
        assert_eq!(asr_context(""), None);
        assert_eq!(asr_context(" \n\t "), None);
        assert_eq!(
            asr_context("  Tauri と mukuchi の話。\n固有名詞: Qwen3-ASR \n").as_deref(),
            Some("Tauri と mukuchi の話。\n固有名詞: Qwen3-ASR")
        );
    }
}
