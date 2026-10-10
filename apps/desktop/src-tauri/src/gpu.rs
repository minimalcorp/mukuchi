//! ASR を動かす GPU の判定 (docs/architecture.md「GPU の判定と CPU 実行の同意」)。
//!
//! Windows のみ意味を持つ。判定は 2 段階で、根拠は spikes/asr-bench/WINDOWS_DECISION.md「GPU の有無の判別」:
//! - (a) DXGI でソフトウェアアダプター (Microsoft Basic Render Driver) を除いたアダプターを数える。
//!   独立/内蔵は D3D12 の `UMA` で見る (取れなければ専用 VRAM の小ささで推定する)
//! - (b) 同梱の Vulkan 版 `llama-server --list-devices` で推論に使えるデバイスを確定する (こちらが正)
//!
//! 結果: `ok` (独立 GPU あり) / `integrated` (内蔵のみ) / `driver_missing` ((a) にいるのに (b) が空) / `none`。
//! `none`・`driver_missing` は CPU 実行への同意 (`Settings.cpuInferenceAccepted`) が無い限り ASR を動かさない。
//! Mac は常に `ok`・`gpu` (Apple Silicon の GPU を MLX が使う)。

use serde::Serialize;

// Mac は判定しないため使わない値がある
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GpuKind {
    Ok,
    Integrated,
    DriverMissing,
    None,
}

// Mac は判定しないため使わない値がある
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuDevice {
    pub name: String,
    pub vram_mb: Option<u64>,
    pub integrated: bool,
}

/// 実際に使う実行先
// Mac は判定しないため使わない値がある
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ExecDevice {
    Gpu,
    Cpu,
}

/// docs/architecture.md「型」の GpuStatus
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuStatus {
    pub kind: GpuKind,
    /// Vulkan で推論に使えるもの。driver_missing・none は空
    pub devices: Vec<GpuDevice>,
    /// 使うデバイスの名前 (ok・integrated)
    pub selected: Option<String>,
    /// cpu は kind が none・driver_missing で CPU 実行に同意した時だけ
    pub device: ExecDevice,
}

#[cfg(target_os = "windows")]
impl GpuKind {
    /// GPU で推論できない (CPU 実行への同意が要る)
    pub fn needs_cpu(self) -> bool {
        matches!(self, Self::None | Self::DriverMissing)
    }
}

#[cfg(not(target_os = "windows"))]
pub use mac::GpuManager;
#[cfg(target_os = "windows")]
pub use win::GpuManager;

#[cfg(not(target_os = "windows"))]
mod mac {
    use super::*;

    /// Mac は判定しない (常に ok・gpu)
    pub struct GpuManager;

    impl GpuManager {
        pub fn status_now(&self) -> GpuStatus {
            GpuStatus {
                kind: GpuKind::Ok,
                devices: Vec::new(),
                selected: None,
                device: ExecDevice::Gpu,
            }
        }

        pub async fn status(&self) -> GpuStatus {
            self.status_now()
        }

        pub async fn probe(&self) -> GpuStatus {
            self.status_now()
        }
    }
}

// ---- Windows ---------------------------------------------------------------------

#[cfg(target_os = "windows")]
pub use detect::*;

/// 判定の規則 (純粋な関数。OS に依存しないがWindows でしか使わない)
#[cfg(target_os = "windows")]
mod detect {
    use super::*;
    pub use crate::llama::ListedDevice;

    /// 判定の材料 (a): DXGI のハードウェアアダプター
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct Adapter {
        pub name: String,
        pub dedicated_mb: u64,
        /// D3D12 の UMA (統合メモリ = 内蔵 GPU)。D3D12 で調べられなければ None
        pub uma: Option<bool>,
    }

    impl Adapter {
        /// 内蔵 GPU か。D3D12 の UMA が正。取れない時は専用 VRAM が小さい (内蔵 GPU は 128MB 前後を報告する) かで推定する
        pub fn integrated(&self) -> bool {
            self.uma.unwrap_or(self.dedicated_mb < INTEGRATED_VRAM_MB)
        }
    }

    /// 専用 VRAM がこれ未満なら内蔵とみなす (UMA が取れない時の推定)
    const INTEGRATED_VRAM_MB: u64 = 512;

    /// 判定に使う開発用の差し替え (`MUKUCHI_DEV_FORCE_GPU`)
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum Force {
        Ok,
        Integrated,
        DriverMissing,
        None,
    }

    impl Force {
        pub fn parse(s: &str) -> Option<Self> {
            match s {
                "ok" => Some(Self::Ok),
                "integrated" => Some(Self::Integrated),
                "driver_missing" => Some(Self::DriverMissing),
                "none" => Some(Self::None),
                _ => None,
            }
        }
    }

    /// 開発用: 判定結果を差し替える (同意の流れの確認用。デバッグビルドのみ)
    pub const ENV_DEV_FORCE_GPU: &str = "MUKUCHI_DEV_FORCE_GPU";

    /// 判定の結果 (`--device` に渡す名前を含む)
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct Probe {
        pub kind: GpuKind,
        /// (`--device` の名前, 表示用)
        pub devices: Vec<(String, GpuDevice)>,
        /// devices の添字
        pub selected: Option<usize>,
    }

    /// (a)(b) から判定する。Vulkan のデバイスは名前が一致する DXGI のアダプターで独立/内蔵を決める
    /// (Vulkan の列挙の出力には種類が無いため)。一致するものが無ければ独立とみなす
    pub fn classify(adapters: &[Adapter], listed: &[ListedDevice]) -> Probe {
        let devices: Vec<(String, GpuDevice)> = listed
            .iter()
            .map(|d| {
                let integrated = adapters
                    .iter()
                    .find(|a| same_name(&a.name, &d.name))
                    .is_some_and(Adapter::integrated);
                (
                    d.id.clone(),
                    GpuDevice {
                        name: d.name.clone(),
                        vram_mb: d.total_mib,
                        integrated,
                    },
                )
            })
            .collect();
        let kind = if devices.iter().any(|(_, d)| !d.integrated) {
            GpuKind::Ok
        } else if !devices.is_empty() {
            GpuKind::Integrated
        } else if !adapters.is_empty() {
            GpuKind::DriverMissing
        } else {
            GpuKind::None
        };
        Probe {
            kind,
            selected: select(&devices),
            devices,
        }
    }

    /// 開発用の差し替えを当てる
    pub fn apply_force(mut p: Probe, force: Force) -> Probe {
        match force {
            Force::None | Force::DriverMissing => {
                p.devices.clear();
                p.kind = if force == Force::None {
                    GpuKind::None
                } else {
                    GpuKind::DriverMissing
                };
            }
            Force::Integrated | Force::Ok => {
                for (_, d) in p.devices.iter_mut() {
                    d.integrated = force == Force::Integrated;
                }
                p.kind = if force == Force::Ok {
                    GpuKind::Ok
                } else {
                    GpuKind::Integrated
                };
            }
        }
        p.selected = select(&p.devices);
        p
    }

    /// 推論に使うデバイス: 独立 GPU を優先し、その中で VRAM の大きいもの (同じなら列挙の順)
    fn select(devices: &[(String, GpuDevice)]) -> Option<usize> {
        devices
            .iter()
            .enumerate()
            .max_by(|(ia, (_, a)), (ib, (_, b))| {
                (!a.integrated)
                    .cmp(&!b.integrated)
                    .then(a.vram_mb.unwrap_or(0).cmp(&b.vram_mb.unwrap_or(0)))
                    // max_by は等しければ後ろを返すため、先のものを大きいとする
                    .then(ib.cmp(ia))
            })
            .map(|(i, _)| i)
    }

    /// 名前の比較 (`(TM)` `(R)` の表記・大文字小文字・空白の違いを無視する。DXGI と Vulkan で表記が揺れうるため)
    pub fn same_name(a: &str, b: &str) -> bool {
        let norm = |s: &str| {
            s.to_lowercase()
                .replace("(tm)", "")
                .replace("(r)", "")
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
        };
        norm(a) == norm(b)
    }

    impl Probe {
        pub fn status(&self, cpu_accepted: bool) -> GpuStatus {
            GpuStatus {
                kind: self.kind,
                devices: self.devices.iter().map(|(_, d)| d.clone()).collect(),
                selected: self
                    .selected
                    .and_then(|i| self.devices.get(i))
                    .map(|(_, d)| d.name.clone()),
                device: if self.kind.needs_cpu() && cpu_accepted {
                    ExecDevice::Cpu
                } else {
                    ExecDevice::Gpu
                },
            }
        }

        /// `--device` に渡す名前
        pub fn selected_id(&self) -> Option<String> {
            self.selected
                .and_then(|i| self.devices.get(i))
                .map(|(id, _)| id.clone())
        }
    }
}

#[cfg(target_os = "windows")]
mod win {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;

    use super::*;
    use crate::llama::Exec;

    type Emit = Box<dyn Fn(&GpuStatus) + Send + Sync>;

    pub struct GpuManager {
        /// 同梱の Vulkan 版 llama-server.exe
        bundled_exe: PathBuf,
        /// 取得した CPU 版の llama-server.exe
        cpu_exe: PathBuf,
        probe: Mutex<Option<Probed>>,
        /// 判定を1つずつにする (起動時と再検出が重なっても llama-server を二重に起動しない)
        probing: tokio::sync::Mutex<()>,
        accepted: AtomicBool,
        emit: Emit,
    }

    #[derive(Debug, Clone)]
    struct Probed {
        probe: Probe,
        /// 同梱の llama-server を起動できなかった (入れ直しが要る。GPU の有無とは別の問題)
        error: Option<String>,
    }

    impl GpuManager {
        pub fn new(
            bundled_exe: PathBuf,
            cpu_exe: PathBuf,
            cpu_accepted: bool,
            emit: impl Fn(&GpuStatus) + Send + Sync + 'static,
        ) -> Self {
            Self {
                bundled_exe,
                cpu_exe,
                probe: Mutex::new(None),
                probing: tokio::sync::Mutex::new(()),
                accepted: AtomicBool::new(cpu_accepted),
                emit: Box::new(emit),
            }
        }

        fn current(&self) -> Option<Probed> {
            self.probe.lock().unwrap_or_else(|p| p.into_inner()).clone()
        }

        fn accepted(&self) -> bool {
            self.accepted.load(Ordering::SeqCst)
        }

        /// 判定済みならその結果
        pub fn status_now(&self) -> Option<GpuStatus> {
            self.current().map(|p| p.probe.status(self.accepted()))
        }

        /// 判定の結果 (まだなら判定する)
        pub async fn status(&self) -> GpuStatus {
            if let Some(s) = self.status_now() {
                return s;
            }
            let _g = self.probing.lock().await;
            // 待っている間に他が判定し終えていればそれを使う
            if let Some(s) = self.status_now() {
                return s;
            }
            self.probe_locked().await
        }

        /// 判定し直す (再検出)
        pub async fn probe(&self) -> GpuStatus {
            let _g = self.probing.lock().await;
            self.probe_locked().await
        }

        async fn probe_locked(&self) -> GpuStatus {
            let adapters = match tauri::async_runtime::spawn_blocking(dxgi_adapters).await {
                Ok(Ok(a)) => a,
                Ok(Err(e)) => {
                    log::warn!("GPU の判定: DXGI で列挙できません: {e:#}");
                    Vec::new()
                }
                Err(e) => {
                    log::warn!("GPU の判定: DXGI の列挙が異常終了: {e}");
                    Vec::new()
                }
            };
            let (listed, error) = match crate::llama::list_devices(&self.bundled_exe).await {
                Ok(l) => (l, None),
                Err(e) => {
                    log::error!("GPU の判定: llama-server を起動できません: {e:#}");
                    (Vec::new(), Some(format!("{e:#}")))
                }
            };
            let mut probe = classify(&adapters, &listed);
            if let Some(f) = dev_force() {
                log::info!("{ENV_DEV_FORCE_GPU} により判定を差し替える: {f:?}");
                probe = apply_force(probe, f);
            }
            // デバイス名のみ記録する (誤判定の調査用)
            log::info!(
                "GPU の判定: {:?} (Vulkan: {:?}, 使う: {:?}, DXGI: {:?})",
                probe.kind,
                probe
                    .devices
                    .iter()
                    .map(|(id, d)| format!("{id} {} integrated={}", d.name, d.integrated))
                    .collect::<Vec<_>>(),
                probe.selected_id(),
                adapters
                    .iter()
                    .map(|a| format!("{} {}MB uma={:?}", a.name, a.dedicated_mb, a.uma))
                    .collect::<Vec<_>>(),
            );
            let next = Probed { probe, error };
            let prev = self
                .probe
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .replace(next.clone());
            let status = next.probe.status(self.accepted());
            if prev.map(|p| p.probe.status(self.accepted())).as_ref() != Some(&status) {
                (self.emit)(&status);
            }
            status
        }

        /// CPU 実行への同意 (`Settings.cpuInferenceAccepted`) が変わった
        pub fn set_accepted(&self, on: bool) {
            if self.accepted.swap(on, Ordering::SeqCst) != on {
                if let Some(s) = self.status_now() {
                    (self.emit)(&s);
                }
            }
        }

        /// GPU が使えず、CPU 実行への同意も無い (判定前は false)
        /// 同梱の llama-server を起動できない時は false (GPU の問題ではなく、同意しても解決しないため)
        pub fn needs_consent(&self) -> bool {
            self.current()
                .is_some_and(|p| p.error.is_none() && p.probe.kind.needs_cpu() && !self.accepted())
        }

        /// 同梱の llama-server を起動できなかった理由 (判定前・起動できたなら None)
        pub fn launch_error(&self) -> Option<String> {
            self.current().and_then(|p| p.error)
        }

        /// CPU 版で動かすか (GPU が使えず同意がある)
        pub fn uses_cpu(&self) -> bool {
            self.current()
                .is_some_and(|p| p.probe.kind.needs_cpu() && self.accepted())
        }

        /// 起動する llama-server と実行先。判定前は同梱の Vulkan 版で `--device` を指定しない
        pub fn exec(&self) -> (PathBuf, Exec) {
            if self.uses_cpu() {
                return (self.cpu_exe.clone(), Exec::Cpu);
            }
            let device = self.current().and_then(|p| p.probe.selected_id());
            (self.bundled_exe.clone(), Exec::Gpu { device })
        }
    }

    fn dev_force() -> Option<Force> {
        if !cfg!(debug_assertions) {
            return None;
        }
        let v = std::env::var(ENV_DEV_FORCE_GPU).ok()?;
        let f = Force::parse(&v);
        if f.is_none() && !v.is_empty() {
            log::warn!("{ENV_DEV_FORCE_GPU} の値が不正なため無視する: {v}");
        }
        f
    }

    /// (a) DXGI のハードウェアアダプター (ソフトウェアアダプターを除く)
    fn dxgi_adapters() -> anyhow::Result<Vec<Adapter>> {
        use ::windows::Win32::Graphics::Dxgi::{
            CreateDXGIFactory1, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE, DXGI_ERROR_NOT_FOUND,
        };
        /// Microsoft Basic Render Driver (WARP) の VendorId
        const MICROSOFT_VENDOR_ID: u32 = 0x1414;
        // SAFETY: 引数の無い COM の生成。返したインターフェースは Drop で解放される
        let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1() }?;
        let mut out = Vec::new();
        for i in 0.. {
            // SAFETY: factory は有効。範囲外は DXGI_ERROR_NOT_FOUND を返す
            let adapter = match unsafe { factory.EnumAdapters1(i) } {
                Ok(a) => a,
                Err(e) if e.code() == DXGI_ERROR_NOT_FOUND => break,
                Err(e) => return Err(e.into()),
            };
            // SAFETY: adapter は有効
            let desc = unsafe { adapter.GetDesc1() }?;
            if desc.Flags & (DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32) != 0
                || desc.VendorId == MICROSOFT_VENDOR_ID
            {
                continue;
            }
            let len = desc
                .Description
                .iter()
                .position(|c| *c == 0)
                .unwrap_or(desc.Description.len());
            out.push(Adapter {
                name: String::from_utf16_lossy(&desc.Description[..len])
                    .trim()
                    .to_string(),
                dedicated_mb: desc.DedicatedVideoMemory as u64 / (1024 * 1024),
                uma: d3d12_uma(&adapter),
            });
        }
        Ok(out)
    }

    /// D3D12 の UMA (統合メモリ。内蔵 GPU)。D3D12 に対応していない等で調べられなければ None
    fn d3d12_uma(adapter: &::windows::Win32::Graphics::Dxgi::IDXGIAdapter1) -> Option<bool> {
        use ::windows::Win32::Graphics::Direct3D::D3D_FEATURE_LEVEL_11_0;
        use ::windows::Win32::Graphics::Direct3D12::{
            D3D12CreateDevice, ID3D12Device, D3D12_FEATURE_ARCHITECTURE,
            D3D12_FEATURE_DATA_ARCHITECTURE,
        };
        let mut device: Option<ID3D12Device> = None;
        // SAFETY: adapter は有効。device は成功時に設定される
        unsafe { D3D12CreateDevice(adapter, D3D_FEATURE_LEVEL_11_0, &mut device) }.ok()?;
        let device = device?;
        let mut arch = D3D12_FEATURE_DATA_ARCHITECTURE::default();
        // SAFETY: arch はこの呼び出しの間有効で、大きさは型の大きさそのもの
        unsafe {
            device.CheckFeatureSupport(
                D3D12_FEATURE_ARCHITECTURE,
                &mut arch as *mut _ as *mut core::ffi::c_void,
                std::mem::size_of::<D3D12_FEATURE_DATA_ARCHITECTURE>() as u32,
            )
        }
        .ok()?;
        Some(arch.UMA.as_bool())
    }

    #[cfg(test)]
    mod tests {
        /// 実機の DXGI で列挙できること (この PC の GPU。内容は環境による)
        #[test]
        fn dxgi_lists_hardware_adapters() {
            let a = super::dxgi_adapters().unwrap();
            for x in &a {
                assert!(!x.name.is_empty());
                assert!(!x.name.contains("Basic Render"), "{a:?}");
            }
        }
    }
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;

    fn listed(id: &str, name: &str, mib: u64) -> ListedDevice {
        ListedDevice {
            id: id.into(),
            name: name.into(),
            total_mib: Some(mib),
        }
    }

    fn adapter(name: &str, mb: u64, uma: Option<bool>) -> Adapter {
        Adapter {
            name: name.into(),
            dedicated_mb: mb,
            uma,
        }
    }

    #[test]
    fn classify_kinds() {
        let nv = adapter("NVIDIA GeForce RTX 3080 Ti", 12_000, Some(false));
        let intel = adapter("Intel(R) UHD Graphics 770", 128, Some(true));
        // 独立 GPU
        let p = classify(
            std::slice::from_ref(&nv),
            &[listed("Vulkan0", "NVIDIA GeForce RTX 3080 Ti", 12084)],
        );
        assert_eq!(p.kind, GpuKind::Ok);
        assert_eq!(p.selected_id().as_deref(), Some("Vulkan0"));
        let s = p.status(false);
        assert_eq!(s.selected.as_deref(), Some("NVIDIA GeForce RTX 3080 Ti"));
        assert_eq!(s.device, ExecDevice::Gpu);
        assert_eq!(s.devices[0].vram_mb, Some(12084));
        // 内蔵のみ
        let p = classify(
            std::slice::from_ref(&intel),
            &[listed("Vulkan0", "Intel(R) UHD Graphics 770", 16000)],
        );
        assert_eq!(p.kind, GpuKind::Integrated);
        assert_eq!(p.selected_id().as_deref(), Some("Vulkan0"));
        assert!(p.status(false).devices[0].integrated);
        // ハードはあるのに Vulkan が空 (ドライバー)
        let p = classify(std::slice::from_ref(&nv), &[]);
        assert_eq!(p.kind, GpuKind::DriverMissing);
        assert_eq!(p.selected, None);
        assert_eq!(p.status(false).device, ExecDevice::Gpu);
        assert_eq!(p.status(true).device, ExecDevice::Cpu);
        // 何も無い
        let p = classify(&[], &[]);
        assert_eq!(p.kind, GpuKind::None);
        assert!(p.status(false).devices.is_empty());
        assert_eq!(p.status(true).device, ExecDevice::Cpu);
        // DXGI で取れなくても Vulkan が正 (一致しないものは独立とみなす)
        assert_eq!(
            classify(&[], &[listed("Vulkan0", "Some GPU", 8000)]).kind,
            GpuKind::Ok
        );
    }

    #[test]
    fn discrete_gpu_is_preferred() {
        // ハイブリッドのノート: 内蔵が先に列挙されても独立を選ぶ
        let adapters = [
            adapter("Intel(R) Iris(R) Xe Graphics", 128, Some(true)),
            adapter("NVIDIA GeForce RTX 4060 Laptop GPU", 8000, Some(false)),
        ];
        let p = classify(
            &adapters,
            &[
                listed("Vulkan0", "Intel(R) Iris(R) Xe Graphics", 16000),
                listed("Vulkan1", "NVIDIA GeForce RTX 4060 Laptop GPU", 8188),
            ],
        );
        assert_eq!(p.kind, GpuKind::Ok);
        assert_eq!(p.selected_id().as_deref(), Some("Vulkan1"));
        // 独立が2つなら VRAM の大きい方、同じなら先
        let p = classify(
            &[],
            &[
                listed("Vulkan0", "A", 8000),
                listed("Vulkan1", "B", 12000),
                listed("Vulkan2", "C", 12000),
            ],
        );
        assert_eq!(p.selected_id().as_deref(), Some("Vulkan1"));
    }

    #[test]
    fn integrated_is_estimated_without_uma() {
        assert!(adapter("Intel(R) UHD Graphics", 128, None).integrated());
        assert!(!adapter("NVIDIA", 8000, None).integrated());
        // UMA が取れればそれが正 (大きな領域を割り当てた APU)
        assert!(adapter("AMD Radeon(TM) Graphics", 2048, Some(true)).integrated());
    }

    #[test]
    fn names_match_loosely() {
        assert!(same_name("AMD Radeon(TM) Graphics", "AMD Radeon Graphics"));
        assert!(same_name(
            "Intel(R) UHD Graphics 770",
            "intel uhd  graphics 770"
        ));
        assert!(!same_name(
            "NVIDIA GeForce RTX 3080",
            "NVIDIA GeForce RTX 3080 Ti"
        ));
    }

    #[test]
    fn force_overrides_result() {
        let real = classify(
            &[adapter("NVIDIA GeForce RTX 3080 Ti", 12000, Some(false))],
            &[listed("Vulkan0", "NVIDIA GeForce RTX 3080 Ti", 12084)],
        );
        let p = apply_force(real.clone(), Force::None);
        assert_eq!((p.kind, p.selected), (GpuKind::None, None));
        assert!(p.devices.is_empty());
        let p = apply_force(real.clone(), Force::DriverMissing);
        assert_eq!(p.kind, GpuKind::DriverMissing);
        assert!(p.devices.is_empty());
        let p = apply_force(real.clone(), Force::Integrated);
        assert_eq!(p.kind, GpuKind::Integrated);
        assert!(p.devices[0].1.integrated);
        assert_eq!(p.selected_id().as_deref(), Some("Vulkan0"));
        assert_eq!(apply_force(real, Force::Ok).kind, GpuKind::Ok);
        assert_eq!(Force::parse("driver_missing"), Some(Force::DriverMissing));
        assert_eq!(Force::parse("x"), None);
    }

    #[test]
    fn status_serializes_per_contract() {
        let p = classify(
            &[adapter("Intel(R) UHD Graphics 770", 128, Some(true))],
            &[listed("Vulkan0", "Intel(R) UHD Graphics 770", 16000)],
        );
        assert_eq!(
            serde_json::to_value(p.status(false)).unwrap(),
            serde_json::json!({
                "kind": "integrated",
                "devices": [{"name": "Intel(R) UHD Graphics 770", "vramMb": 16000, "integrated": true}],
                "selected": "Intel(R) UHD Graphics 770",
                "device": "gpu",
            })
        );
        assert_eq!(
            serde_json::to_value(classify(&[adapter("X", 4000, None)], &[]).status(true)).unwrap(),
            serde_json::json!({"kind": "driver_missing", "devices": [], "selected": null, "device": "cpu"})
        );
    }
}
