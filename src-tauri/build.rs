fn main() {
    // get_app_info の build (コミットの短縮ハッシュ)。git がない環境 (ソース配布など) では unknown
    let build = std::process::Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".into());
    println!("cargo:rustc-env=MUKUCHI_BUILD={build}");
    // HEAD の変化では再実行しない (worktree では .git がファイルのため監視先が一定でない)。
    // 配布ビルドはクリーンビルドなので正しい値になる
    tauri_build::build()
}
