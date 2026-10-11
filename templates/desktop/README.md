# __APP_NAME__

inloop で作った、手元で単体で動くデスクトップアプリです（画面: React、サーバー: Hono、データベース: SQLite、外枠: Tauri）。

```sh
npm install
npm run dev           # 画面 http://127.0.0.1:5173 、サーバー http://127.0.0.1:8787
npm run dev:desktop   # デスクトップアプリとして開く（Rustが要る。初回は同梱用のサーバーも作る）
npm test
npm run package       # 画面とサーバーをビルドして、インストーラーを作る（Rustが要る。macOSでは .app と .dmg）
```

サーバーは、Nodeの単一実行ファイルにまとめてアプリに同梱し、アプリが起動時に動かします（`scripts/build-sidecar.mjs`）。
作るのは今のOS向けだけです。WindowsとLinux向けは、それぞれのOSで`npm run package`を動かします（CIならOSごとのジョブ）。
AIへの指示は [AGENTS.md](AGENTS.md) にあります。
