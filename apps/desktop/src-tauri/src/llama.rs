//! Windows の文字起こし: llama.cpp の `llama-server` (docs/architecture.md「ASR (Windows)」)。
//!
//! - 起動: 同梱の Vulkan 版 (GPU) か、CPU 実行に同意した時だけ取得する CPU 版。`--device` は GPU の判定 (gpu.rs) が
//!   選んだ 1 つに固定する。起動・自動再起動・ログは Mac と同じ `asr_process` が行い、ここは引数と起動の作法だけ
//! - 認識: `POST /v1/chat/completions` に WAV (base64) を送る。話す言語は assistant の prefill
//!   (`language <Japanese|English><asr_text>`) で常に明示する (spikes/asr-bench/windows/bench.py と同じ形)
//! - 暴走の防止: `max_tokens` を音声の長さから見積もって制限し、繰り返し・定型ハルシネーションは捨てる (asr_filters.rs)
//! - 推論は直列にする (サーバーは複数のスロットで並行に処理しうるが、Mac と同じく1つずつにして確定を遅らせない)
//!
//! 認識した文章・認識のヒント (context) はログに出さない (文字数等のメタ情報のみ)。

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine as _;
use serde::Deserialize;

use crate::asr::{AsrBackend, BoxFuture, Transcript};
use crate::asr_filters::{is_hallucination_phrase, is_runaway_repetition};
use crate::asr_process::{free_port, open_log};
use crate::i18n::Locale;
use crate::platform::process;

/// 同梱・取得する llama.cpp の版 (spikes/asr-bench/WINDOWS_DECISION.md で検証した版)
pub const TAG: &str = "b11408";
/// 同梱の Vulkan 版の zip の sha256 (apps/desktop/scripts/fetch-llama-server.mjs の SHA256 と同じ値)
pub const VULKAN_ZIP_SHA256: &str =
    "2400e21263c745be6e4d0ca1d91206f0050cf6477b284a508effb8284d7270fd";
/// CPU 実行に同意した時だけ取得する CPU 版
pub const CPU_ZIP: &str = "llama-b11408-bin-win-cpu-x64.zip";
/// GitHub Release の asset の digest と、取得した zip の計算値が一致することを確かめて転記した値
pub const CPU_ZIP_SHA256: &str = "3ee8abdf3320b6520273a3161da1b8cb061ccec913d72cbed5916c7f9894d075";
pub const CPU_ZIP_URL: &str =
    "https://github.com/ggml-org/llama.cpp/releases/download/b11408/llama-b11408-bin-win-cpu-x64.zip";

pub const SERVER_EXE: &str = "llama-server.exe";

/// 同梱物の版 (provisioned.json の runtime.version)。同梱の llama-server が変わった時に導入 (動作確認) をやり直す
pub fn runtime_version() -> String {
    format!("llama.cpp-{TAG}+vulkan-{VULKAN_ZIP_SHA256}")
}

/// コンテキスト長。音声 30 秒で約 400 トークン + 出力のため 4096 で足りる (bench.py と同じ)
const CONTEXT: &str = "4096";
/// llama-server の --list-devices の上限 (Vulkan の初期化に数秒かかる)
const LIST_DEVICES_TIMEOUT: Duration = Duration::from_secs(60);
/// 推論は直列のため、前の発話の処理待ちも含めて余裕を持たせる (Mac の /transcribe と同じ)
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

// ---- 起動 ---------------------------------------------------------------------

/// 推論の実行先
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Exec {
    /// Vulkan 版。`device` は `--device` に渡す名前 (`Vulkan0` 等)。分からなければ指定しない
    Gpu { device: Option<String> },
    /// CPU 版 (`-ngl 0 --no-mmproj-offload`)
    Cpu,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchSpec {
    /// llama-server.exe
    pub exe: PathBuf,
    /// LLM の GGUF
    pub model: PathBuf,
    /// 音声エンコーダ (mmproj) の GGUF
    pub mmproj: PathBuf,
    pub exec: Exec,
    pub log_file: PathBuf,
}

/// 選択中の GGUF と、GPU の判定 (gpu.rs) で決まる llama-server・実行先で起動方法を作る
pub fn launch_spec(
    hf_home: &Path,
    model: &crate::provisioning::hf::HfModel,
    gpu: &crate::gpu::GpuManager,
    log_file: PathBuf,
) -> LaunchSpec {
    let (exe, exec) = gpu.exec();
    // 揃っていなければ起動が「モデルがありません」で失敗する (未導入は呼び出し側が先に弾く)
    let (model_file, mmproj) = model.gguf_files(hf_home).unwrap_or_else(|| {
        let snap = model.snapshot_dir(hf_home);
        (snap.join("model.gguf"), snap.join("mmproj.gguf"))
    });
    LaunchSpec {
        exe,
        model: model_file,
        mmproj,
        exec,
        log_file,
    }
}

/// llama-server の引数 (docs/architecture.md「ASR (Windows)」の起動)
pub fn server_args(spec: &LaunchSpec, port: u16) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec![
        "-m".into(),
        spec.model.clone().into(),
        "--mmproj".into(),
        spec.mmproj.clone().into(),
    ];
    match &spec.exec {
        Exec::Gpu { device } => {
            if let Some(d) = device {
                // 複数の GPU に分割されたり内蔵 GPU に落ちたりしないよう 1 つに固定する
                args.extend(["--device".into(), d.into()]);
            }
            args.extend(["-ngl".into(), "99".into()]);
        }
        Exec::Cpu => args.extend(["-ngl".into(), "0".into(), "--no-mmproj-offload".into()]),
    }
    args.extend(
        [
            "--port",
            &port.to_string(),
            "--host",
            "127.0.0.1",
            "-c",
            CONTEXT,
            "--no-webui",
            // スロットの監視 (/slots) を出さない。プロンプト (認識のヒント) を他のプロセス・ブラウザから読ませないため
            "--no-slots",
            // 推論はクライアントで1つずつにするため、スロットを分けてコンテキストを細切れにしない
            "-np",
            "1",
        ]
        .map(OsString::from),
    );
    args
}

/// llama-server が API キーを読む環境変数 (`llama-server --help` の `--api-key` の env。b11408 で確認)。
/// コマンドラインに置くと他のプロセスから読めるため環境変数で渡す
const ENV_API_KEY: &str = "LLAMA_API_KEY";

/// 起動したサーバーの API キー (ベース URL ごと)。`LlamaClient::new` が URL から引く。
/// llama-server は CORS で全オリジンを許すため、ブラウザ・他のプロセスからの推論の要求をキーで拒む。
/// キーはログに出さない
static API_KEYS: std::sync::Mutex<Vec<(String, String)>> = std::sync::Mutex::new(Vec::new());

fn api_key_for(base: &str) -> Option<String> {
    API_KEYS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .iter()
        .find(|(b, _)| b == base)
        .map(|(_, k)| k.clone())
}

fn register_api_key(base: &str, key: String) {
    let mut keys = API_KEYS.lock().unwrap_or_else(|p| p.into_inner());
    keys.retain(|(b, _)| b != base);
    // 起動し直しのたびに増えないよう、古いものは捨てる (使うのは直近のサーバーだけ)
    if keys.len() >= 8 {
        keys.remove(0);
    }
    keys.push((base.to_string(), key));
}

/// 起動ごとの API キー (OS の乱数 32 バイトの16進)
fn new_api_key() -> Result<String> {
    let mut b = [0u8; 32];
    getrandom::fill(&mut b).map_err(|e| anyhow!("乱数を取得できません: {e}"))?;
    Ok(hex::encode(b))
}

/// 起動する (asr_process から呼ぶ)。標準出力・標準エラーはログへ
pub fn spawn(spec: &LaunchSpec) -> Result<(tokio::process::Child, String)> {
    for (what, p) in [
        ("文字起こしエンジン", &spec.exe),
        ("モデル", &spec.model),
        ("モデル (mmproj)", &spec.mmproj),
    ] {
        if !p.is_file() {
            bail!("{what}がありません: {}", p.display());
        }
    }
    let port = free_port()?;
    let base = format!("http://127.0.0.1:{port}");
    let key = new_api_key()?;
    let log = open_log(&spec.log_file)?;
    let log_err = log.try_clone()?;
    let mut cmd = tokio::process::Command::new(&spec.exe);
    cmd.args(server_args(spec, port))
        // DLL は実行ファイルと同じディレクトリから読まれる。作業ディレクトリも合わせる
        .current_dir(spec.exe.parent().unwrap_or(Path::new(".")))
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err))
        .kill_on_drop(true);
    process::configure(&mut cmd);
    cmd.env(ENV_API_KEY, &key);
    let child = cmd
        .spawn()
        .with_context(|| format!("起動できません: {}", spec.exe.display()))?;
    process::assign_to_job(&child);
    register_api_key(&base, key);
    log::info!(
        "文字起こしサーバー (llama-server) を起動: pid={:?} port={port} exec={:?}",
        child.id(),
        spec.exec
    );
    Ok((child, base))
}

// ---- デバイスの列挙 -------------------------------------------------------------

/// `llama-server --list-devices` の 1 行 (`Vulkan0: NVIDIA GeForce RTX 3080 Ti (12084 MiB, 11316 MiB free)`)
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListedDevice {
    /// `--device` に渡す名前
    pub id: String,
    pub name: String,
    pub total_mib: Option<u64>,
}

/// `--list-devices` の出力を読む。`(none)` や解釈できない行は無視する
pub fn parse_list_devices(out: &str) -> Vec<ListedDevice> {
    out.lines()
        .filter_map(|line| {
            let (id, rest) = line.trim().split_once(':')?;
            let id = id.trim();
            // `Vulkan0` 等 (英字 + 番号)。見出し (`Available devices`) を除く
            let digits = id.trim_start_matches(|c: char| c.is_ascii_alphabetic());
            if digits.is_empty()
                || digits.len() == id.len()
                || !digits.chars().all(|c| c.is_ascii_digit())
            {
                return None;
            }
            let rest = rest.trim();
            let (name, total_mib) = match rest.rfind(" (") {
                Some(i) if rest.ends_with(')') => {
                    let mem = &rest[i + 2..rest.len() - 1];
                    let total = mem
                        .split(',')
                        .next()
                        .and_then(|m| m.trim().strip_suffix("MiB"))
                        .and_then(|m| m.trim().parse().ok());
                    (rest[..i].trim(), total)
                }
                _ => (rest, None),
            };
            (!name.is_empty()).then(|| ListedDevice {
                id: id.to_string(),
                name: name.to_string(),
                total_mib,
            })
        })
        .collect()
}

/// 同梱の llama-server で推論に使えるデバイスを列挙する (GPU の判定の (b))。
/// 起動できない (DLL が足りない等) 場合はエラー
pub async fn list_devices(exe: &Path) -> Result<Vec<ListedDevice>> {
    if !exe.is_file() {
        bail!("文字起こしエンジンがありません: {}", exe.display());
    }
    let mut cmd = tokio::process::Command::new(exe);
    cmd.arg("--list-devices")
        .current_dir(exe.parent().unwrap_or(Path::new(".")))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    process::configure(&mut cmd);
    let child = cmd
        .spawn()
        .with_context(|| format!("起動できません: {}", exe.display()))?;
    process::assign_to_job(&child);
    let out = tokio::time::timeout(LIST_DEVICES_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| anyhow!("--list-devices が終わりません"))?
        .context("--list-devices の結果を読めません")?;
    if !out.status.success() {
        bail!(
            "--list-devices が失敗: {} {}",
            out.status,
            String::from_utf8_lossy(&out.stderr)
                .chars()
                .take(300)
                .collect::<String>()
        );
    }
    // 列挙は標準出力に出る (b11408 で確認)。版による違いに備えて標準エラーも読む
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.push('\n');
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    Ok(parse_list_devices(&text))
}

// ---- 認識 ---------------------------------------------------------------------

/// 出力トークンの上限の見積もり: 固定分 + 音声1秒あたり。日本語の速い発話 (約10文字/秒) でも
/// 届かず、暴走 (無音で上限まで同じ語句を繰り返す) は短く打ち切れる値にする
const MAX_TOKENS_BASE: f64 = 24.0;
const MAX_TOKENS_PER_SEC: f64 = 15.0;
/// 上限の上限 (コンテキスト 4096 から音声のトークンを除いた範囲に収める)
const MAX_TOKENS_CAP: u32 = 2048;

pub fn max_tokens_for(secs: f64) -> u32 {
    let n = (MAX_TOKENS_BASE + MAX_TOKENS_PER_SEC * secs.max(0.0)).ceil();
    (n as u32).min(MAX_TOKENS_CAP)
}

/// WAV の長さ (秒)
fn wav_secs(wav: &[u8]) -> Result<f64> {
    let r = hound::WavReader::new(std::io::Cursor::new(wav)).context("WAVが不正")?;
    let spec = r.spec();
    if spec.sample_rate == 0 {
        bail!("WAVのサンプリング周波数が不正");
    }
    Ok(r.duration() as f64 / spec.sample_rate as f64)
}

/// assistant の prefill。話す言語を常に明示する (省くと言語の判定が揺れる)
fn prefill(language: Locale) -> String {
    format!("language {}<asr_text>", language.asr_language())
}

/// `/v1/chat/completions` の本文。`context` (認識のヒント) は system メッセージ (空なら付けない)
pub fn request_body(
    wav_base64: &str,
    language: Locale,
    context: Option<&str>,
    max_tokens: u32,
) -> serde_json::Value {
    let mut messages = Vec::new();
    if let Some(c) = context.filter(|c| !c.is_empty()) {
        messages.push(serde_json::json!({ "role": "system", "content": c }));
    }
    messages.push(serde_json::json!({
        "role": "user",
        "content": [{ "type": "input_audio", "input_audio": { "data": wav_base64, "format": "wav" } }],
    }));
    messages.push(serde_json::json!({ "role": "assistant", "content": prefill(language) }));
    serde_json::json!({
        "messages": messages,
        "temperature": 0,
        "max_tokens": max_tokens,
        // prefill の続きを生成させる (新しい assistant の発話を始めさせない)
        "continue_final_message": true,
        "add_generation_prompt": false,
    })
}

/// 応答の先頭の `language <X><asr_text>` (prefill。応答に含まれて返る) を除く
pub fn strip_language_prefix(content: &str) -> &str {
    let s = content.trim_start();
    if let Some(rest) = s.strip_prefix("language") {
        if let Some(i) = rest.find("<asr_text>") {
            // `language Japanese` の言語名の部分に空白以外の区切りが無いことを確かめる (本文の誤検出を避ける)
            if rest[..i].trim().chars().all(|c| c.is_alphanumeric()) {
                return &rest[i + "<asr_text>".len()..];
            }
        }
    }
    s.strip_prefix("<asr_text>").unwrap_or(s)
}

#[derive(Debug, Deserialize)]
struct ChatResponse {
    choices: Vec<Choice>,
}

#[derive(Debug, Deserialize)]
struct Choice {
    message: ChoiceMessage,
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ChoiceMessage {
    content: Option<String>,
}

/// 何を捨てたか (ログ用。文章は出さない)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dropped {
    Repetition,
    Hallucination,
}

/// 応答の文章を整え、暴走・定型ハルシネーションなら空にする
pub fn clean_text(content: &str) -> (String, Option<Dropped>) {
    let text = strip_language_prefix(content).trim();
    if is_runaway_repetition(text) {
        return (String::new(), Some(Dropped::Repetition));
    }
    if is_hallucination_phrase(text) {
        return (String::new(), Some(Dropped::Hallucination));
    }
    (text.to_string(), None)
}

/// llama-server のクライアント
#[derive(Clone)]
pub struct LlamaClient {
    base: String,
    http: reqwest::Client,
    /// 推論を1つずつにする (同じサーバーへのクライアントで共有する)
    serial: Arc<tokio::sync::Mutex<()>>,
    /// 自分で起動したサーバーの API キー。外部のサーバー (開発の MUKUCHI_ASR_URL) は None
    api_key: Option<String>,
}

impl LlamaClient {
    pub fn new(base: impl Into<String>) -> Result<Self> {
        let base = base.into().trim_end_matches('/').to_string();
        Ok(Self {
            api_key: api_key_for(&base),
            base,
            http: crate::asr::loopback_http_client()?,
            serial: Arc::new(tokio::sync::Mutex::new(())),
        })
    }
}

impl AsrBackend for LlamaClient {
    fn base_url(&self) -> &str {
        &self.base
    }

    fn health(&self) -> BoxFuture<Result<String>> {
        let this = self.clone();
        Box::pin(async move { crate::asr::health(&this.http, &this.base).await })
    }

    fn transcribe(
        &self,
        wav: Vec<u8>,
        language: Locale,
        context: Option<String>,
    ) -> BoxFuture<Result<Transcript>> {
        let this = self.clone();
        Box::pin(async move {
            // 推論待ちを含めて測る (Mac のサーバーの elapsed_ms と同じ意味。途中表示の見積もりの学習に使う)
            let started = Instant::now();
            let secs = wav_secs(&wav)?;
            let max_tokens = max_tokens_for(secs);
            let audio = base64::engine::general_purpose::STANDARD.encode(&wav);
            drop(wav);
            let body = request_body(&audio, language, context.as_deref(), max_tokens);
            drop(audio);
            let _turn = this.serial.lock().await;
            let mut req = this.http.post(format!("{}/v1/chat/completions", this.base));
            if let Some(k) = &this.api_key {
                req = req.bearer_auth(k);
            }
            let res = req
                .json(&body)
                .timeout(REQUEST_TIMEOUT)
                .send()
                .await
                .map_err(reqwest::Error::without_url)
                .context("ASRサーバーに接続できません")?;
            let status = res.status();
            if !status.is_success() {
                // 本文はサーバーのエラー詳細 (コンテキスト超過等)。念のため長さを制限する
                let body: String = res
                    .text()
                    .await
                    .unwrap_or_default()
                    .chars()
                    .take(200)
                    .collect();
                bail!("ASRサーバーがエラーを返しました: {status} {body}");
            }
            let r: ChatResponse = res
                .json()
                .await
                .map_err(reqwest::Error::without_url)
                .context("/v1/chat/completions の応答が不正")?;
            drop(_turn);
            let choice = r
                .choices
                .into_iter()
                .next()
                .ok_or_else(|| anyhow!("/v1/chat/completions の応答に choices がない"))?;
            let truncated = choice.finish_reason.as_deref() == Some("length");
            let (text, dropped) = clean_text(choice.message.content.as_deref().unwrap_or(""));
            let elapsed = started.elapsed().as_millis() as u64;
            log::info!(
                "文字起こし: 音声 {secs:.2}秒, {}文字, {elapsed}ms (上限 {max_tokens} トークン{}{})",
                text.chars().count(),
                if truncated { "、上限で打ち切り" } else { "" },
                match dropped {
                    Some(Dropped::Repetition) => "、繰り返しのため破棄",
                    Some(Dropped::Hallucination) => "、定型ハルシネーションのため破棄",
                    None => "",
                }
            );
            Ok(Transcript {
                text,
                server_ms: Some(elapsed),
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_devices_output_is_parsed() {
        // 実測 (WINDOWS_DECISION.md・b11408)
        let out = "Available devices:\n  Vulkan0: NVIDIA GeForce RTX 3080 Ti (12084 MiB, 11316 MiB free)\n";
        assert_eq!(
            parse_list_devices(out),
            vec![ListedDevice {
                id: "Vulkan0".into(),
                name: "NVIDIA GeForce RTX 3080 Ti".into(),
                total_mib: Some(12084),
            }]
        );
        assert!(parse_list_devices("Available devices:\n  (none)\n").is_empty());
        assert!(parse_list_devices("").is_empty());
        // 複数・括弧を含む名前・メモリの無い行・ログの行
        let out = "ggml_vulkan: Found 2 Vulkan devices:\nAvailable devices:\n  Vulkan0: Intel(R) UHD Graphics 770 (16290 MiB, 15000 MiB free)\n  Vulkan1: AMD Radeon(TM) RX 7600\n";
        assert_eq!(
            parse_list_devices(out),
            vec![
                ListedDevice {
                    id: "Vulkan0".into(),
                    name: "Intel(R) UHD Graphics 770".into(),
                    total_mib: Some(16290),
                },
                ListedDevice {
                    id: "Vulkan1".into(),
                    name: "AMD Radeon(TM) RX 7600".into(),
                    total_mib: None,
                },
            ]
        );
    }

    #[test]
    fn args_follow_architecture() {
        let spec = |exec| LaunchSpec {
            exe: PathBuf::from(r"C:\app\llama-server\llama-server.exe"),
            model: PathBuf::from(r"C:\m\a.gguf"),
            mmproj: PathBuf::from(r"C:\m\mmproj-a.gguf"),
            exec,
            log_file: PathBuf::from(r"C:\logs\asr-server.log"),
        };
        let s = |v: Vec<OsString>| {
            v.iter()
                .map(|a| a.to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join(" ")
        };
        assert_eq!(
            s(server_args(
                &spec(Exec::Gpu {
                    device: Some("Vulkan1".into())
                }),
                1234
            )),
            r"-m C:\m\a.gguf --mmproj C:\m\mmproj-a.gguf --device Vulkan1 -ngl 99 --port 1234 --host 127.0.0.1 -c 4096 --no-webui --no-slots -np 1"
        );
        assert_eq!(
            s(server_args(&spec(Exec::Cpu), 1234)),
            r"-m C:\m\a.gguf --mmproj C:\m\mmproj-a.gguf -ngl 0 --no-mmproj-offload --port 1234 --host 127.0.0.1 -c 4096 --no-webui --no-slots -np 1"
        );
        assert_eq!(
            s(server_args(&spec(Exec::Gpu { device: None }), 1)),
            r"-m C:\m\a.gguf --mmproj C:\m\mmproj-a.gguf -ngl 99 --port 1 --host 127.0.0.1 -c 4096 --no-webui --no-slots -np 1"
        );
    }

    #[test]
    fn api_key_is_per_server() {
        let k = new_api_key().unwrap();
        assert_eq!(k.len(), 64);
        assert_ne!(k, new_api_key().unwrap());
        register_api_key("http://127.0.0.1:1", "a".into());
        register_api_key("http://127.0.0.1:1", "b".into());
        assert_eq!(api_key_for("http://127.0.0.1:1").as_deref(), Some("b"));
        assert_eq!(
            LlamaClient::new("http://127.0.0.1:1/")
                .unwrap()
                .api_key
                .as_deref(),
            Some("b")
        );
        assert_eq!(
            LlamaClient::new("http://127.0.0.1:2").unwrap().api_key,
            None
        );
    }

    #[test]
    fn max_tokens_scales_with_audio() {
        assert_eq!(max_tokens_for(0.0), 24);
        assert_eq!(max_tokens_for(1.0), 39);
        assert_eq!(max_tokens_for(3.0), 69);
        // 実測の暴走 (無音 3 秒で 256 トークン) より十分小さい
        assert!(max_tokens_for(3.0) < 256 / 2);
        // 日本語の速い発話 (10 文字/秒、1 文字 1 トークンとして) でも足りる
        for secs in [0.5, 2.0, 10.0, 30.0] {
            assert!(max_tokens_for(secs) as f64 >= secs * 10.0 + 10.0, "{secs}");
        }
        assert_eq!(max_tokens_for(10_000.0), MAX_TOKENS_CAP);
        assert_eq!(max_tokens_for(-1.0), 24);
    }

    #[test]
    fn request_body_matches_bench() {
        let b = request_body("QUJD", Locale::Ja, Some("固有名詞: mukuchi"), 39);
        assert_eq!(
            b,
            serde_json::json!({
                "messages": [
                    {"role": "system", "content": "固有名詞: mukuchi"},
                    {"role": "user", "content": [{"type": "input_audio", "input_audio": {"data": "QUJD", "format": "wav"}}]},
                    {"role": "assistant", "content": "language Japanese<asr_text>"},
                ],
                "temperature": 0,
                "max_tokens": 39,
                "continue_final_message": true,
                "add_generation_prompt": false,
            })
        );
        let b = request_body("QUJD", Locale::En, Some(""), 24);
        let msgs = b["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 2, "空の context は付けない");
        assert_eq!(msgs[1]["content"], "language English<asr_text>");
        assert_eq!(
            request_body("x", Locale::En, None, 1)["messages"][0]["role"],
            "user"
        );
    }

    #[test]
    fn language_prefix_is_stripped() {
        assert_eq!(
            strip_language_prefix("language Japanese<asr_text>確定。"),
            "確定。"
        );
        assert_eq!(
            strip_language_prefix("language English<asr_text> Hello."),
            " Hello."
        );
        assert_eq!(strip_language_prefix("language None<asr_text>"), "");
        assert_eq!(strip_language_prefix("<asr_text>こんにちは"), "こんにちは");
        assert_eq!(strip_language_prefix("こんにちは"), "こんにちは");
        // 本文が language で始まる
        assert_eq!(
            strip_language_prefix("language models are <asr_text> x"),
            "language models are <asr_text> x"
        );
    }

    #[test]
    fn clean_text_drops_runaway_and_phrases() {
        assert_eq!(
            clean_text("language Japanese<asr_text> 確定。 "),
            ("確定。".to_string(), None)
        );
        assert_eq!(
            clean_text(&format!(
                "language Japanese<asr_text>{}",
                "自分の心に".repeat(40)
            )),
            (String::new(), Some(Dropped::Repetition))
        );
        assert_eq!(
            clean_text("language Japanese<asr_text>ご視聴ありがとうございました。"),
            (String::new(), Some(Dropped::Hallucination))
        );
    }

    #[test]
    fn errors_do_not_contain_url_or_context() {
        tauri::async_runtime::block_on(async {
            let client = LlamaClient::new("http://127.0.0.1:9").unwrap();
            let wav = crate::audio::encode_wav_16k(&[0.0; 1600]).unwrap();
            let err = client
                .transcribe(wav, Locale::Ja, Some("ひみつのヒント".into()))
                .await
                .unwrap_err();
            let msg = format!("{err:#}");
            assert!(!msg.contains("127.0.0.1"), "{msg}");
            assert!(!msg.contains("ひみつ"), "{msg}");
        });
    }

    /// 手動の確認 (`cargo test -- --ignored real_api_key_required --nocapture`): 起動したサーバーは API キーの無い
    /// 推論の要求を 401 で拒み、キー付き (LlamaClient) なら認識できること。/health はキーなしで応答すること。
    /// 環境変数は real_runaway_is_cut と同じ。`MUKUCHI_IT_WAV` (認識する WAV)
    #[test]
    #[ignore]
    fn real_api_key_required() {
        use crate::asr_process::AsrProcess;
        let env = |k: &str| PathBuf::from(std::env::var_os(k).unwrap_or_else(|| panic!("{k}")));
        let dir = env("MUKUCHI_IT_GGUF_DIR");
        let names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        let (model, mmproj) =
            crate::provisioning::hf::gguf_pair(names.iter().map(String::as_str)).unwrap();
        let tmp = tempfile::tempdir().unwrap();
        let spec = LaunchSpec {
            exe: env("MUKUCHI_IT_LLAMA_DIR").join(SERVER_EXE),
            model: dir.join(model),
            mmproj: dir.join(mmproj),
            exec: Exec::Gpu { device: None },
            log_file: tmp.path().join("asr-server.log"),
        };
        tauri::async_runtime::block_on(async {
            let asr = std::sync::Arc::new(AsrProcess::new());
            asr.start(spec, false).await;
            let (_tx, rx) = tokio::sync::watch::channel(false);
            let url = asr.wait_ready(rx).await.unwrap();
            let wav = std::fs::read(env("MUKUCHI_IT_WAV")).unwrap();
            let http = reqwest::Client::new();
            let body = request_body(
                &base64::engine::general_purpose::STANDARD.encode(&wav),
                Locale::Ja,
                None,
                64,
            );
            let no_key = http
                .post(format!("{url}/v1/chat/completions"))
                .json(&body)
                .send()
                .await
                .unwrap()
                .status();
            println!("キーなし: {no_key}");
            assert_eq!(no_key.as_u16(), 401);
            let wrong = http
                .post(format!("{url}/v1/chat/completions"))
                .bearer_auth("wrong")
                .json(&body)
                .send()
                .await
                .unwrap()
                .status();
            assert_eq!(wrong.as_u16(), 401);
            let slots = http
                .get(format!("{url}/slots"))
                .send()
                .await
                .unwrap()
                .status();
            println!("/slots: {slots}");
            assert!(!slots.is_success());
            let health = http
                .get(format!("{url}/health"))
                .send()
                .await
                .unwrap()
                .status();
            println!("/health (キーなし): {health}");
            assert!(health.is_success());
            let c = LlamaClient::new(url).unwrap();
            c.health().await.unwrap();
            let r = c.transcribe(wav, Locale::Ja, None).await.unwrap();
            println!("キーあり: 「{}」", r.text);
            assert!(!r.text.is_empty());
            let log = std::fs::read_to_string(tmp.path().join("asr-server.log")).unwrap();
            assert!(
                !log.contains(c.api_key.as_deref().unwrap()),
                "キーをログに出さない"
            );
            asr.stop().await;
        });
    }

    /// 手動の確認 (`cargo test -- --ignored real_runaway_is_cut --nocapture`): 元の Qwen (base-gguf) に無音を
    /// 日本語指定で送ると暴走する (WINDOWS_DECISION.md) 入力で、上限で打ち切られ、繰り返しとして捨てられること。
    /// `MUKUCHI_IT_LLAMA_DIR` (同梱の llama-server/)、`MUKUCHI_IT_GGUF_DIR` (LLM と mmproj の GGUF があるディレクトリ)
    #[test]
    #[ignore]
    fn real_runaway_is_cut() {
        use crate::asr_process::AsrProcess;
        let env = |k: &str| PathBuf::from(std::env::var_os(k).unwrap_or_else(|| panic!("{k}")));
        let dir = env("MUKUCHI_IT_GGUF_DIR");
        let names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        let (model, mmproj) =
            crate::provisioning::hf::gguf_pair(names.iter().map(String::as_str)).unwrap();
        let tmp = tempfile::tempdir().unwrap();
        let spec = LaunchSpec {
            exe: env("MUKUCHI_IT_LLAMA_DIR").join(SERVER_EXE),
            model: dir.join(model),
            mmproj: dir.join(mmproj),
            exec: Exec::Gpu {
                device: Some("Vulkan0".into()),
            },
            log_file: tmp.path().join("asr-server.log"),
        };
        tauri::async_runtime::block_on(async {
            let asr = std::sync::Arc::new(AsrProcess::new());
            asr.start(spec, false).await;
            let (_tx, rx) = tokio::sync::watch::channel(false);
            let url = asr.wait_ready(rx).await.unwrap();
            let client = LlamaClient::new(url).unwrap();
            for secs in [1usize, 3, 8] {
                let wav = crate::audio::encode_wav_16k(&vec![0.0; 16_000 * secs]).unwrap();
                let t = Instant::now();
                let r = client.transcribe(wav, Locale::Ja, None).await.unwrap();
                println!(
                    "無音 {secs}秒 → 「{}」 {}ms",
                    r.text,
                    t.elapsed().as_millis()
                );
                assert!(r.text.chars().count() < 40, "{}", r.text);
            }
            asr.stop().await;
        });
    }

    #[test]
    fn wav_duration() {
        let wav = crate::audio::encode_wav_16k(&vec![0.0; 16_000 * 3 / 2]).unwrap();
        assert!((wav_secs(&wav).unwrap() - 1.5).abs() < 1e-9);
        assert!(wav_secs(b"nonsense").is_err());
    }
}
