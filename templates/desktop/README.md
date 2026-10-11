# __APP_NAME__

inloop で作った、手元で単体で動くデスクトップアプリです（画面: React、サーバー: Hono、データベース: SQLite、外枠: Tauri）。

```sh
npm install
npm run dev           # 画面 http://127.0.0.1:5173 、サーバー http://127.0.0.1:8787
npm run dev:desktop   # デスクトップアプリとして開く（Rustが要る。初回は同梱用のサーバーも作る）
npm test
npm run package       # 画面とサーバーをビルドして、インストーラーを作る（Rustが要る。macOSでは .app と .dmg）
npm run icon -- dark  # アイコンを作り直す（light / dark / 自分の元絵のPNG・SVGのパス）
```

サーバーは、Nodeの単一実行ファイルにまとめてアプリに同梱し、アプリが起動時に動かします（`scripts/build-sidecar.mjs`）。
作るのは今のOS向けだけです。WindowsとLinux向けは、それぞれのOSで`npm run package`を動かします（CIならOSごとのジョブ）。
AIへの指示は [AGENTS.md](AGENTS.md) にあります。

アイコンは、ライト版を `src-tauri/icons/` に置いてあり、既定ではこれを使います。ダーク版の元絵（`src-tauri/icons/source/`）は置いてあるだけで、使うときは `npm run icon -- dark`（または元絵のパス）で `src-tauri/icons/` を作り直します。
