# mukuchi ブランド素材

元画像: `mukuchi-logo_master.png` (透過PNG)。

| パス | 用途 |
|---|---|
| `logo/mukuchi-logo_{64,128,256,512,1024,2048}.png` | LP・ドキュメント等のロゴ (余白最小・透過) |
| `web/header-logo_1024.png` | ドキュメントサイトのヘッダーロゴ |
| `web/favicon.ico`, `web/favicon-{16,32,48,96}x*.png` | favicon |
| `web/apple-touch-icon.png` | iOS ホーム画面用 180px (白背景) |
| `web/android-chrome-{192,512}.png`, `web/maskable-512x512.png` | PWA manifest 用 |
| `macos/AppIcon_1024.png`, `macos/AppIcon.icns` | アプリアイコンの元 (1024px、Apple のグリッド相当の余白付き) |
| `dmg/background.png`, `dmg/background@2x.png` | .dmg のウィンドウ背景 (660x400pt と 2x。不透明)。ビルド時に `tiffutil -cathidpicheck` で1つの TIFF にまとめる。矢印は x=265..395・y≈170、手順の文字は y≈313 (左上原点)。アイコン位置は `apps/desktop/scripts/dmg-settings.py` |
| `macos/MenuBarIcon(@2x).png` | メニューバー用 18pt (未使用。テンプレート画像にするなら黒一色化が必要) |

アプリアイコンは `apps/desktop/src-tauri/icons/` に配置済み (`icon.icns` と 32/128/256/1024px の PNG)。差し替える時は `macos/` を更新し、同じ手順で `apps/desktop/src-tauri/icons/` にコピーする。

favicon の HTML 例:

```html
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
```
