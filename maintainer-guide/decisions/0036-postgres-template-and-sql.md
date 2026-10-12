# ADR-0036: PostgreSQLの雛形と、PostgreSQLの書き方のSQL解析

- 状態: Accepted
- 日付: 2026-10-12
- Supersedes: なし（ADR-0011の「データベースのオプションとしてPostgreSQLを用意する」を実装する。ADR-0026のSQL解析の入力に、PostgreSQLの書き方を足す）

## 背景

ADR-0011で、標準のデータベースはSQLiteとし、PostgreSQLをオプションに用意すると決めたが、`inloop new --db postgres`は「雛形がない」と断っていた。SQL解析（ADR-0026、ADR-0030、ADR-0031）は字句による読みで、SQLiteの書き方を前提にしていた。PostgreSQLのSQLでは、`$1`・`::型`・`$$`・`RETURNING`・`TRUNCATE`・`COPY`・`ONLY`・修飾名`"public"."t"`が出て、そのまま読むとテーブルを取り違える（`timestamp with time zone`の`with`をCTEとみなす、`ONLY`をテーブル名とみなす、など）。

## 決定

### 雛形

- `inloop new <dir> --db postgres`は、`templates/server/`の上に`templates/postgres/`を重ねて作る（`--desktop`と同じ重ね方）。重ねるのは`package.json`、`inloop.json`、`AGENTS.md`、`README.md`、`server/{db,app,index}.ts`、`server/app.test.ts`。画面（`web/`）は共通のまま。
- ドライバは`pg`。`server/db.ts`の`Db`は`query(sql, params)`だけを持つ最小の型にする（`pg`の`Pool`とPGliteが満たす）。接続先は環境変数`DATABASE_URL`。`openDb`は非同期にする。
- テストは`openDb("memory:")`でPGlite（メモリ上のPostgreSQL）を使う。外のPostgreSQLなしで`npm test`が通る。PGliteは`devDependencies`で、`memory:`のときだけ動的にimportする。
- 雛形の`inloop.json`は、`db-write`の照合を`{"import": "pg"}`にし、`db-schema`は共通のまま。
- `--db postgres`と`--desktop`は組み合わせられない（手元のアプリは同梱のSQLiteを使う。ADR-0019）。
- `--db`が`sqlite`でも`postgres`でもなければ断る。

### SQL解析

- 字句: `$tag$ ... $tag$`と`E'...'`を文字列として空にする。`[...]`は、名前らしい中身（英字か`_`で始まる）のときだけ引用符つきの名前にする（`int[]`・`a[1]`を名前にしない）。`"public"."t"`のように引用符が混ざった単純な修飾名は`public.t`の1語にする。
- 文: `TRUNCATE [TABLE] [ONLY] a, b`は`write`（全列）、`COPY t [(列)] FROM`は`write`、`COPY t TO`は`read`、`COPY (SELECT ...) TO`は中の文を読む。`ONLY`は読み飛ばす（`FROM ONLY`、`UPDATE ONLY`、`DELETE FROM ONLY`、`ALTER TABLE [IF EXISTS] ONLY`）。`CREATE [OR REPLACE] [UNLOGGED|MATERIALIZED|...]`と`CREATE INDEX CONCURRENTLY`の修飾語を読み飛ばす。`timestamp with time zone`の`with`はCTEとみなさない。
- 名前: 既定のスキーマ`public.`の接頭辞は外す（`public.notes`と`notes`は同じテーブル）。ほかのスキーマ名は残す。
- 入口: `looksLikeSql`に`truncate`・`copy`を足す。依頼票の対象に、`query(...)`の引数のSQLを足す（`prepare`・`exec`に加えて）。`query`は何にでもある名前なので、文字列として読めない引数は、先頭の固定部分がSQLらしい（`"SELECT ..." + x`、`` `DELETE FROM ${t}` ``）ときだけ「動的なSQL」として未解決にする。

## 理由

- 雛形は、ADR-0011の「サーバーのコードとSQLを共通にする」を保てる範囲（`Db`の差し替え）で作る。ORMを入れると、AIが書く文の形が変わり、解析の対象が見えなくなる。
- 方言ごとに別のパーサーは持たない。字句による読みを保ち、読めない形は拾わない（ADR-0002、AGENTS.md）。動的なSQLは推測せず未解決にする。
- PGliteにすると、利用者がPostgreSQLを入れる前に`npm test`が通り、AIが作る機能の最初の検証が止まらない。

## 影響

- 雛形が2つの重ね方（`--desktop`、`--db postgres`）になる。`templates/postgres/`は共通の`templates/server/`の`inloop.json`などの複製を含む。共通側の変更は、両方に反映する。
- `query`という名前の呼び出しで、SQLらしい文字列を渡すものは、PostgreSQL以外でも依頼票の`tables`に出る。
- 読めないもの（残る）: `client.query({ text: "..." })`の形、`sql`タグ付きテンプレート、関数本体（`$$`の中）のSQL、`"a b"."c"`のように空白を含む修飾名、`search_path`で決まるスキーマ。`pg`の`Pool`の`query`が別の名前に包まれていれば検出できない（呼び出し元の関数は`prepare`のときと同じく、定義を追えば読める）。
- 実際のPostgreSQLに対する検証はしていない（PGliteまで）。接続文字列の扱い、接続プール、移行の手順は雛形に入れていない。`db-schema`の必須の依頼が移行の判断を促す。

## 却下した代替案

- ORM（Drizzle、Prisma）を雛形に入れる: 解析が文字列のSQLを前提にしており、ORMの呼び出しからはテーブルが読めない。
- 本物のPostgreSQLをテストで要求する: 雛形が最初の`npm test`で失敗し、AIの作業が止まる。
- SQLiteと同じ`Db`（同期API）に合わせる: PostgreSQLのドライバは非同期なので、無理なラッパーになる。

## 検証

- `test/sql.test.mjs`: PostgreSQLの書き方の読み、`query(...)`の静的・動的なSQL。`test/stdio.test.mjs`: `--db postgres`の雛形の内容と、断る組み合わせ。
- 生成した雛形の`npm install && npm test && npm run build`を手元（macOS）で通した（2 pass）。生成したアプリに対する依頼票の`tables`が`notes`の読み書きを出すことも確認した。
- 実際のPostgreSQLに接続して`npm run dev`を動かすこと、クライアントでの使用は未検証。
