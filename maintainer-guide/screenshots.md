# UIギャラリーの写真の撮り直し

[docs/gallery.md](../docs/gallery.md)の写真（`docs/images/`）は、画面を変えたら撮り直します。

- **レビュー依頼の画面（`review-light.png`・`review-dark.png`）**: `INLOOP_UI_E2E=1 INLOOP_SHOT_DIR=<フォルダ> npm test`を動かすと、テストが実ブラウザで画面を開き、写真を`<フォルダ>`に保存します（Playwrightが要ります）。固定データの画面です。`graph-fixture.png`をライト、`review-dark.png`をダークとして使っています。
- **scaffoldの画面（`scaffold-*.png`）**: `inloop new`でアプリを作り、`inloop generate scaffold`で表を足して、`npm run dev`の画面をブラウザで撮ります（ライト、ダーク、狭い画面）。
- **Claude Codeの会話内の画面（`claude-code-review-widget*.png`）**: 実際のClaude Code（デスクトップ）で、アプリを開いて変更を頼み、AIに`request_review`を呼ばせた画面を撮ります。自動では撮れません。幅1200pxに縮めています。
