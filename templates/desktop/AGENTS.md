# __APP_NAME__

このリポジトリは inloop で作った、手元で単体で動くデスクトップアプリです。人はコードを書かず、AIが書いたコードをレビューします。

## 構成

- `web/`: 画面（React、Vite）
- `server/`: サーバー（Hono）。`/api` の要求を受ける。デスクトップアプリでは、1つの実行ファイル（Nodeの単一実行ファイル）にまとめてアプリに同梱し、`127.0.0.1` の空いているポートで動かす
- `server/db.ts`: データベース（SQLite、Node.js組み込みの `node:sqlite`）。デスクトップアプリでは、アプリのデータフォルダの `app.db`
- `src-tauri/`: 外枠（Tauri、Rust）。開発中は画面（vite）を開き、本番では同梱したサーバーを起動してそのURLを開く
- `npm run dev` で画面とサーバーを動かし、`npm run dev:desktop` でデスクトップアプリとして動かす。`npm test` でサーバーのテスト、`npm run package` でインストーラーを作る（Rustが要る）

## レビュー依頼（inloop）

- 機能を作り終えたら、inloop の `request_review` で人にレビューを依頼する。観点が複数あれば1回の呼び出しにまとめる
- 観点は具体的な問いにし、対象のシンボルID（例: `server/app.ts#createApp`、`src-tauri/src/lib.rs#start_server`）を付ける。コードは渡さない
- `repo` には、このリポジトリの絶対パスを渡す（クライアントが作業フォルダを知らせる場合は省略できる）
- 返ってきたURLを人に示し（ブラウザで開けるならそうする）、手番を終えて会話を待つ。人が画面のボタンで答えたと言ったら、`get_review_result` で回答を読む
- 議論は会話で行う。人が画面からコピーした位置（例: `R3 server/app.ts#createApp#L12-L15`）を貼って話しかけてくる
- 人が会話で承認・保留の言葉をはっきり言ったときだけ、`answer_review` で記録する。`said` には人が言った言葉をそのまま渡す
- 依頼票が行数の上限を超えると断られる。対象のシンボルを分けて、別々の依頼にする
- 信頼境界ルール（`inloop.json`。Tauriの権限、同梱サーバーの起動を含む）に当たる変更には、inloop が必須の依頼を自動で加える（戻り値の `required:`）。必須の依頼は省けず、会話からは記録できないので、人に画面で答えてもらう
- 作業を終える前に `inloop check --range main` を動かす。承認されていない必須の依頼があれば、`request_review`（`reviews` は空でよい）で依頼する
- 特定のテーブルや列だけに必須の依頼を足したいときは、`inloop.json` の `match` に `{"table": "orders", "access": ["write"], "columns": ["status"]}` のように書く（`access` と `columns` は省ける。`columns` を足すと、その列に触れるSQLだけに当たる）
- `inloop.json` を変えると、それ自体が必須の依頼になる。ルールを消したり弱めたりする変更は、人に理由を説明する
