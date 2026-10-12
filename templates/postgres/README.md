# __APP_NAME__

inloop で作ったアプリです（画面: React、サーバー: Hono、データベース: PostgreSQL）。

```sh
npm install
export DATABASE_URL=postgres://localhost/__APP_NAME__   # 先に createdb __APP_NAME__
npm run dev     # 画面 http://127.0.0.1:5173 、サーバー http://127.0.0.1:8787
npm test
npm run build   # 型検査と画面のビルド。npm start で、ビルドした画面とサーバーを動かす
```

AIへの指示は [AGENTS.md](AGENTS.md) にあります。
