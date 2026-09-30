//! Candle + Metal 版 (qwen3-asr クレート) のベンチマーク。
//! 使い方: candle-bench <model_dir> <audio_dir> <label>
//! 結果は $RESULTS_DIR (既定: spikes/asr-bench/results/) の <label>.json (Python版と共通形式)。

use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::{Context, Result};
use qwen3_asr::{AsrInference, TranscribeOptions};
use serde_json::json;

fn load_wav(path: &Path) -> Result<Vec<f32>> {
    let mut r = hound::WavReader::open(path)?;
    let s = r.spec();
    anyhow::ensure!(s.sample_rate == 16000 && s.channels == 1 && s.bits_per_sample == 16, "16kHz/mono/16bit以外: {path:?}");
    Ok(r.samples::<i16>().map(|x| x.map(|v| v as f32 / 32768.0)).collect::<Result<_, _>>()?)
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    anyhow::ensure!(args.len() == 4, "usage: candle-bench <model_dir> <audio_dir> <label>");
    let (model_dir, audio_dir, label) = (Path::new(&args[1]), Path::new(&args[2]), &args[3]);

    let mut files: Vec<PathBuf> = std::fs::read_dir(audio_dir)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "wav"))
        .collect();
    files.sort();
    anyhow::ensure!(!files.is_empty(), "音声がありません: {audio_dir:?}");

    let t0 = Instant::now();
    let engine = AsrInference::load(model_dir, qwen3_asr::best_device()).context("model load")?;
    let load_ms = t0.elapsed().as_secs_f64() * 1000.0;

    let opts = || TranscribeOptions::default().with_language("japanese");
    // 初回推論はMetalカーネルのコンパイル等で遅いため、計測から除外する。
    engine.transcribe_samples(&load_wav(&files[0])?, opts())?;

    let mut results = Vec::new();
    for f in &files {
        let audio = load_wav(f)?;
        let t = Instant::now();
        let text = engine.transcribe_samples(&audio, opts())?.text;
        // 言語指定時、クレートがプロンプトに <asr_text> を含めないためモデルが区切りトークンから生成し、
        // それが出力に残る(qwen3-asr 0.2.2 の不具合)。本体の文字列には影響しないので取り除く。
        let text = text.trim_start_matches("<asr_text>").trim().to_string();
        let latency_ms = t.elapsed().as_secs_f64() * 1000.0;
        let id = f.file_stem().unwrap().to_string_lossy().to_string();
        println!("{id}\t{latency_ms:7.0}ms\t{text}");
        results.push(json!({"id": id, "text": text, "latency_ms": latency_ms, "audio_sec": audio.len() as f64 / 16000.0}));
    }

    let dir = std::env::var_os("RESULTS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../results"));
    let out = dir.join(format!("{label}.json"));
    std::fs::create_dir_all(out.parent().unwrap())?;
    let body = json!({"label": label, "impl": "rust-candle", "model": model_dir, "load_ms": load_ms, "results": results});
    std::fs::write(&out, serde_json::to_string_pretty(&body)?)?;
    println!("-> {}", out.display());
    Ok(())
}
