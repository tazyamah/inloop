# UIギャラリーの写真の撮り直し

[docs/gallery.md](../docs/gallery.md)の写真（`docs/images/`）は、画面を変えたら撮り直します。

- **レビュー依頼の画面（`review-light.png`・`review-dark.png`）**: `INLOOP_UI_E2E=1 INLOOP_SHOT_DIR=<フォルダ> npm test`を動かすと、テストが実ブラウザで画面を開き、写真を`<フォルダ>`に保存します（Playwrightが要ります）。固定データの画面です。`graph-fixture.png`をライト、`review-dark.png`をダークとして使っています。
- **scaffoldの画面（`scaffold-*.png`）**: `inloop new`でアプリを作り、`inloop generate scaffold`で表を足して、`npm run dev`の画面をブラウザで撮ります（ライト、ダーク、狭い画面）。
- **Claude Codeの会話内の画面（`claude-code-review-widget*.png`）**: 実際のClaude Codeの画面ではなく、実際のエンジンの依頼票を、会話風の枠（`test/harness/host.mjs`と同じ方法でレビューUIを埋め込み、上に依頼文とAIの返答を並べたHTML）に入れてPlaywrightで撮ったものです。`inloop new`と`inloop generate scaffold`でアプリを作ってcommitし、`server/routes/tasks.ts`のDELETEに「`done = 1`のタスクだけ削除、未完了は409」の変更を足して（`tasks-demo`相当）、`range: "HEAD"`で`request_review`を呼びます。実際の画面は、Claude Code（デスクトップ）でアプリを開いて変更を頼み、AIに依頼させて撮ります。幅1200pxに縮めます。
- **依頼票の図の文書（`docs/diagrams/`）**: `npm run build && node scripts/diagram-samples.mjs`で、題材のアプリを作って実際の依頼票とUIから撮り直します（Playwrightが要ります）。手順は[docs/diagrams.md](../docs/diagrams.md#サンプルの作り直し)。
