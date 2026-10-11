//! OS 依存の処理の窓口 (docs/plans/windows-plan.md §4.1)。
//!
//! 呼び出し側は `crate::platform::…` だけを使い、`if mac / if windows` を散らさない。
//! 中身は OS ごとのモジュールにあり、同じ名前・同じ形の関数と型を出す:
//!
//! | 名前 | 内容 |
//! |---|---|
//! | `NAME` | ビルドした OS (`AppInfo.platform`: `"macos"` / `"windows"`) |
//! | `MicAuthorization` / `microphone_authorization` / `request_microphone` | マイクの許可 |
//! | `accessibility_trusted` | 入力に必要な権限 (Windows には無いため常に true) |
//! | `open_url` / `open_path` / `trash` | URL・フォルダを開く、ゴミ箱へ |
//! | `running_apps` | 入力しないアプリの候補 |
//! | `inserter` | 入力 (`InsertBackend`)。貼り付け・キー送信・前面アプリ |
//! | `tray` (Windows のみ) | タスクトレイのアイコン (macOS は `crate::macos::status_icon`) |
//!
//! macOS は既存の `crate::macos` (objc2) を呼ぶだけ。Windows の固有部 (パネルの `panel`・表示言語の
//! `preferred_ui_languages`) は `windows/` にあり、呼び出し側は `cfg(target_os = "windows")` の中で使う。

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::*;

// `self::` を付ける (windows crate と同じ名前のため、付けないと use が曖昧になる)
#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
pub use self::windows::*;

/// Windows の子プロセス (llama-server) の起動の作法 (環境変数・窓を出さない・Job Object)
#[cfg(target_os = "windows")]
pub mod process;
