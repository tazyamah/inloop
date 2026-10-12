# __APP_NAME__

inloop で作った、端末の中だけで動くアプリです（画面: React、サーバー: Hono、データベース: SQLite）。
サーバーは使いません。Honoは画面とは別のWeb Workerの中で動き、データはブラウザのOPFSに保存したSQLiteに残ります。

```sh
npm install
npm run dev       # http://127.0.0.1:5173
npm test          # server/ のテスト（Node.jsで動かす）
npm run build     # 型検査と、dist/web への静的ファイルの出力
npm run preview   # 作った静的ファイルを 127.0.0.1 で確かめる
```

`dist/web` を、HTTPSの静的ファイルの置き場所（Cloudflare Pagesなど）に置くか、Tailscale Serveで配ると、iPhone・Androidのブラウザで開いて「ホーム画面に追加」できます。一度開いたあとは、オフラインでも動きます。
データは、開いた端末のブラウザの中にだけあります。ブラウザのデータを消すと失われ、端末どうしでは同期されません。
OPFSの保存領域は同時に1つのタブしか開けないので、同じアプリを複数のタブで開かないでください。

AIへの指示は [AGENTS.md](AGENTS.md) にあります。
