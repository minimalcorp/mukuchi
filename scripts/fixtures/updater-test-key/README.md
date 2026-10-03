# テスト専用の updater 署名鍵 (本番では使わない)

`scripts/sign-updater.test.mjs` のフィクスチャ。公開してよい使い捨ての鍵で、アプリ (`tauri.conf.json` の `plugins.updater.pubkey`) とは無関係。

- `test-only.key` / `test-only.key.pub`: `pnpm -C apps/desktop tauri signer generate --ci -p mukuchi-test-only -w test-only.key` (tauri-cli 2.12.0) で作った鍵。パスワードは `mukuchi-test-only`
- `mukuchi_aarch64.app.tar.gz`: 署名対象のダミー (テキスト。tar.gz ではない。名前は trusted comment の `file:` を本番と同じにするため)
- `tauri-signer.sig`: `tauri signer sign -f test-only.key -p mukuchi-test-only --app-version 1.2.3 mukuchi_aarch64.app.tar.gz` の出力 (tauri-cli 2.12.0)

作り直す時は3つとも作り直す。
