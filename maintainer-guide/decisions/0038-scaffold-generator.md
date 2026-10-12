# ADR-0038: 資源の雛形を生成する`inloop generate scaffold`と、雛形の共通の見た目

- 状態: Accepted
- 日付: 2026-10-12
- Supersedes: なし

## 背景

`inloop new`で作ったアプリは、メモが1つあるだけの素の画面で、新しい機能（表、API、画面）はAIが毎回ゼロから書く。書き方がその都度変わるので、レビューする人は形の違いまで読むことになり、解析エンジンが表と列を読み取れない書き方（組み立てたSQL）が混ざる余地もある。利用者は、Railsのscaffoldのように、決まった形を生成する仕組みと、最低限の見た目を求めた（2026-10-12）。

## 決定

### コマンド

- `inloop generate scaffold <名前> <列>... [--plural <名前>] [--label <表示名>]`を、アプリのリポジトリ（gitの作業ツリー）で動かす。例: `inloop generate scaffold task title:text done:bool due:date:optional`
- 名前は単数の`snake_case`。複数形（表名とURL）は英語の単純な規則（`s`・`es`・`ies`）で作り、合わなければ`--plural`で指定する。`--label`は画面のメニューと見出し（既定は複数形）。
- 列は`名前:型`。型は`text`・`int`・`real`・`bool`・`date`（`YYYY-MM-DD`）。省略できる列は`名前:型:optional`（zshなどで`?`が展開されるため、`?`ではなく語にした。引用符で囲めば`名前:型?`も読む）。列名は英小文字・数字・`_`で、`id`・`created_at`・`updated_at`（自動で付く）とSQLの予約語は使えない。型は固定で、列の型の追加は必要になったときに足す。

### 生成するもの

- `server/routes/<複数形>.ts`: Honoの一覧・1件取得・作成・更新・削除。入力は列の型ごとに検証し、SQLは固定の文で値は`?`で渡す。idは数だけを受ける。
- `server/<複数形>.test.ts`: 作成と取得、更新と削除、正しくない入力と存在しないidの拒否。
- `web/src/pages/<複数形（Pascal）>.tsx`: 一覧の表、追加・編集のフォーム、削除。共通のCSS（`web/src/style.css`）のクラスだけを使う。
- 既存のファイルへの追記は、雛形に置いた目印の行の直前に行う: `server/db.ts`の`// inloop:tables`（`CREATE TABLE IF NOT EXISTS`）、`server/app.ts`の`// inloop:imports`と`// inloop:routes`、`web/src/App.tsx`の`// inloop:imports`と`// inloop:pages`。`inloop.json`の`http`レイヤーに`server/routes/*.ts`がなければ足す。
- すでにあるファイルや資源は上書きせず断る。目印がない（古い雛形の）アプリには、書かずに、足す場所を示して断る。生成は、すべての計画を作ってから書く（途中で失敗して中途半端に書かない）。

### 雛形の見た目

- 雛形に共通のCSS（`web/src/style.css`。色・角丸・間隔を変数にし、ライト・ダークと狭い画面に対応）と、メニューつきの画面の枠（`web/src/App.tsx`、`#/<複数形>`で切り替える簡単な表示）を入れる。最初からあるメモは`web/src/pages/Notes.tsx`に移し、同じ見た目にした。
- 対象は`templates/server/`（`--desktop`の雛形は同じ`web/`と`server/`を使う）。

## 理由

- 形を固定すると、AIが書くコードの違いが減り、レビューが差分に集中できる。固定の文だけで生成するので、解析エンジンが表と列を読め、動的なSQLの「未解決」が生まれない（ADR-0002、ADR-0026）。
- 生成物は`db-schema`・`db-write`などの信頼境界ルールに、手書きと同じに当たる。生成を理由にレビューを省く経路は作らない（AGENTS.md）。
- 目印の行への追記なら、正規表現で既存のコードを書き換えるより壊れにくい。
- ライブラリ（UI部品、ルーター）を足さず、CSSの変数だけにすると、依存が増えず、見た目の調整がAIにも人にも分かりやすい。

## 影響

- 生成したコードは手で直してよい。再生成はしない（上書きを断る）ので、独自の変更を壊さない。生成を取り消す`destroy`はない（gitで戻す）。
- 古い雛形から作ったアプリ（例: `inloop-demo`）には、目印を手で足さないと使えない。
- 表の変更（列の追加・削除）の生成はしない。移行は`db-schema`の必須の依頼で、人とAIが決める。
- 画面の列の見出しは列名のまま（日本語の表示名は`--label`と、生成後の手直し）。関連（belongs_to）、並べ替え、検索、ページ送りはない。

## 却下した代替案

- AIにscaffoldの形をスキルとして書かせる: 毎回の差が残り、解析できない書き方が混ざる。
- UIライブラリ（Tailwind、shadcn/ui、MUI）を入れる: 依存と設定が増え、生成するコードの量が増える。必要になったら別のADRで決める。
- 既存のファイルをTypeScriptの構文木で書き換える: 目印の行で足りる。

## 検証

- `test/scaffold.test.mjs`: 名前・列の読み、生成されるファイルと追記の位置、重なりと目印なしの拒否、依頼票が生成したAPIの表と列を読み取り動的なSQLにならないこと。`INLOOP_APP_E2E=1`では、生成したアプリの`npm install`、`npm test`、`npm run build`を動かす（macOSで通った）。
- 生成したアプリを`npm run dev`で動かし、ブラウザの画面で一覧・追加・編集の表示を確認した（ダークテーマ）。
- 未検証: 実際のClaude Codeの会話で、AIが`inloop generate scaffold`を使うか（AGENTS.mdに書いた）。ライトテーマ、狭い画面、`--desktop`のアプリでの表示。
