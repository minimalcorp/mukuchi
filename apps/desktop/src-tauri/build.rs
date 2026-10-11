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
    // 開発ビルドのアンインストールで、このビルドの target ディレクトリ外のアプリ本体に触れないため
    // (storage.rs)。cargo は target ディレクトリの直下に CACHEDIR.TAG を置く
    // 配布 (release) ビルドには開発機のパスを埋め込まない
    let debug = std::env::var("PROFILE").as_deref() == Ok("debug");
    let target_dir = std::env::var_os("OUT_DIR")
        .filter(|_| debug)
        .and_then(|out| {
            std::path::Path::new(&out)
                .ancestors()
                .find(|p| p.join("CACHEDIR.TAG").is_file())
                .map(|p| p.to_string_lossy().into_owned())
        });
    println!(
        "cargo:rustc-env=MUKUCHI_TARGET_DIR={}",
        target_dir.unwrap_or_default()
    );
    // examples/ (実機の検証用) にもコモンコントロール v6 のマニフェストを付ける。tauri-build は bin にしか
    // 付けないため、付けないと examples が起動時に STATUS_ENTRYPOINT_NOT_FOUND で落ちる
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        println!("cargo:rustc-link-arg-examples=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg-examples=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
        );
    }
    tauri_build::build()
}
