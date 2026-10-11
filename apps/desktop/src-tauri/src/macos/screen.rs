//! ディスプレイ (NSScreen) と前面ウィンドウの位置。メインスレッドで呼ぶこと。
//!
//! 座標はすべて AppKit のグローバル座標 (主ディスプレイの左下が原点、y は上向き、単位 pt)。

use objc2::rc::Retained;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSScreen, NSWorkspace};
use objc2_core_foundation::CFRetained;
use objc2_core_graphics::{kCGNullWindowID, CGWindowListCopyWindowInfo, CGWindowListOption};
use objc2_foundation::{NSArray, NSDictionary, NSNumber, NSPoint, NSRect, NSString};

use crate::windows::geometry::{Rect, ScreenInfo};

pub fn to_rect(r: NSRect) -> Rect {
    Rect {
        x: r.origin.x,
        y: r.origin.y,
        w: r.size.width,
        h: r.size.height,
    }
}

fn info(s: &NSScreen) -> ScreenInfo {
    ScreenInfo {
        id: screen_id(s).unwrap_or_default(),
        frame: to_rect(s.frame()),
        visible: to_rect(s.visibleFrame()),
    }
}

fn screen_id(s: &NSScreen) -> Option<String> {
    let desc = s.deviceDescription();
    let v = desc.objectForKey(&NSString::from_str("NSScreenNumber"))?;
    let n = v.downcast_ref::<NSNumber>()?;
    Some(n.unsignedIntValue().to_string())
}

pub fn screens(mtm: MainThreadMarker) -> Vec<ScreenInfo> {
    NSScreen::screens(mtm).iter().map(|s| info(&s)).collect()
}

pub fn screen_by_id(mtm: MainThreadMarker, id: &str) -> Option<ScreenInfo> {
    screens(mtm).into_iter().find(|s| s.id == id)
}

/// 点を含むディスプレイ (なければ最も近いもの)。
pub fn screen_at(mtm: MainThreadMarker, p: (f64, f64)) -> Option<ScreenInfo> {
    let all = screens(mtm);
    if let Some(i) = all.iter().position(|s| s.frame.contains(p)) {
        return all.into_iter().nth(i);
    }
    all.into_iter()
        .min_by(|a, b| a.frame.distance_sq(p).total_cmp(&b.frame.distance_sq(p)))
}

/// 前面アプリの最前面ウィンドウがあるディスプレイ。取れなければ主ディスプレイ。
///
/// ウィンドウの位置 (kCGWindowBounds) は画面収録の許可なしで取得できる (名前は取らない)。
pub fn frontmost_window_screen(mtm: MainThreadMarker) -> Option<ScreenInfo> {
    let primary = NSScreen::screens(mtm).firstObject().map(|s| s.frame());
    if let (Some(center), Some(primary)) = (frontmost_window_center_cg(), primary) {
        // CoreGraphics の座標 (主ディスプレイ左上が原点、y 下向き) を AppKit の座標に直す
        let p = (center.x, primary.size.height - center.y);
        return screen_at(mtm, p);
    }
    NSScreen::mainScreen(mtm).map(|s| info(&s))
}

fn frontmost_window_center_cg() -> Option<NSPoint> {
    let pid = NSWorkspace::sharedWorkspace()
        .frontmostApplication()?
        .processIdentifier();
    let list = CGWindowListCopyWindowInfo(
        CGWindowListOption::OptionOnScreenOnly | CGWindowListOption::ExcludeDesktopElements,
        kCGNullWindowID,
    )?;
    // SAFETY: CFArray と NSArray は toll-free bridged。要素は CFDictionary (= NSDictionary)
    let list: Retained<NSArray<NSDictionary<NSString, objc2::runtime::AnyObject>>> = unsafe {
        let raw = CFRetained::into_raw(list).as_ptr().cast();
        Retained::from_raw(raw)?
    };
    let key = |k: &str| NSString::from_str(k);
    let num = |d: &NSDictionary<NSString, objc2::runtime::AnyObject>, k: &str| -> Option<f64> {
        d.objectForKey(&key(k))?
            .downcast_ref::<NSNumber>()
            .map(|n| n.doubleValue())
    };
    // 一覧は前面から順に並ぶ。通常のウィンドウ (layer 0) のうち前面アプリの最初のもの
    for w in list.iter() {
        if num(&w, "kCGWindowOwnerPID") != Some(pid as f64)
            || num(&w, "kCGWindowLayer") != Some(0.0)
        {
            continue;
        }
        let Some(bounds) = w.objectForKey(&key("kCGWindowBounds")) else {
            continue;
        };
        let Some(b) = bounds.downcast_ref::<NSDictionary>() else {
            continue;
        };
        let get = |k: &str| -> Option<f64> {
            b.objectForKey(&*key(k))?
                .downcast_ref::<NSNumber>()
                .map(|n| n.doubleValue())
        };
        let (Some(x), Some(y), Some(width), Some(height)) =
            (get("X"), get("Y"), get("Width"), get("Height"))
        else {
            continue;
        };
        if width < 1.0 || height < 1.0 {
            continue;
        }
        return Some(NSPoint::new(x + width / 2.0, y + height / 2.0));
    }
    None
}
