# __APP_NAME__

このリポジトリはinloopで作ったアプリです。人はコードを書かず、AIが書いたコードをレビューします。

## 構成

- `web/`: 画面（React、Vite）
- `server/`: サーバー（Hono）。`/api` の要求を受ける
- `server/db.ts`: データベース（SQLite、Node.js組み込みの `node:sqlite`）
- `server/routes/`、`web/src/pages/`: `inloop generate scaffold` が作る資源ごとのAPIと画面。新しい資源（例: タスク）は、手で書かずに `inloop generate scaffold task title:text done:bool` で作る。型は `text`・`int`・`real`・`bool`・`date`・`image`（端末の中で縮小した画像。データURLとして text の列に入る。`web/src/image.ts`）、省略できる列は `note:text:optional`。作ったあとに足りないところ（独自の検証、画面の見た目）を直す。見た目の変数は `web/src/style.css`
- `npm run dev` で両方を動かし、`npm test` でサーバーのテスト、`npm run build` で型検査と画面のビルド

## レビュー依頼（inloop）

- 機能を作り終えたら、inloop の `request_review` で人にレビューを依頼する。観点が複数あれば1回の呼び出しにまとめる
- 観点は具体的な問いにし、対象のシンボルID（例: `server/app.ts#createApp`）を付ける。コードは渡さない
- `repo` には、このリポジトリの絶対パスを渡す（Codexでは全ツール呼び出しに渡す。ほかのクライアントでも、roots通知を確認できるまでは省略しない）
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


## ユースケースの命名規則（`inloop lint`の`uc-*`、`inloop usecases`）

- 画面や外部から使われるHTTPの入口を「ユースケース」とし、入口ごとに、読む・書くテーブルと列、その入口へ要求を送るテストを、コードから決めて一覧にする（`inloop usecases`、レビュー依頼票の「ユースケース」）。結び付けは次の書き方に頼るので、外れると`inloop lint`・`npm test`が失敗する
  - `uc-app-name`: Honoの変数は`const app = new Hono()`の名前にする
  - `uc-route-literal`: 入口は`app.get("/path", …)`（`post`・`put`・`patch`・`delete`も）で登録し、パスは`/`で始まる文字列のリテラルにする。まとめて付けるときは`app.route("/prefix", xxxRoutes(db))`の形にする。`app.on`・`app.mount`・`app.all`は使わない
  - `uc-route-duplicate`: 同じメソッドと同じパスの入口を2つ作らない
  - `uc-test-request`: テストの`app.request(…)`は、パスを文字列かテンプレート（`/api/tasks/${id}`）で書き、メソッドは省略（GET）・`{ method: "POST" }`・`json("POST", …)`のどれかで書く
- 入口のSQLは、入口のハンドラーか、そこから呼ぶ関数（2段まで）に、固定の文字列で書く。そうでないSQLは「未解決」として一覧に出る
- 新しい入口を足したら、その入口へ要求を送るテストも足す。テストのない入口は、依頼票と`inloop usecases`に「テストなし」と出る
- この対応は、値の流れ（どの入力がどの列に入るか）と、テストが何を確かめているかは示さない。入口を動かすテストがあることだけを示す

## クライアント設定

inloopはClaude Codeの`.mcp.json`とCodexの`.codex/config.toml`を用意する。Codexではプロジェクトを信頼して設定を読み直す。`inloop`をPATHから起動できない場合は、利用者の設定にNode.jsとinloop本体の絶対パスで登録する。端末固有のパスをリポジトリにcommitしない。MCP接続を確認できない場合は、その事実を伝え、レビューの記録や承認を代わりに作らない。
