//! メニューバーのアイコン (NSStatusItem のボタン画像)。
//!
//! 通常はテンプレート画像 (メニューバーの明暗に AppKit が合わせて着色する)。エラー時だけ赤い点を
//! 重ねるため非テンプレートにするが、そのままだとグリフの色が明暗に追従しないので、描画時に
//! 呼ばれるハンドラでグリフを `labelColor` (描画時の外観で解決される) で塗ってから赤い点を描く。
//! メインスレッドで呼ぶこと。

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::Bool;
use objc2::{AllocAnyThread, MainThreadMarker};
use objc2_app_kit::{
    NSBezierPath, NSBitmapImageRep, NSColor, NSCompositingOperation, NSGraphicsContext, NSImage,
    NSRectFillUsingOperation, NSStatusItem,
};
use objc2_foundation::{NSData, NSPoint, NSRect, NSSize};

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
    /// グリフ + 右上の赤い点 (エラー)
    WithRedDot(IconPng),
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

pub fn set(item: &NSStatusItem, mtm: MainThreadMarker, icon: StatusIcon) {
    let Some(button) = item.button(mtm) else {
        return;
    };
    let image = match icon {
        StatusIcon::Template(png) => {
            let Some(img) = image_from_png(png) else {
                log::warn!("メニューバーのアイコンを読み込めません");
                return;
            };
            img.setTemplate(true);
            img
        }
        StatusIcon::WithRedDot(png) => {
            let Some(glyph) = image_from_png(png) else {
                log::warn!("メニューバーのアイコンを読み込めません");
                return;
            };
            let handler = RcBlock::new(move |rect: NSRect| -> Bool {
                draw_with_red_dot(&glyph, rect);
                Bool::YES
            });
            let img = NSImage::imageWithSize_flipped_drawingHandler(
                NSSize::new(ICON_PT, ICON_PT),
                false,
                &handler,
            );
            img.setTemplate(false);
            img
        }
    };
    button.setImage(Some(&image));
}

/// 描画ハンドラの中身。座標は左下原点 (flipped=false)。
fn draw_with_red_dot(glyph: &NSImage, rect: NSRect) {
    let Some(ctx) = NSGraphicsContext::currentContext() else {
        return;
    };
    ctx.saveGraphicsState();
    // グリフ (黒のアルファ) を描き、その不透明部分だけを文字色で塗り直す
    glyph.drawInRect(rect);
    NSColor::labelColor().set();
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
    ctx.restoreGraphicsState();
}
