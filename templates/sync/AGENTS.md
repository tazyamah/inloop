# __APP_NAME__

このリポジトリは inloop で作ったアプリです。人はコードを書かず、AIが書いたコードをレビューします。

## 構成

- `web/`: 画面（React、Vite）
- `server/`: Hono。`/api` の要求を受ける。サーバーでは動かさず、`server/worker.ts` がWeb Workerの中で動かす（画面の `fetch("/api/...")` は `web/src/local-api.ts` がWorkerへ渡す）
- `server/db.ts`: データベース（SQLite）。コードは `node:sqlite` の使い方で書く（テストはNode.jsで動く）。ブラウザ向けのビルドでは、`vite.config.ts` が `node:sqlite` を `server/sqlite-wasm.ts`（sqlite-wasm、OPFSに保存）に差し替える。`DatabaseSync` の `exec`、`prepare` の `all`・`get`・`run` だけを使う（ほかは `sqlite-wasm.ts` に足してから）
- `server/routes/`、`web/src/pages/`: `inloop generate scaffold` が作る資源ごとのAPIと画面。新しい資源（例: タスク）は、手で書かずに `inloop generate scaffold task title:text done:bool` で作る。型は `text`・`int`・`real`・`bool`・`date`、省略できる列は `note:text:optional`。作ったあとに足りないところ（独自の検証、画面の見た目）を直す。見た目の変数は `web/src/style.css`
- `server/sync/`: 端末どうしの同期（`engine.ts`、`crypto.ts`、`membership.ts`）。`relay/`: 中継（Cloudflare Workers + Durable Objects）。仕組みは [README.md](README.md) の「共有のしくみ」と、inloopのADR-0041
- 新しい資源（表）は、`inloop generate scaffold task title:text done:bool` で作る。共有のアプリでは、同期する表（下の列を持つ）、`server/sync-tables.ts` への登録、`uid`で扱うAPIと画面が作られる。手で足すときも、次の決まりに従う
- 同期する表は、`uid`（文字列の主キー）、`created_at`・`updated_at`（ミリ秒）、`deleted`（消したら行を残して1にする）、`dirty` の列を持ち、`server/sync-tables.ts` に書く。API は、書き込みのたびに `dirty = 1` と `updated_at` を更新し、`sync?.touch()` を呼ぶ（`server/app.ts` の notes の例）
- 同期の暗号・参加者の記録・中継の認可は、信頼境界ルール（`inloop.json`）に当たる。変更は、レビューを依頼する
- `npm run dev` で動かし、`npm test` でサーバーのテスト（Node.js）、`npm run build` で型検査と静的ファイルのビルド。配り方は [README.md](README.md)（PWAとして端末に入れる）。ネットワークのサーバーはなく、`fetch` で `/api` 以外を呼ぶとインターネットに出るので、宛先を決めてから使う

## レビュー依頼（inloop）

- 機能を作り終えたら、inloop の `request_review` で人にレビューを依頼する。観点が複数あれば1回の呼び出しにまとめる
- 観点は具体的な問いにし、対象のシンボルID（例: `server/app.ts#createApp`）を付ける。コードは渡さない
- `repo` には、このリポジトリの絶対パスを渡す（クライアントが作業フォルダを知らせる場合は省略できる）
- 返ってきたURLを人に示し（ブラウザで開けるならそうする）、手番を終えて会話を待つ。人が画面のボタンで答えたと言ったら、`get_review_result` で回答を読む
- `fix` は直してから `follows` を付けて再依頼する。`ask` には会話で答える
- 議論は会話で行う。人が画面からコピーした位置（例: `R3 server/app.ts#createApp#L12-L15`）を貼って話しかけてくる
- 人が会話で承認・保留の言葉（既定は「承認」「保留」、`~/.inloop/config.json` で変えられる）をはっきり言ったときだけ、`answer_review` で記録する。`said` には人が言った言葉をそのまま渡す。言葉がなければ記録しない
- 依頼票が行数の上限（既定60行）を超えると断られる。対象のシンボルを分けて、別々の依頼にする
- 信頼境界ルール（`inloop.json`）に当たる変更には、inloop が必須の依頼を自動で加える（戻り値の `required:`）。必須の依頼は省けず、会話からは記録できないので、人に画面で答えてもらう
- 作業を終える前に `inloop check --range main` を動かす。承認されていない必須の依頼があれば、`request_review`（`reviews` は空でよい）で依頼する
- 特定のテーブルや列だけに必須の依頼を足したいときは、`inloop.json` の `match` に `{"table": "orders", "access": ["write"], "columns": ["status"]}` のように書く（`access` と `columns` は省ける。`columns` を足すと、その列に触れるSQLだけに当たる）
- `inloop.json` を変えると、それ自体が必須の依頼になる。ルールを消したり弱めたりする変更は、人に理由を説明する
