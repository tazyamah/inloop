# ADR-0042: `inloop generate scaffold`を、共有（`--sync`）のアプリに対応させる

- 状態: Accepted
- 日付: 2026-10-13
- Supersedes: ADR-0041の「`inloop generate scaffold`は、`--sync`のアプリには、まだ使えない」の部分だけ

## 背景

ADR-0041で、共有のアプリには`inloop generate scaffold`を使えない（案内して断る）としていた。同期する表は、整数のidではなく、端末ごとに作れる`uid`、ミリ秒の時刻、`deleted`、`dirty`の列が要るため。しかし、`inloop new --sync`を「オプション一発」の標準にするなら、新しい資源も、同じ決まった形で作れる必要がある（利用者の方針、2026-10-12）。

## 決定

- `server/sync-tables.ts`があるアプリ（`inloop new --sync`で作ったもの）では、`inloop generate scaffold`が、共有用の表・API・テスト・画面を作る。コマンドの使い方は変わらない。
- 表: `uid TEXT PRIMARY KEY`、指定した列、`deleted`、`created_at`・`updated_at`（ミリ秒の整数）、`dirty`。`server/db.ts`の目印の前に足す。
- `server/sync-tables.ts`に、同期の定義を、目印`// inloop:sync-tables`の前に足す。`text`は最大1000文字、`date`は10文字のtext、`int`・`real`・`bool`はそのまま、省略できる列は`optional`にする。
- API（`server/routes/<複数形>.ts`）: `<名前>Routes(db, now, sync?)`。一覧は`deleted = 0`だけ、作成は`crypto.randomUUID()`のuidで`dirty = 1`、更新は`updated_at`を更新して`dirty = 1`、削除は行を残して`deleted = 1`。書き込みのたびに`sync?.touch()`を呼ぶ。パスのuidは形を確かめる。`server/app.ts`には、`(db, now, sync)`を渡して足す。
- 画面は、サーバー向けの画面を、uid・ミリ秒の時刻に直し、他の端末の変更を取り込んだとき（`local-api-changed`）に読み直す。
- 同期の仕組み（`server/sync/engine.ts`）の列の型に、`real`と、省略できる列の`null`、負の整数を足す。

## 理由

- 同期の対象になる表の形を決まった生成にすれば、AIが毎回書き方を変えて、同期の規則（`dirty`、`deleted`、`updated_at`）を破る余地が減り、レビューする人の負担も減る（ADR-0038と同じ考え方）。
- 生成のSQLは固定の文だけなので、依頼票が表と列を読み取れる。

## 影響

- 共有のアプリで生成した表は、`created_at`・`updated_at`が整数（ミリ秒）で、サーバー向けのアプリ（文字列の日時）と異なる。
- `server/sync-tables.ts`と、`server/db.ts`の表の定義が食い違うと同期が壊れるので、両方を生成が書く。

## 検証

- `npm test`（このリポジトリ）: 共有のアプリでの生成物（表、同期する表の定義、API、画面）と、依頼票が表と列を読み取れること。
- `INLOOP_APP_E2E=1`: 共有のアプリで、`task`（`text`・`bool`・省略できる`date`・`real`・`int`）を生成して、`npm install`、`npm test`、`npm run build`が通ること（2026-10-13、macOS）。
- 未検証: 生成した表を、実際の2台の端末で同期すること（同期の仕組みは、専用の表のテストで確かめてある）。

## 関連資料

- [ADR-0038](0038-scaffold-generator.md)
- [ADR-0041](0041-approval-based-sync.md)
