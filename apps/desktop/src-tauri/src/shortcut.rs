//! ON/OFF のグローバルショートカット (docs/architecture.md「操作」)。
//!
//! 登録は tauri-plugin-global-shortcut (macOS は Carbon `RegisterEventHotKey`) で Rust からのみ行う
//! (フロントエンドにプラグインの command を許可しない)。押下時の処理は `Core::on_shortcut`。
//!
//! プラグインの登録・解除はメインスレッドで実行され、呼び出し元はその完了を待つ。
//! 登録を伴う操作 (`init` / `change` / `set_suspended`) はメインスレッド (同期 command・setup) から呼ぶ。
//! 別スレッドから呼ぶと、メインスレッドが `inner` のロックを待っている時に詰まりうるため。

use std::sync::Mutex;

use anyhow::{anyhow, bail, Result};
use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

/// 修飾キーの名前と並び (docs/architecture.md の `Settings.shortcut`)
const MODIFIERS: [&str; 4] = ["Ctrl", "Alt", "Shift", "Cmd"];

/// `Settings.shortcut` の形式 ("Ctrl+Alt+Shift+Cmd+<KeyboardEvent.code>" の修飾1つ以上) を検証して解釈する。
pub fn parse(s: &str) -> Result<Shortcut> {
    let tokens: Vec<&str> = s.split('+').collect();
    let (key, mods) = tokens
        .split_last()
        .ok_or_else(|| anyhow!("ショートカットが空です"))?;
    if mods.is_empty() {
        bail!("ショートカットには修飾キー (Ctrl・Alt・Shift・Cmd) が1つ以上必要です: {s}");
    }
    let mut prev: Option<usize> = None;
    for m in mods {
        let Some(i) = MODIFIERS.iter().position(|x| x == m) else {
            bail!("ショートカットの修飾キーが不正です: {s}");
        };
        if prev.is_some_and(|p| i <= p) {
            bail!("ショートカットの修飾キーは Ctrl・Alt・Shift・Cmd の順に1回ずつ指定します: {s}");
        }
        prev = Some(i);
    }
    let shortcut: Shortcut = s
        .parse()
        .map_err(|e| anyhow!("ショートカットを解釈できません: {s} ({e})"))?;
    // 解析器は "M" "1" 等の別名や大文字小文字の違いも通すため、KeyboardEvent.code の綴りに限る
    // (保存される文字列を1つに定め、フロントエンドの表示と食い違わないようにする)
    let code = shortcut.key.to_string();
    if code != *key || !supported_key(&code) {
        bail!("ショートカットのキーに使えません: {key}");
    }
    Ok(shortcut)
}

/// メディアキー・音量キーは global-hotkey が Carbon ではなくイベントタップで扱い (挙動が異なる)、
/// ロックキーは状態が切り替わるため使わせない
fn supported_key(code: &str) -> bool {
    !(code.starts_with("Media") || code.starts_with("AudioVolume") || code.ends_with("Lock"))
}

/// docs/architecture.md の `ShortcutStatus`
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutStatus {
    pub shortcut: Option<String>,
    pub registered: bool,
    /// 登録できなかった時の表示用 (日本語)
    pub error: Option<String>,
}

/// OS への登録・解除 (テストで差し替える)
pub trait Registrar: Send + Sync {
    fn register(&self, shortcut: Shortcut) -> Result<()>;
    fn unregister(&self, shortcut: Shortcut) -> Result<()>;
}

/// tauri-plugin-global-shortcut による登録
pub struct PluginRegistrar(pub AppHandle);

impl Registrar for PluginRegistrar {
    fn register(&self, shortcut: Shortcut) -> Result<()> {
        self.0
            .global_shortcut()
            .register(shortcut)
            .map_err(|e| anyhow!("{e}"))
    }

    fn unregister(&self, shortcut: Shortcut) -> Result<()> {
        self.0
            .global_shortcut()
            .unregister(shortcut)
            .map_err(|e| anyhow!("{e}"))
    }
}

#[derive(Default)]
struct Inner {
    /// 設定の値 (登録できたかによらない)
    configured: Option<String>,
    /// OS に登録中のもの
    registered: Option<Shortcut>,
    /// キーの記録中 (`set_shortcut_suspended`)。この間は登録を外す
    suspended: bool,
    error: Option<String>,
}

impl Inner {
    fn status(&self) -> ShortcutStatus {
        ShortcutStatus {
            shortcut: self.configured.clone(),
            registered: self.registered.is_some(),
            error: self.error.clone(),
        }
    }
}

type Notify = Box<dyn Fn(&ShortcutStatus) + Send + Sync>;

pub struct ShortcutManager {
    registrar: Box<dyn Registrar>,
    notify: Notify,
    inner: Mutex<Inner>,
}

/// 登録できなかった時の表示。詳細 (OS のエラー) はログにだけ出す
fn register_error(s: &str) -> String {
    format!(
        "ショートカット「{}」を登録できませんでした。別のキーに変更してください",
        display(s)
    )
}

/// 文章中の表示 ("Alt+Space" → "⌥ Space")。フロントエンドの `formatShortcut`
/// (apps/desktop/src/lib/shortcut.ts) と同じ表記にする (エラー文と画面の表示を揃えるため)
pub fn display(s: &str) -> String {
    let mut tokens: Vec<&str> = s.split('+').collect();
    let key = tokens.pop().unwrap_or_default();
    let mut parts: Vec<String> = tokens
        .iter()
        .map(|t| {
            match *t {
                "Ctrl" => "⌃",
                "Alt" => "⌥",
                "Shift" => "⇧",
                "Cmd" => "⌘",
                other => other,
            }
            .to_string()
        })
        .collect();
    parts.push(key_label(key));
    parts.join(" ")
}

fn key_label(code: &str) -> String {
    let fixed = match code {
        "Enter" => "↩",
        "Tab" => "⇥",
        "Backspace" => "⌫",
        "Delete" => "⌦",
        "Escape" => "⎋",
        "ArrowUp" => "↑",
        "ArrowDown" => "↓",
        "ArrowLeft" => "←",
        "ArrowRight" => "→",
        "Home" => "↖",
        "End" => "↘",
        "PageUp" => "⇞",
        "PageDown" => "⇟",
        "Minus" => "-",
        "Equal" => "=",
        "BracketLeft" => "[",
        "BracketRight" => "]",
        "Backslash" => "\\",
        "Semicolon" => ";",
        "Quote" => "'",
        "Comma" => ",",
        "Period" => ".",
        "Slash" => "/",
        "Backquote" => "`",
        "IntlYen" => "¥",
        "IntlRo" => "_",
        _ => "",
    };
    if !fixed.is_empty() {
        return fixed.to_string();
    }
    // "KeyM" → "M"、"Digit1" → "1"、"Numpad1" → "1" (1文字の時だけ。JS の正規表現と同じ)
    for (prefix, digits_only) in [("Key", false), ("Digit", false), ("Numpad", true)] {
        if let Some(rest) = code.strip_prefix(prefix) {
            let mut chars = rest.chars();
            if let (Some(c), None) = (chars.next(), chars.next()) {
                if !digits_only || c.is_ascii_digit() {
                    return c.to_string();
                }
            }
        }
    }
    code.to_string()
}

impl ShortcutManager {
    pub fn new(
        registrar: impl Registrar + 'static,
        notify: impl Fn(&ShortcutStatus) + Send + Sync + 'static,
    ) -> Self {
        Self {
            registrar: Box::new(registrar),
            notify: Box::new(notify),
            inner: Mutex::new(Inner::default()),
        }
    }

    pub fn status(&self) -> ShortcutStatus {
        self.lock().status()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// 状態が変わっていれば通知する (ロックを外してから)
    fn finish(&self, before: ShortcutStatus, guard: std::sync::MutexGuard<'_, Inner>) {
        let after = guard.status();
        drop(guard);
        if after != before {
            (self.notify)(&after);
        }
    }

    fn try_register(&self, s: &str) -> Result<Shortcut> {
        let shortcut = parse(s)?;
        self.registrar.register(shortcut)?;
        Ok(shortcut)
    }

    /// 起動時の登録。失敗しても起動は止めず、状態に表示用のエラーを持つ
    pub fn init(&self, configured: Option<String>) {
        let mut g = self.lock();
        let before = g.status();
        g.configured = configured.clone();
        g.error = None;
        if let Some(s) = configured {
            match self.try_register(&s) {
                Ok(sc) => {
                    log::info!("ショートカットを登録: {s}");
                    g.registered = Some(sc);
                }
                Err(e) => {
                    log::warn!("ショートカット {s} を登録できません: {e:#}");
                    g.error = Some(register_error(&s));
                }
            }
        }
        self.finish(before, g);
    }

    /// 設定の変更。登録できなければ元の登録に戻して Err (設定は保存させない)。
    /// 成功時は元の設定値を返す (保存に失敗した時に `rollback` に渡す)
    pub fn change(&self, next: Option<String>) -> Result<Option<String>> {
        let mut g = self.lock();
        // 同じ値でも、登録できていない (起動時の失敗) なら登録し直す
        if g.configured == next && (g.registered.is_some() || g.suspended || next.is_none()) {
            return Ok(next);
        }
        let before = g.status();
        let new = next.as_deref().map(parse).transpose()?;
        if g.suspended {
            // 記録中は登録を外したまま。登録できるかだけ確かめる (戻した時に失敗しないように)
            if let Some(sc) = new {
                self.registrar.register(sc).map_err(|e| {
                    log::warn!("ショートカットを登録できません: {e:#}");
                    anyhow!(register_error(next.as_deref().unwrap_or_default()))
                })?;
                if let Err(e) = self.registrar.unregister(sc) {
                    log::warn!("確認のために登録したショートカットを解除できません: {e:#}");
                }
            }
        } else {
            let old = g.registered.take();
            if let Some(o) = old {
                if let Err(e) = self.registrar.unregister(o) {
                    log::warn!("ショートカットを解除できません: {e:#}");
                }
            }
            if let Some(sc) = new {
                if let Err(e) = self.registrar.register(sc) {
                    log::warn!("ショートカットを登録できません: {e:#}");
                    if let Some(o) = old {
                        match self.registrar.register(o) {
                            Ok(()) => g.registered = Some(o),
                            Err(e) => {
                                // 設定は元の値のままだが登録が外れた。画面で気付けるようにする
                                log::warn!("元のショートカットに戻せません: {e:#}");
                                if let Some(prev) = g.configured.clone() {
                                    g.error = Some(register_error(&prev));
                                }
                            }
                        }
                    }
                    let msg = register_error(next.as_deref().unwrap_or_default());
                    self.finish(before, g);
                    return Err(anyhow!(msg));
                }
                g.registered = Some(sc);
            }
        }
        log::info!(
            "ショートカットを変更: {}",
            next.as_deref().unwrap_or("(なし)")
        );
        let prev = std::mem::replace(&mut g.configured, next);
        g.error = None;
        self.finish(before, g);
        Ok(prev)
    }

    /// 設定を保存できなかった時に元のショートカットへ戻す (できなければ状態にエラーを持つ)
    pub fn rollback(&self, prev: Option<String>) {
        if let Err(e) = self.change(prev.clone()) {
            log::warn!("ショートカットを元に戻せません: {e:#}");
            let mut g = self.lock();
            let before = g.status();
            g.configured = prev;
            g.error = Some(format!("{e}"));
            self.finish(before, g);
        }
    }

    /// キーの記録中は登録を外す (記録のために押したキーで ON/OFF しないため)。
    /// 戻す時に登録できなければ状態にエラーを持つ (`shortcut-status-changed` で知らせる)
    pub fn set_suspended(&self, suspended: bool) {
        let mut g = self.lock();
        if g.suspended == suspended {
            return;
        }
        let before = g.status();
        g.suspended = suspended;
        if suspended {
            if let Some(sc) = g.registered.take() {
                if let Err(e) = self.registrar.unregister(sc) {
                    log::warn!("ショートカットを一時解除できません: {e:#}");
                }
            }
        } else if let Some(s) = g.configured.clone() {
            match self.try_register(&s) {
                Ok(sc) => {
                    g.registered = Some(sc);
                    g.error = None;
                }
                Err(e) => {
                    log::warn!("ショートカット {s} を登録し直せません: {e:#}");
                    g.error = Some(register_error(&s));
                }
            }
        }
        self.finish(before, g);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn parse_accepts_spec_format_only() {
        for ok in [
            "Alt+Space",
            "Ctrl+Shift+KeyM",
            "Ctrl+Alt+Shift+Cmd+Digit1",
            "Cmd+F5",
            "Alt+Semicolon",
            "Shift+ArrowUp",
        ] {
            assert!(parse(ok).is_ok(), "{ok}");
        }
        let sc = parse("Ctrl+Alt+Shift+Cmd+KeyM").unwrap();
        use tauri_plugin_global_shortcut::{Code, Modifiers};
        assert_eq!(sc.key, Code::KeyM);
        assert_eq!(
            sc.mods,
            Modifiers::CONTROL | Modifiers::ALT | Modifiers::SHIFT | Modifiers::SUPER
        );
        for bad in [
            "",
            "Space",
            "KeyM",
            "Shift+Alt+Space", // 並び
            "Alt+Alt+Space",   // 重複
            "alt+Space",       // 綴り
            "Option+Space",
            "Alt+M",     // code でない
            "Alt+space", // 大文字小文字
            "Alt+1",
            "Alt+",
            "Alt+Space+KeyM",
            "Alt+Foo",
            "Alt+MediaPlayPause",
            "Alt+AudioVolumeUp",
            "Alt+CapsLock",
        ] {
            assert!(parse(bad).is_err(), "{bad} は不正");
        }
    }

    #[test]
    fn display_matches_frontend_format() {
        assert_eq!(display("Alt+Space"), "⌥ Space");
        assert_eq!(display("Ctrl+Alt+Shift+Cmd+KeyM"), "⌃ ⌥ ⇧ ⌘ M");
        assert_eq!(display("Cmd+Digit1"), "⌘ 1");
        assert_eq!(display("Shift+ArrowUp"), "⇧ ↑");
        assert_eq!(display("Alt+F5"), "⌥ F5");
        assert_eq!(display("Alt+Backslash"), "⌥ \\");
        assert_eq!(
            register_error("Alt+Space"),
            "ショートカット「⌥ Space」を登録できませんでした。別のキーに変更してください"
        );
    }

    #[test]
    fn failed_restore_is_reported() {
        let (m, fake, _) = manager();
        m.init(Some("Alt+Space".into()));
        // 新しいキーも、元に戻す登録も失敗する
        fake.reject.lock().unwrap().push(parse("Cmd+KeyK").unwrap());
        fake.reject
            .lock()
            .unwrap()
            .push(parse("Alt+Space").unwrap());
        assert!(m.change(Some("Cmd+KeyK".into())).is_err());
        let s = m.status();
        assert_eq!(s.shortcut.as_deref(), Some("Alt+Space"));
        assert!(!s.registered);
        assert!(s.error.unwrap().contains("⌥ Space"));
    }

    /// 登録を記録し、指定のキーだけ失敗する
    #[derive(Default)]
    struct Fake {
        registered: Mutex<Vec<Shortcut>>,
        reject: Mutex<Vec<Shortcut>>,
    }

    impl Registrar for Arc<Fake> {
        fn register(&self, sc: Shortcut) -> Result<()> {
            if self.reject.lock().unwrap().contains(&sc) {
                bail!("RegisterEventHotKey failed");
            }
            let mut r = self.registered.lock().unwrap();
            if r.contains(&sc) {
                bail!("already registered");
            }
            r.push(sc);
            Ok(())
        }
        fn unregister(&self, sc: Shortcut) -> Result<()> {
            self.registered.lock().unwrap().retain(|x| *x != sc);
            Ok(())
        }
    }

    fn manager() -> (ShortcutManager, Arc<Fake>, Arc<Mutex<Vec<ShortcutStatus>>>) {
        let fake = Arc::new(Fake::default());
        let events = Arc::new(Mutex::new(Vec::new()));
        let ev = events.clone();
        let m = ShortcutManager::new(fake.clone(), move |s: &ShortcutStatus| {
            ev.lock().unwrap().push(s.clone())
        });
        (m, fake, events)
    }

    fn registered(f: &Fake) -> Vec<Shortcut> {
        f.registered.lock().unwrap().clone()
    }

    #[test]
    fn init_failure_is_reported_not_fatal() {
        let (m, fake, events) = manager();
        fake.reject
            .lock()
            .unwrap()
            .push(parse("Alt+Space").unwrap());
        m.init(Some("Alt+Space".into()));
        let s = m.status();
        assert_eq!(s.shortcut.as_deref(), Some("Alt+Space"));
        assert!(!s.registered);
        assert!(s.error.is_some());
        assert_eq!(events.lock().unwrap().len(), 1);

        let (m, fake, _) = manager();
        m.init(Some("Alt+Space".into()));
        assert!(m.status().registered);
        assert_eq!(registered(&fake), vec![parse("Alt+Space").unwrap()]);
        let (m, _, _) = manager();
        m.init(None);
        assert_eq!(
            m.status(),
            ShortcutStatus {
                shortcut: None,
                registered: false,
                error: None
            }
        );
    }

    #[test]
    fn change_replaces_and_restores_on_failure() {
        let (m, fake, events) = manager();
        m.init(Some("Alt+Space".into()));
        let prev = m.change(Some("Ctrl+KeyM".into())).unwrap();
        assert_eq!(prev.as_deref(), Some("Alt+Space"));
        assert_eq!(registered(&fake), vec![parse("Ctrl+KeyM").unwrap()]);

        // 登録できないキー: 元の登録に戻して Err、設定値も元のまま
        fake.reject.lock().unwrap().push(parse("Cmd+KeyK").unwrap());
        assert!(m.change(Some("Cmd+KeyK".into())).is_err());
        assert_eq!(registered(&fake), vec![parse("Ctrl+KeyM").unwrap()]);
        assert_eq!(m.status().shortcut.as_deref(), Some("Ctrl+KeyM"));
        assert!(m.status().registered);
        // 形式の誤りは登録を触らない
        assert!(m.change(Some("KeyK".into())).is_err());
        assert_eq!(registered(&fake), vec![parse("Ctrl+KeyM").unwrap()]);

        // 無効化と保存失敗時の取り消し
        let prev = m.change(None).unwrap();
        assert!(registered(&fake).is_empty());
        m.rollback(prev);
        assert_eq!(registered(&fake), vec![parse("Ctrl+KeyM").unwrap()]);
        assert!(events.lock().unwrap().len() >= 4);
    }

    #[test]
    fn suspend_unregisters_and_resume_registers_latest() {
        let (m, fake, events) = manager();
        m.init(Some("Alt+Space".into()));
        m.set_suspended(true);
        assert!(registered(&fake).is_empty());
        assert!(!m.status().registered);
        // 記録中の変更は確かめるだけで登録しない
        m.change(Some("Ctrl+KeyM".into())).unwrap();
        assert!(registered(&fake).is_empty());
        fake.reject.lock().unwrap().push(parse("Cmd+KeyK").unwrap());
        assert!(m.change(Some("Cmd+KeyK".into())).is_err());
        assert_eq!(m.status().shortcut.as_deref(), Some("Ctrl+KeyM"));
        m.set_suspended(false);
        assert_eq!(registered(&fake), vec![parse("Ctrl+KeyM").unwrap()]);
        assert!(m.status().registered);
        // 同じ値の繰り返しは何もしない
        let n = events.lock().unwrap().len();
        m.set_suspended(false);
        assert_eq!(events.lock().unwrap().len(), n);
    }
}
