# __APP_NAME__

このリポジトリはinloopで作ったアプリです。人はコードを書かず、AIが書いたコードをレビューします。

## 構成

- `web/`: 画面（React、Vite）
- `server/`: Hono。`/api` の要求を受ける。サーバーでは動かさず、`server/worker.ts` がWeb Workerの中で動かす（画面の `fetch("/api/...")` は `web/src/local-api.ts` がWorkerへ渡す）
- `server/db.ts`: データベース（SQLite）。コードは `node:sqlite` の使い方で書く（テストはNode.jsで動く）。ブラウザ向けのビルドでは、`vite.config.ts` が `node:sqlite` を `server/sqlite-wasm.ts`（sqlite-wasm、OPFSに保存）に差し替える。`DatabaseSync` の `exec`、`prepare` の `all`・`get`・`run` だけを使う（ほかは `sqlite-wasm.ts` に足してから）
- `server/routes/`、`web/src/pages/`: `inloop generate scaffold` が作る資源ごとのAPIと画面。新しい資源（例: タスク）は、手で書かずに `inloop generate scaffold task title:text done:bool` で作る。型は `text`・`int`・`real`・`bool`・`date`・`image`（端末の中で縮小した画像。データURLとして text の列に入る。`web/src/image.ts`）、省略できる列は `note:text:optional`。作ったあとに足りないところ（独自の検証、画面の見た目）を直す。見た目の変数は `web/src/style.css`
- `server/sync/`: 端末どうしの同期（`engine.ts`、`crypto.ts`、`membership.ts`）。`relay/`: 中継（Cloudflare Workers + Durable Objects）。仕組みは [README.md](README.md) の「共有のしくみ」と、inloopのADR-0041
- 新しい資源（表）は、`inloop generate scaffold task title:text done:bool` で作る。共有のアプリでは、同期する表（下の列を持つ）、`server/sync-tables.ts` への登録、`uid`で扱うAPIと画面が作られる。手で足すときも、次の決まりに従う
- 同期する表は、`uid`（文字列の主キー）、`created_at`・`updated_at`（ミリ秒）、`deleted`（消したら行を残して1にする）、`dirty` の列を持ち、`server/sync-tables.ts` に書く。API は、書き込みのたびに `dirty = 1` と `updated_at` を更新し、`sync?.touch()` を呼ぶ（`server/app.ts` の notes の例）
- 同期の暗号・参加者の記録・中継の認可は、信頼境界ルール（`inloop.json`）に当たる。変更は、レビューを依頼する
- `server/backup.ts`: データの書き出し・読み込み（「データ」画面）。表と列は、データベースの中にあるものと照らして使う。表を足しても、書き換えなくてよい（`sync_state`は書き出さない）
- `npm run dev` で動かし、`npm test` でサーバーのテスト（Node.js）、`npm run build` で型検査と静的ファイルのビルド。配り方は [README.md](README.md)（PWAとして端末に入れる）。ネットワークのサーバーはなく、`fetch` で `/api` 以外を呼ぶとインターネットに出るので、宛先を決めてから使う

## レビュー依頼（inloop）

- 機能を作り終えたら、inloop の `request_review` で人にレビューを依頼する。観点が複数あれば1回の呼び出しにまとめる
- 観点は具体的な問いにし、対象のシンボルID（例: `server/app.ts#createApp`）を付ける。コードは渡さない
- `repo` には、このリポジトリの絶対パスを渡す（Claude Codeは作業フォルダを知らせるので省略できる。Codexはroots通知が未確認なので、全ツール呼び出しに渡す）
- 返ってきたURLを人に示し（ブラウザで開けるならそうする）、手番を終えて会話を待つ。人が画面のボタンで答えたと言ったら、`get_review_result` で回答を読む
- `fix` は直してから `follows` を付けて再依頼する。`ask` には会話で答える
- 議論は会話で行う。人が画面からコピーした位置（例: `R3 server/app.ts#createApp#L12-L15`）を貼って話しかけてくる
- 人が会話で承認・保留の言葉（既定は「承認」「保留」、`~/.inloop/config.json` で変えられる）をはっきり言ったときだけ、`answer_review` で記録する。`said` には人が言った言葉をそのまま渡す。言葉がなければ記録しない
- 依頼票が行数の上限（既定60行）を超えると断られる。対象のシンボルを分けて、別々の依頼にする
- 信頼境界ルール（`inloop.json`）に当たる変更には、inloop が必須の依頼を自動で加える（戻り値の `required:`）。必須の依頼は省けず、会話からは記録できないので、人に画面で答えてもらう
- 作業を終える前に、依頼と同じ基点で `inloop check --range <基点>` を動かす。未commitの変更と初回のアプリは `HEAD`、マージ前は実在する取り込み先のブランチを使う。承認されていない必須の依頼があれば、`request_review`（`reviews` は空でよい）で依頼する
- 特定のテーブルや列だけに必須の依頼を足したいときは、`inloop.json` の `match` に `{"table": "orders", "access": ["write"], "columns": ["status"]}` のように書く（`access` と `columns` は省ける。`columns` を足すと、その列に触れるSQLだけに当たる）
- `inloop.json` を変えると、それ自体が必須の依頼になる。ルールを消したり弱めたりする変更は、人に理由を説明する

## セキュアコードの規則（`inloop lint`）

- `npm test`と`npm run build`の最初に`inloop lint`が動き、次の規則に反するコードがあると失敗する。IPAの注意喚起（2026-10-09）から導いた、構文だけで決まる規則で、書いた時点で気づくためにここに挙げる。違反を許す書き方（コメントで無効にするなど）はない
  - `sec-sql-literal`: `prepare`・`exec`に渡すSQLは固定の文字列にし、値は`?`で渡す（文字列の連結・`${}`で組み立てない）
  - `sec-shell`: `exec`・`execSync`・`shell: true`を使わない。`execFile`・`spawn`に引数の列で渡す
  - `sec-eval`: `eval`、`new Function`、文字列の`setTimeout`を使わない
  - `sec-html`: `dangerouslySetInnerHTML`、`innerHTML`への代入、`document.write`を使わない
  - `sec-secret`: パスワード・鍵・トークンをコードに書かない。環境変数などから渡す
  - `sec-crypto`: MD5・SHA-1・DES・ECB・`createCipher`を使わない。パスワードのハッシュは`crypto.scrypt`、トークンは`crypto.randomBytes`
  - `sec-tls`: 証明書の検証を無効にしない（`rejectUnauthorized: false`など）
  - `sec-cleartext`: 外部との通信は`https://`・`wss://`にする（`localhost`は除く）
  - `sec-bind`: サーバーの待ち受けは`127.0.0.1`に限る（`serve`には`hostname: "127.0.0.1"`を付ける）
  - `sec-cors`: CORSの許可元を`*`にしない
  - `sec-cookie`: `setCookie`には`httpOnly: true`と`sameSite`を付ける
  - `sec-log`: パスワード・トークン・`process.env`の値を`console`に出さない
  - `sec-stack`: スタックトレース（`.stack`）を応答に載せない
  - `sec-unchecked`: すべての`.ts`・`.tsx`を`tsconfig.json`の`include`に入れる（入っていないと検査できない）
- どうしても例外が要るときは、`inloop.json`の`secure.allow`（`rule`、`files`、`reason`）に書く。`inloop.json`の変更は必須の依頼になるので、人が理由を確かめる。`package.json`・`tsconfig.json`の変更（検査を外す変更を含む）も必須の依頼になる
- 作業を終える前の`inloop check`は、必須の依頼に加えて、この検査も動かす


## クライアント設定

inloopはClaude Codeの`.mcp.json`とCodexの`.codex/config.toml`を用意する。Codexではプロジェクトを信頼して設定を読み直す。`inloop`をPATHから起動できない場合は、利用者の設定にNode.jsとinloop本体の絶対パスで登録する。端末固有のパスをリポジトリにcommitしない。MCP接続を確認できない場合は、その事実を伝え、レビューの記録や承認を代わりに作らない。
