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

「データ」画面で、データをファイルに書き出し・読み込めます（端末を替えるときや、ブラウザのデータを消す前のバックアップ）。

`dist/web` を、HTTPSの静的ファイルの置き場所（Cloudflare Pagesなど）に置くか、Tailscale Serveで配ると、iPhone・Androidのブラウザで開いて「ホーム画面に追加」できます。一度開いたあとは、オフラインでも動きます。
データは、開いた端末のブラウザの中にだけあります。ブラウザのデータを消すと失われ、端末どうしでは同期されません。
OPFSの保存領域は同時に1つのタブしか開けないので、同じアプリを複数のタブで開かないでください。

AIへの指示は [AGENTS.md](AGENTS.md) にあります。

## Chrome拡張として使う

同じアプリを、Chrome拡張（ポップアップ）としても使えます。拡張も、データは拡張の中（OPFSのSQLite）に残り、サーバーは要りません。

```sh
npm run build:extension    # dist/extension に、拡張を出す
```

Chromeで `chrome://extensions` を開き、「デベロッパー モード」をオンにして、「パッケージ化されていない拡張機能を読み込む」で `dist/extension` を選びます。拡張のアイコンを押すとポップアップが開き、拡張の詳細の「拡張機能のオプション」で、タブいっぱいに開けます。
拡張のID（鍵は `web/extension/manifest.json` の `key`）は、アプリごとに決まっていて、読み込む場所が変わっても同じです。ポップアップは、閉じると止まる（共有の同期も、開いている間だけ動く）ので、ずっとつないでおきたいときは、タブで開いてください。
