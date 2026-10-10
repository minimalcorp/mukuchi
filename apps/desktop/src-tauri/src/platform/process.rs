//! Windows の子プロセス (llama-server・zip の展開) の起動の作法 (docs/architecture.md「Windows 版」の子プロセス)。
//!
//! - 環境変数は引き継がず `SystemRoot` `TEMP` `TMP` `USERPROFILE` `LOCALAPPDATA` と `PATH` (System32) だけ渡す
//!   (利用者の環境の `LLAMA_ARG_*` 等が引数の代わりに読まれて、本番と違う動きになるのを防ぐため)
//! - `CREATE_NO_WINDOW`: GUI アプリから起動したコンソールアプリにコンソールの窓を出させない
//! - Job Object (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`) に入れる: アプリが異常終了してもハンドルが閉じて子が終わる
//!   (Mac の stdin の EOF で終わる仕組みの代わり。llama-server には stdin で終わる機能が無い)

use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::OnceLock;

use ::windows::Win32::Foundation::HANDLE;
use ::windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use anyhow::{anyhow, Context, Result};

/// コンソールの窓を作らない (Win32 の process creation flags の CREATE_NO_WINDOW)
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 子プロセスに引き継ぐ環境変数 (他は渡さない)
const PASS_ENV: [&str; 5] = ["SystemRoot", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA"];

/// 開発用 (デバッグビルドのみ): Vulkan のドライバーの指定を引き継ぐ。存在しないファイルを指せば
/// Vulkan の列挙が空になり、GPU が使えない状態 (driver_missing) を実機の経路のまま確かめられる
const DEV_PASS_ENV: [&str; 2] = ["VK_DRIVER_FILES", "VK_ICD_FILENAMES"];

/// `%SystemRoot%` (無ければ既定の場所)
pub fn system_root() -> PathBuf {
    std::env::var_os("SystemRoot")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
}

/// 子プロセスに渡す環境変数
pub fn child_env() -> Vec<(OsString, OsString)> {
    let mut env: Vec<(OsString, OsString)> = PASS_ENV
        .iter()
        .filter_map(|k| std::env::var_os(k).map(|v| (OsString::from(k), v)))
        .collect();
    env.push((
        "PATH".into(),
        system_root().join("System32").into_os_string(),
    ));
    if cfg!(debug_assertions) {
        env.extend(
            DEV_PASS_ENV
                .iter()
                .filter_map(|k| std::env::var_os(k).map(|v| (OsString::from(k), v))),
        );
    }
    env
}

/// 窓を出さず、環境変数を絞る
pub fn configure(cmd: &mut tokio::process::Command) {
    cmd.env_clear()
        .envs(child_env())
        .creation_flags(CREATE_NO_WINDOW);
}

/// アプリ全体で1つの Job Object。閉じない (プロセスの終了で OS が閉じ、中の子を終わらせる)。
/// HANDLE は Send でないため値 (isize) で持つ
static JOB: OnceLock<std::result::Result<isize, String>> = OnceLock::new();

fn job() -> Result<HANDLE> {
    let r = JOB.get_or_init(|| create_job().map_err(|e| format!("{e:#}")));
    match r {
        Ok(h) => Ok(HANDLE(*h as *mut core::ffi::c_void)),
        Err(e) => Err(anyhow!("Job Object を作れません: {e}")),
    }
}

fn create_job() -> Result<isize> {
    // SAFETY: 引数はすべて有効な値 (名前なし・既定のセキュリティ)。返したハンドルは閉じずにプロセスの終わりまで持つ
    let job = unsafe { CreateJobObjectW(None, None) }.context("CreateJobObjectW")?;
    let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    // SAFETY: info はこの呼び出しの間有効で、大きさは型の大きさそのもの
    unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    }
    .context("SetInformationJobObject")?;
    Ok(job.0 as isize)
}

/// 起動した子プロセスを Job Object に入れる。失敗しても子は動かす (ログに残す。アプリの通常の終了では
/// 呼び出し側が止めるため、残るのは異常終了の時だけ)
pub fn assign_to_job(child: &tokio::process::Child) {
    let result = (|| -> Result<()> {
        let process = child
            .raw_handle()
            .ok_or_else(|| anyhow!("プロセスのハンドルがありません (終了済み)"))?;
        let job = job()?;
        // SAFETY: どちらのハンドルも有効 (job は閉じない。process は child が持っている間有効)
        unsafe { AssignProcessToJobObject(job, HANDLE(process)) }
            .context("AssignProcessToJobObject")
    })();
    if let Err(e) = result {
        log::warn!("子プロセスを Job Object に入れられません: {e:#}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_is_allowlisted() {
        let env = child_env();
        let keys: Vec<String> = env
            .iter()
            .map(|(k, _)| k.to_string_lossy().into_owned())
            .collect();
        for k in &keys {
            assert!(
                PASS_ENV.contains(&k.as_str()) || DEV_PASS_ENV.contains(&k.as_str()) || k == "PATH",
                "{k}"
            );
        }
        let path = env.iter().find(|(k, _)| k == "PATH").unwrap();
        assert!(PathBuf::from(&path.1).ends_with("System32"));
    }

    /// Job Object に入れた子が、Job のハンドルを閉じると終わること (アプリの異常終了と同じ)。
    /// アプリ全体の Job は閉じないため、ここでは別の Job を作って確かめる
    #[test]
    fn kill_on_job_close() {
        tauri::async_runtime::block_on(async {
            let job = HANDLE(create_job().unwrap() as *mut core::ffi::c_void);
            // しばらく終わらない子 (30 秒の ping)
            let mut cmd = tokio::process::Command::new(system_root().join(r"System32\PING.EXE"));
            cmd.args(["-n", "30", "127.0.0.1"])
                .stdout(std::process::Stdio::null());
            configure(&mut cmd);
            let mut child = cmd.spawn().unwrap();
            unsafe { AssignProcessToJobObject(job, HANDLE(child.raw_handle().unwrap())) }.unwrap();
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            assert!(child.try_wait().unwrap().is_none(), "まだ動いている");
            unsafe { ::windows::Win32::Foundation::CloseHandle(job) }.unwrap();
            tokio::time::timeout(std::time::Duration::from_secs(5), child.wait())
                .await
                .expect("Job を閉じたら終わる")
                .unwrap();
        });
    }
}
