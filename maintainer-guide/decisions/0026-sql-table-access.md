# ADR-0026: SQL文字列から読む・書くテーブルを取り出し、依頼票に出す

- 状態: Accepted
- 日付: 2026-10-12
- Supersedes: なし

## 背景

最初の対象はTypeScript＋SQL（ADR-0005）で、優先する構成のDBはSQLite。依頼票は関数の依存を示すが、そのコードがどのテーブルを読み書きするかは、SQLの文字列を読まないと分からない。

## 決定

- 依頼票に省略できる`tables`（`{symbol, table, access}`、`access`は`read`・`write`・`schema`）を足す。`symbol`は必ずstepsのシンボル。記録の版は1のまま。
- 取り出す対象は、依頼票に並べた宣言の中の`.prepare(<式>)`・`.exec(<式>)`の第1引数。
  - 式が文字列リテラル（置換なしのテンプレートを含む）で、SQLの文で始まるもの（select・insert・update・delete・replace・create・drop・alter・pragma・with・begin・commit・rollback・vacuum）だけ読む。正規表現の`exec("select")`などは数えない。
  - `prepare`の引数が文字列として読めない（変数、置換つきのテンプレートなど）ものは、推測せず`unresolved`に`file:line 動的なSQL 式`として出す。`exec`の動的な引数は、正規表現の`exec`と区別できないので出さない。
- SQLの読み方は字句による簡易的なもので、構文を完全には解析しない。`FROM`・`JOIN`の直後は`read`、`INSERT INTO`・`REPLACE INTO`・`UPDATE`・`DELETE FROM`は`write`、`CREATE`・`DROP`・`ALTER`の`TABLE`・`INDEX`・`VIEW`・`TRIGGER`は`schema`。コメント・文字列は無視し、CTE（`WITH x AS`）の名前は除く。副問い合わせの中も読む。
- ファイルを指すシンボル（`#`のないID）、呼び出し先でSQLを実行する関数の中身（間接）は対象にしない。画面には「データベースのテーブル」の一覧を出す。

## 理由

- 文字列からコードだけで決まる情報で、AIの推測を混ぜない（ADR-0002）。読めない形は未解決として人に見せる（fail-closed）。
- 完全なSQL構文解析は依存が大きい。テーブル名を拾うだけなら字句で足り、読み違えは「拾えない」側に倒れる。

## 影響

- 依頼票に項目が増えるが、既存の記録は`tables`なしのまま読める。
- `prepare`・`exec`以外の名前（ORMなど）は対象外。`CASE`や副問い合わせ以外の複雑な形、`FROM`の後の`ON`句の中のカンマなどは読み違えうる。
- テーブルの列は扱わない。信頼境界ルールをテーブルで当てることはまだしない。

## 却下した代替案

- SQLパーサーの依存を足す: SQLiteの方言の差とバージョン追従の負担が大きい。
- 動的なSQLを推測で補う: ADR-0002に反する。

## 検証

`npm test`で、読む・書く・スキーマ、CTE、副問い合わせ、コメントと文字列の無視、動的なSQLの未解決、正規表現の`exec`を数えないことを確かめる。実際のクライアントでの表示、画面写真は未検証。

## 関連資料

- [ADR-0002](0002-deterministic-review-projection.md)
- [ADR-0005](0005-typescript-first-and-self-hosting.md)
- [ADR-0015](0015-typescript-analysis-engine-v1.md)
