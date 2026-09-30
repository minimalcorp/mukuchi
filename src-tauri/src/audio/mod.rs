//! 録音。cpal でマイクから取り込み、mono f32 に変換してチャネルへ流す。
//!
//! cpal のコールバック (リアルタイムスレッド) ではチャネルへの送信だけを行い、
//! リサンプル・VAD などの重い処理は受信側 (pipeline) のスレッドで行う。

pub mod resampler;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SizedSample};
use serde::Serialize;

pub enum AudioMsg {
    /// mono の f32 サンプル
    Samples(Vec<f32>),
    /// デバイスの切断など、録音を続けられないエラー
    Lost(String),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

pub fn list_input_devices() -> Result<Vec<AudioDevice>> {
    let host = cpal::default_host();
    let default_id = host.default_input_device().and_then(|d| d.id().ok());
    let mut out = Vec::new();
    for device in host
        .input_devices()
        .map_err(|e| anyhow!("入力デバイスの一覧を取得できません: {e}"))?
    {
        let Ok(id) = device.id() else { continue };
        let name = device
            .description()
            .map(|d| d.name().to_string())
            .unwrap_or_else(|_| device.to_string());
        out.push(AudioDevice {
            is_default: Some(&id) == default_id.as_ref(),
            id: id.to_string(),
            name,
        });
    }
    Ok(out)
}

/// 録音の実体。drop すると録音を止める。
pub struct Capture {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    pub sample_rate: u32,
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// 音声の取り込み元。
#[derive(Debug, Clone)]
pub enum Source {
    /// マイク。`None` はシステム既定
    Device(Option<String>),
    /// 開発用: WAVファイルを実時間で流し、その後は無音を流し続ける
    File(PathBuf),
}

pub fn start(source: Source) -> Result<(Capture, Receiver<AudioMsg>)> {
    let (tx, rx) = mpsc::channel();
    let capture = match source {
        Source::Device(id) => start_device(id, tx)?,
        Source::File(path) => start_file(path, tx)?,
    };
    Ok((capture, rx))
}

fn find_device(id: Option<&str>) -> Result<cpal::Device> {
    let host = cpal::default_host();
    match id {
        None => host
            .default_input_device()
            .context("入力デバイスが見つかりません"),
        Some(id) => {
            let parsed: cpal::DeviceId = id
                .parse()
                .map_err(|e| anyhow!("デバイスIDが不正: {id}: {e}"))?;
            host.device_by_id(&parsed)
                .with_context(|| format!("選択したマイクが見つかりません: {id}"))
        }
    }
}

/// cpal の Stream はスレッドをまたいで扱いにくい (作成と破棄を同じスレッドで行うのが安全) ため、
/// 専用スレッドで作成・保持し、停止フラグで破棄する。
fn start_device(id: Option<String>, tx: Sender<AudioMsg>) -> Result<Capture> {
    let stop = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = mpsc::channel::<Result<u32>>();
    let stop2 = stop.clone();
    let thread = std::thread::Builder::new()
        .name("mukuchi-capture".into())
        .spawn(move || {
            let stream = match build_stream(id.as_deref(), tx) {
                Ok((stream, rate)) => {
                    let _ = ready_tx.send(Ok(rate));
                    stream
                }
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                    return;
                }
            };
            while !stop2.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(50));
            }
            drop(stream);
        })
        .context("録音スレッドを起動できません")?;
    let sample_rate = ready_rx
        .recv()
        .map_err(|_| anyhow!("録音スレッドが異常終了しました"))??;
    Ok(Capture {
        stop,
        thread: Some(thread),
        sample_rate,
    })
}

fn build_stream(id: Option<&str>, tx: Sender<AudioMsg>) -> Result<(cpal::Stream, u32)> {
    let device = find_device(id)?;
    let supported = device
        .default_input_config()
        .map_err(|e| anyhow!("マイクの設定を取得できません: {e}"))?;
    let config = supported.config();
    let channels = config.channels as usize;
    let rate = config.sample_rate;
    log::info!(
        "録音開始: {device} {rate}Hz {channels}ch {:?}",
        supported.sample_format()
    );
    use cpal::SampleFormat as F;
    let stream = match supported.sample_format() {
        F::F32 => build::<f32>(&device, config, channels, tx),
        F::F64 => build::<f64>(&device, config, channels, tx),
        F::I16 => build::<i16>(&device, config, channels, tx),
        F::I32 => build::<i32>(&device, config, channels, tx),
        F::I8 => build::<i8>(&device, config, channels, tx),
        F::U8 => build::<u8>(&device, config, channels, tx),
        F::U16 => build::<u16>(&device, config, channels, tx),
        other => Err(anyhow!("未対応のサンプル形式: {other:?}")),
    }?;
    stream
        .play()
        .map_err(|e| anyhow!("録音を開始できません: {e}"))?;
    Ok((stream, rate))
}

fn build<T>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    channels: usize,
    tx: Sender<AudioMsg>,
) -> Result<cpal::Stream>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let err_tx = tx.clone();
    device
        .build_input_stream::<T, _, _>(
            config,
            move |data: &[T], _| {
                let mono = downmix(data, channels);
                // 受信側が止まっている(OFF処理中)なら捨ててよい
                let _ = tx.send(AudioMsg::Samples(mono));
            },
            move |err| {
                log::error!("録音エラー: {err}");
                if matches!(err.kind(), cpal::ErrorKind::DeviceNotAvailable) {
                    let _ = err_tx.send(AudioMsg::Lost(err.to_string()));
                }
            },
            None,
        )
        .map_err(|e| anyhow!("録音ストリームを作成できません: {e}"))
}

fn downmix<T>(data: &[T], channels: usize) -> Vec<f32>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    if channels <= 1 {
        return data.iter().map(|&s| f32::from_sample_(s)).collect();
    }
    data.chunks_exact(channels)
        .map(|frame| frame.iter().map(|&s| f32::from_sample_(s)).sum::<f32>() / channels as f32)
        .collect()
}

/// 開発用のファイル入力。実際に話せない環境で VAD→ASR→入力 を通しで確認するため。
fn start_file(path: PathBuf, tx: Sender<AudioMsg>) -> Result<Capture> {
    let samples = read_wav_mono(&path)?;
    let (samples, rate) = samples;
    log::info!(
        "開発用音声ファイルを入力にする: {} ({:.1}秒)",
        path.display(),
        samples.len() as f64 / rate as f64
    );
    let stop = Arc::new(AtomicBool::new(false));
    let stop2 = stop.clone();
    let thread = std::thread::Builder::new()
        .name("mukuchi-capture-file".into())
        .spawn(move || {
            let chunk = (rate / 50) as usize; // 20ms
                                              // 開始直後の無音 → ファイル → 以降は無音を流し続ける (OFFまで)
            let lead = vec![0.0f32; rate as usize];
            let mut iter = lead
                .into_iter()
                .chain(samples)
                .chain(std::iter::repeat(0.0f32));
            while !stop2.load(Ordering::SeqCst) {
                let buf: Vec<f32> = iter.by_ref().take(chunk).collect();
                if tx.send(AudioMsg::Samples(buf)).is_err() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        })
        .context("ファイル入力スレッドを起動できません")?;
    Ok(Capture {
        stop,
        thread: Some(thread),
        sample_rate: rate,
    })
}

/// WAV を読み mono f32 にする。
pub fn read_wav_mono(path: &std::path::Path) -> Result<(Vec<f32>, u32)> {
    let mut reader = hound::WavReader::open(path)
        .with_context(|| format!("WAVを開けません: {}", path.display()))?;
    let spec = reader.spec();
    let channels = spec.channels.max(1) as usize;
    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .collect::<Result<_, _>>()
            .context("WAVの読み込みに失敗")?,
        hound::SampleFormat::Int => {
            let scale = (1i64 << (spec.bits_per_sample - 1)) as f32;
            reader
                .samples::<i32>()
                .map(|s| s.map(|v| v as f32 / scale))
                .collect::<Result<_, _>>()
                .context("WAVの読み込みに失敗")?
        }
    };
    let mono = if channels == 1 {
        samples
    } else {
        samples
            .chunks_exact(channels)
            .map(|f| f.iter().sum::<f32>() / channels as f32)
            .collect()
    };
    Ok((mono, spec.sample_rate))
}

/// 16kHz / mono / 16bit PCM の WAV にする (ASRサーバーの入力形式)。
pub fn encode_wav_16k(samples: &[f32]) -> Result<Vec<u8>> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: crate::vad::SAMPLE_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut cursor = std::io::Cursor::new(Vec::with_capacity(44 + samples.len() * 2));
    {
        let mut w = hound::WavWriter::new(&mut cursor, spec).context("WAVの書き込みに失敗")?;
        for &s in samples {
            let v = (s.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16;
            w.write_sample(v).context("WAVの書き込みに失敗")?;
        }
        w.finalize().context("WAVの書き込みに失敗")?;
    }
    Ok(cursor.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_roundtrip() {
        let samples: Vec<f32> = (0..1600).map(|i| (i as f32 / 1600.0) - 0.5).collect();
        let bytes = encode_wav_16k(&samples).unwrap();
        assert_eq!(&bytes[0..4], b"RIFF");
        let path = std::env::temp_dir().join(format!("mukuchi-wav-{}.wav", std::process::id()));
        std::fs::write(&path, &bytes).unwrap();
        let (back, rate) = read_wav_mono(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(rate, 16000);
        assert_eq!(back.len(), samples.len());
        assert!((back[100] - samples[100]).abs() < 1e-3);
    }

    #[test]
    fn downmix_stereo() {
        let data = [1.0f32, 0.0, 0.5, 0.5];
        assert_eq!(downmix(&data, 2), vec![0.5, 0.5]);
        let data = [i16::MAX, 0];
        let m = downmix(&data, 1);
        assert!((m[0] - 1.0).abs() < 1e-3);
    }
}
