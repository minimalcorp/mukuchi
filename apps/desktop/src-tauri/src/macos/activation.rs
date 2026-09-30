//! パネルの操作で mukuchi をアクティブ (前面アプリ) にしないための設定と、その診断。
//!
//! mukuchi がアクティブになると、それまで前面だったアプリがキーフォーカスを失い
//! (IME の変換中の文字も確定される)、入力先がなくなる。

use std::ptr::NonNull;

use block2::RcBlock;
use objc2::runtime::Bool;
use objc2_app_kit::{
    NSRunningApplication, NSWindow, NSWorkspace, NSWorkspaceApplicationKey,
    NSWorkspaceDidActivateApplicationNotification, NSWorkspaceDidDeactivateApplicationNotification,
};
use objc2_foundation::NSNotification;

/// ウィンドウのクリックでアプリをアクティブにしないよう、ウィンドウサーバーに伝える
/// (ウィンドウタグ kCGSPreventsActivationTagBit)。メインスレッドで呼ぶこと。設定後に読み返して true なら true。
///
/// `NSWindowStyleMaskNonactivatingPanel` は NSPanel の初期化時にだけ、内部で `-_setPreventsActivation:`
/// を呼んでこのタグに反映される。後から `setStyleMask:` で付けても反映されない
/// (<https://philz.blog/nspanel-nonactivating-style-mask-flag/>、
/// <https://github.com/electron/electron/issues/35815>、Apple Feedback FB16484811)。
/// Tauri のウィンドウは NSWindow として作られ、tauri-nspanel が後から NSPanel にクラスを差し替えて
/// スタイルを付けるため、このままではクリックで mukuchi が前面アプリになる (実測 macOS 26:
/// styleMask は nonactivating なのに `_preventsActivation` は false)。そこで同じ非公開メソッドを直接呼ぶ。
/// 非公開 API のため、応答しない OS では何もせず false を返す (呼び出し元が警告する)。
pub fn prevent_activation(window: &NSWindow) -> bool {
    let sel = objc2::sel!(_setPreventsActivation:);
    // SAFETY: respondsToSelector で存在を確かめてから、BOOL を1つ取り void を返すメソッドとして呼ぶ
    unsafe {
        let responds: bool = objc2::msg_send![window, respondsToSelector: sel];
        if !responds {
            return false;
        }
        let _: () = objc2::msg_send![window, _setPreventsActivation: Bool::YES];
    }
    prevents_activation(window) == Some(true)
}

/// ウィンドウサーバーがこのウィンドウのクリックでアプリをアクティブにしないか (非公開 API)。
/// 応答しない OS では None
pub fn prevents_activation(window: &NSWindow) -> Option<bool> {
    let sel = objc2::sel!(_preventsActivation);
    // SAFETY: respondsToSelector で存在を確かめてから、引数なし・BOOL を返すメソッドとして呼ぶ
    unsafe {
        let responds: bool = objc2::msg_send![window, respondsToSelector: sel];
        responds.then(|| {
            let v: Bool = objc2::msg_send![window, _preventsActivation];
            v.as_bool()
        })
    }
}

/// 開発時の診断: mukuchi が前面アプリになった・外れた時にログに出す (回帰に気づけるように)。
///
/// NSApplication の DidBecomeActive は使わない: パネルのクリックによる切り替えでは
/// ウィンドウサーバー・LaunchServices 上の前面アプリだけが変わり、この通知が来なかったため
/// (実測)。NSWorkspace の通知は前面アプリの変化そのものを表す。
pub fn install_debug_observer() {
    let center = NSWorkspace::sharedWorkspace().notificationCenter();
    let own_pid = NSRunningApplication::currentApplication().processIdentifier();
    let block = RcBlock::new(move |n: NonNull<NSNotification>| {
        // SAFETY: 通知センターが有効な NSNotification を渡す
        let n = unsafe { n.as_ref() };
        // SAFETY: AppKit の定数の読み出し
        let key = unsafe { NSWorkspaceApplicationKey };
        let pid = n
            .userInfo()
            .and_then(|info| info.objectForKey(key))
            .and_then(|app| app.downcast::<NSRunningApplication>().ok())
            .map(|app| app.processIdentifier());
        if pid != Some(own_pid) {
            return;
        }
        // SAFETY: 同上
        if &*n.name() == unsafe { NSWorkspaceDidActivateApplicationNotification } {
            log::warn!("[activation] mukuchi が前面アプリになった");
        } else {
            log::info!("[activation] mukuchi が前面アプリでなくなった");
        }
    });
    // SAFETY: AppKit の定数の読み出し
    let names = unsafe {
        [
            NSWorkspaceDidActivateApplicationNotification,
            NSWorkspaceDidDeactivateApplicationNotification,
        ]
    };
    for name in names {
        // SAFETY: ブロックは pid しか捕まえず、どのスレッドで呼ばれてもよい。
        // 観測者はアプリの終了まで保持するため解放しない
        let token = unsafe {
            center.addObserverForName_object_queue_usingBlock(Some(name), None, None, &block)
        };
        std::mem::forget(token);
    }
}
