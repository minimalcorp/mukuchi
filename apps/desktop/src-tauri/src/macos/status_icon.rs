//! メニューバーのアイコン (NSStatusItem のボタン画像)。
//!
//! 通常はテンプレート画像 (メニューバーの明暗に AppKit が合わせて着色する)。エラー時だけ赤い点を
//! 重ねるため非テンプレートにするが、そのままだとグリフの色が明暗に追従しないので、
//! 明・暗それぞれの色で @1x/@2x のビットマップを事前に描いておき、メニューバーの外観
//! (`effectiveAppearance`) が変わったら差し替える。
//!
//! `NSImage(size:flipped:drawingHandler:)` は使わない: Apple のドキュメントに「AppKit executes it on
//! the same thread on which you draw the image itself, which can be any thread of your app.
//! Therefore, the block must be safe to call from any thread.」とあり
//! (<https://developer.apple.com/documentation/appkit/nsimage/init(size:flipped:drawinghandler:)>)、
//! メインスレッド専用の AppKit オブジェクトを捕まえたハンドラが別スレッドで呼ばれうるため。
//! このモジュールの関数はメインスレッドで呼ぶこと。

use objc2::rc::Retained;
use objc2::{AllocAnyThread, MainThreadMarker};
use objc2_app_kit::{
    NSAppearance, NSAppearanceCustomization, NSAppearanceNameAqua, NSAppearanceNameDarkAqua,
    NSAppearanceNameVibrantDark, NSAppearanceNameVibrantLight, NSAutoresizingMaskOptions,
    NSBezierPath, NSBitmapImageRep, NSColor, NSCompositingOperation, NSDeviceRGBColorSpace,
    NSGraphicsContext, NSImage, NSRectFillUsingOperation, NSStatusBarButton, NSStatusItem,
};
use objc2_foundation::{NSArray, NSData, NSPoint, NSRect, NSSize};

/// メニューバーのアイコンの大きさ (pt)
const ICON_PT: f64 = 18.0;

/// 状態ごとの画像。PNG は `icons/tray/generate.sh` で作る (@1x = 18px, @2x = 36px)。
#[derive(Clone, Copy)]
pub struct IconPng {
    pub x1: &'static [u8],
    pub x2: &'static [u8],
}

#[derive(Clone, Copy)]
pub enum StatusIcon {
    Template(IconPng),
    /// グリフ + 右上の赤い点 (エラー)。`dark` はメニューバーが暗い外観か
    WithRedDot {
        png: IconPng,
        dark: bool,
    },
}

/// @1x/@2x の表現を持つ 18pt の画像を作る。
fn image_from_png(png: IconPng) -> Option<Retained<NSImage>> {
    let size = NSSize::new(ICON_PT, ICON_PT);
    let image = NSImage::initWithSize(NSImage::alloc(), size);
    let mut added = false;
    for bytes in [png.x1, png.x2] {
        let data = NSData::with_bytes(bytes);
        if let Some(rep) = NSBitmapImageRep::imageRepWithData(&data) {
            // 論理サイズを揃えると、画面の倍率に合う方を AppKit が選ぶ
            rep.setSize(size);
            image.addRepresentation(&rep);
            added = true;
        }
    }
    added.then_some(image)
}

/// メニューバー (ステータス項目のボタン) が暗い外観か。
pub fn is_dark(item: &NSStatusItem, mtm: MainThreadMarker) -> bool {
    let Some(button) = item.button(mtm) else {
        return false;
    };
    let appearance: Retained<NSAppearance> = button.effectiveAppearance();
    // SAFETY: AppKit が定義する定数の読み出し
    let names = unsafe {
        NSArray::from_slice(&[
            NSAppearanceNameAqua,
            NSAppearanceNameDarkAqua,
            NSAppearanceNameVibrantLight,
            NSAppearanceNameVibrantDark,
        ])
    };
    let best = appearance.bestMatchFromAppearancesWithNames(&names);
    // SAFETY: 同上
    best.is_some_and(|n| unsafe {
        &*n == NSAppearanceNameDarkAqua || &*n == NSAppearanceNameVibrantDark
    })
}

pub fn set(item: &NSStatusItem, mtm: MainThreadMarker, icon: StatusIcon) {
    let Some(button) = item.button(mtm) else {
        return;
    };
    let Some(image) = make_image(icon) else {
        log::warn!("メニューバーのアイコンを作成できません");
        return;
    };
    button.setImage(Some(&image));
    fit_click_target(&button);
}

/// tray-icon がボタンに重ねるクリック受け (`TaoTrayTarget`) のクラス名 (tray-icon 0.25 `platform_impl/macos`)
const TRAY_TARGET_CLASS: &str = "TaoTrayTarget";

/// tray-icon はボタンの上に透明な NSView を重ね、その mouseDown で左クリック時にメニューを出す
/// (`show_menu_on_left_click`)。この NSView の大きさは tray-icon 経由でアイコン・タイトルを変えた時だけ
/// ボタンに合わせ直される (`update_dimensions`)。ここでは画像を直接差し替えるため、合わせ直さないと
/// アイコン無しで作った時の幅 (16pt) のまま残り、それより右のクリックは下のボタンに届いて
/// 左クリックでメニューが出ない。以後の大きさの変化にも追従させるため自動リサイズも付ける。
fn fit_click_target(button: &NSStatusBarButton) {
    let bounds = button.bounds();
    let mut found = false;
    for view in button.subviews() {
        if view.class().name().to_bytes() == TRAY_TARGET_CLASS.as_bytes() {
            view.setFrame(bounds);
            view.setAutoresizingMask(
                NSAutoresizingMaskOptions::ViewWidthSizable
                    | NSAutoresizingMaskOptions::ViewHeightSizable,
            );
            found = true;
        }
    }
    if !found {
        // tray-icon の実装が変わった時に気付けるように
        log::warn!(
            "メニューバーのクリック受けが見つかりません (左クリックでメニューが出ない可能性)"
        );
    }
}

fn make_image(icon: StatusIcon) -> Option<Retained<NSImage>> {
    match icon {
        StatusIcon::Template(png) => image_from_png(png).inspect(|img| img.setTemplate(true)),
        StatusIcon::WithRedDot { png, dark } => render_with_red_dot(png, dark),
    }
}

/// グリフを外観に合う色で塗り、赤い点を重ねたビットマップ (@1x/@2x) を描く。
fn render_with_red_dot(png: IconPng, dark: bool) -> Option<Retained<NSImage>> {
    let glyph = image_from_png(png)?;
    let size = NSSize::new(ICON_PT, ICON_PT);
    let image = NSImage::initWithSize(NSImage::alloc(), size);
    // テンプレート画像がメニューバーで描かれる色に合わせる (暗: 白 / 明: 黒)
    let color = if dark {
        NSColor::whiteColor()
    } else {
        NSColor::blackColor()
    };
    for scale in [1isize, 2] {
        let px = ICON_PT as isize * scale;
        // SAFETY: planes に null を渡すと NSBitmapImageRep がバッファを確保する。
        // 8bit×RGBA (4 samples, alpha あり, 非planar)、行バイト数・ピクセルビット数は 0 で自動計算
        let rep = unsafe {
            NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel(
                NSBitmapImageRep::alloc(),
                std::ptr::null_mut(),
                px,
                px,
                8,
                4,
                true,
                false,
                NSDeviceRGBColorSpace,
                0,
                0,
            )
        }?;
        rep.setSize(size);
        let ctx = NSGraphicsContext::graphicsContextWithBitmapImageRep(&rep)?;
        NSGraphicsContext::saveGraphicsState_class();
        NSGraphicsContext::setCurrentContext(Some(&ctx));
        draw_with_red_dot(
            &ctx,
            &glyph,
            &color,
            NSRect::new(NSPoint::new(0.0, 0.0), size),
        );
        ctx.flushGraphics();
        NSGraphicsContext::restoreGraphicsState_class();
        image.addRepresentation(&rep);
    }
    image.setTemplate(false);
    Some(image)
}

/// 座標は左下原点。
fn draw_with_red_dot(ctx: &NSGraphicsContext, glyph: &NSImage, color: &NSColor, rect: NSRect) {
    // グリフ (黒のアルファ) を描き、その不透明部分だけを指定色で塗り直す
    glyph.drawInRect(rect);
    color.set();
    NSRectFillUsingOperation(rect, NSCompositingOperation::SourceAtop);

    // 赤い点 (直径 7pt、右上)。デザインどおり点の周り 1.5pt を切り抜いて背景色の縁に見せる
    let r = 3.5;
    let (cx, cy) = (rect.size.width - r, rect.size.height - r);
    let ring = r + 1.5;
    ctx.setCompositingOperation(NSCompositingOperation::Clear);
    NSBezierPath::bezierPathWithOvalInRect(NSRect::new(
        NSPoint::new(cx - ring, cy - ring),
        NSSize::new(ring * 2.0, ring * 2.0),
    ))
    .fill();
    ctx.setCompositingOperation(NSCompositingOperation::SourceOver);
    NSColor::systemRedColor().setFill();
    NSBezierPath::bezierPathWithOvalInRect(NSRect::new(
        NSPoint::new(cx - r, cy - r),
        NSSize::new(r * 2.0, r * 2.0),
    ))
    .fill();
}

/// テスト・目視確認用: メニューバーに出る見た目を `scale` 倍のビットマップに描く。
/// テンプレート画像は AppKit と同様に外観の色 (暗: 白 / 明: 黒) で塗る。
#[cfg(test)]
pub(crate) fn render_for_test(
    icon: StatusIcon,
    dark: bool,
    scale: isize,
) -> Option<Retained<NSBitmapImageRep>> {
    let image = make_image(icon)?;
    let size = NSSize::new(ICON_PT, ICON_PT);
    let px = ICON_PT as isize * scale;
    // SAFETY: render_with_red_dot と同じ (バッファは NSBitmapImageRep が確保する)
    let rep = unsafe {
        NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel(
            NSBitmapImageRep::alloc(),
            std::ptr::null_mut(),
            px,
            px,
            8,
            4,
            true,
            false,
            NSDeviceRGBColorSpace,
            0,
            0,
        )
    }?;
    rep.setSize(size);
    let ctx = NSGraphicsContext::graphicsContextWithBitmapImageRep(&rep)?;
    NSGraphicsContext::saveGraphicsState_class();
    NSGraphicsContext::setCurrentContext(Some(&ctx));
    let rect = NSRect::new(NSPoint::new(0.0, 0.0), size);
    image.drawInRect(rect);
    if image.isTemplate() {
        if dark {
            NSColor::whiteColor().set();
        } else {
            NSColor::blackColor().set();
        }
        NSRectFillUsingOperation(rect, NSCompositingOperation::SourceAtop);
    }
    ctx.flushGraphics();
    NSGraphicsContext::restoreGraphicsState_class();
    Some(rep)
}

#[cfg(test)]
mod tests {
    use super::TRAY_TARGET_CLASS;

    /// `fit_click_target` は tray-icon の内部 (クリック受けのクラス名・大きさの合わせ方) に依存する。
    /// tray-icon を上げた時は、クラス名が同じで左クリックがメニューを開くことを確認してからこの版を更新する
    /// (確認: アイコンの右端付近を左クリックしてメニューが開くこと)
    #[test]
    fn tray_icon_version_is_verified() {
        let lock = include_str!("../../Cargo.lock");
        let version = lock
            .split("[[package]]")
            .find(|p| p.contains("\nname = \"tray-icon\"\n"))
            .and_then(|p| p.lines().find_map(|l| l.strip_prefix("version = ")))
            .expect("Cargo.lock に tray-icon がない");
        assert_eq!(
            version, "\"0.25.1\"",
            "{TRAY_TARGET_CLASS} を確認して更新する"
        );
    }
}
