//! MLX (mlx-c FFI) 版 (second-state/qwen3_asr_rs) のベンチマーク。
//! 使い方: mlx-bench <model_dir> <audio_dir> <label>
//! 結果は $RESULTS_DIR (既定: spikes/asr-bench/results/) の <label>.json (Python版と共通形式)。
//! このクレートはファイルパスからの推論APIのみ提供するため、計測時間には音声ファイルの読み込みを含む(数ms程度)。

use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::{Context, Result};
use qwen3_asr_rs::inference::AsrInference;
use qwen3_asr_rs::tensor::Device;
use serde_json::json;

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    anyhow::ensure!(args.len() == 4, "usage: mlx-bench <model_dir> <audio_dir> <label>");
    let (model_dir, audio_dir, label) = (Path::new(&args[1]), Path::new(&args[2]), &args[3]);

    let mut files: Vec<PathBuf> = std::fs::read_dir(audio_dir)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "wav"))
        .collect();
    files.sort();
    anyhow::ensure!(!files.is_empty(), "音声がありません: {audio_dir:?}");

    qwen3_asr_rs::backend::mlx::stream::init_mlx(true);
    let t0 = Instant::now();
    let engine = AsrInference::load(model_dir, Device::Gpu(0)).context("model load")?;
    let load_ms = t0.elapsed().as_secs_f64() * 1000.0;

    // 初回推論はMetalカーネルのコンパイル等で遅いため、計測から除外する。
    engine.transcribe(files[0].to_str().unwrap(), Some("japanese"))?;

    let mut results = Vec::new();
    for f in &files {
        let t = Instant::now();
        let r = engine.transcribe(f.to_str().unwrap(), Some("japanese"))?;
        let latency_ms = t.elapsed().as_secs_f64() * 1000.0;
        // 言語指定時に区切りトークン <asr_text> が出力に残る(candle版と同じ不具合)ため取り除く。
        let text = r.text.trim_start_matches("<asr_text>").trim().to_string();
        let id = f.file_stem().unwrap().to_string_lossy().to_string();
        println!("{id}\t{latency_ms:7.0}ms\t{text}");
        results.push(json!({"id": id, "text": text, "latency_ms": latency_ms, "audio_sec": r.duration_seconds}));
    }

    let dir = std::env::var_os("RESULTS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../results"));
    let out = dir.join(format!("{label}.json"));
    std::fs::create_dir_all(out.parent().unwrap())?;
    let body = json!({"label": label, "impl": "rust-mlx", "model": model_dir, "load_ms": load_ms, "results": results});
    std::fs::write(&out, serde_json::to_string_pretty(&body)?)?;
    println!("-> {}", out.display());
    Ok(())
}
