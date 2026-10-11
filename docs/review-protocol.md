# レビュー依頼のプロトコル

依頼ID、状態遷移、記録、依頼票の項目は確定しています（[ADR-0007](../maintainer-guide/decisions/0007-append-only-review-log.md)、[ADR-0008](../maintainer-guide/decisions/0008-group-requests-per-call.md)、[ADR-0009](../maintainer-guide/decisions/0009-request-lifecycle-and-branch-ids.md)）。解析エンジンに関わる部分は、末尾の未決事項のとおり草案です。

## 依頼票

| 項目 | 作り手 | 内容 |
|---|---|---|
| 観点 | AI | 「このエラー時に既存データを残す方針でよいか」のような具体的な問い |
| 種別 | エンジン | `required`（信頼境界ルールによる必須）または`optional`（AIによる任意） |
| 対象 | エンジン | 関係するシンボルを理解順に並べたもの、データの流れ、影響範囲 |
| 証拠 | エンジン＋CI | 対応するテストと結果、静的解析などの結果 |
| 回答 | 人 | 下記の列挙値と、行・シンボルに紐づくコメント |

AIが渡す入力は、依頼ごとの観点の文と対象シンボルIDの列、共通のcommit範囲、対象のリポジトリ（`repo`、省略できる場合がある）だけです。再依頼では、元の依頼のIDも渡します。コードは渡しません。

### 依頼ID

- 新しい依頼は`R13`、その再依頼は枝番を付けた`R13-1`、次は`R13-2`です。枝番は重ねません
- 枝番を除いたIDが同じ依頼を「系列」と呼びます。枝番が最も大きい依頼が、系列の最新の依頼です
- 1つのIDは、1回の呼び出しで人に見せた1つの依頼票を指します。依頼票は、作った後は変わりません

### 依頼票の項目

記録に保存し、UIが表示する依頼票の形です（`src/server/types.ts`の`ReviewPacket`）。対象のリポジトリの依頼票は、解析エンジンがコードから組み立てます（[ADR-0015](../maintainer-guide/decisions/0015-typescript-analysis-engine-v1.md)）。`--state-dir`やメモリの記録先では、固定データです。

シンボルIDは`リポジトリからのパス#名前`で、クラスのメンバーは`.`でつなぎます（例: `src/server/target.ts#Targets.resolve`）。

| 項目 | 内容 |
|---|---|
| `id` | 依頼ID |
| `group` | 回答のまとまり。その呼び出しで最初に作った依頼のID |
| `kind` | `required`または`optional` |
| `triggeredBy` | `required`の依頼を生んだ信頼境界ルールのIDの列 |
| `viewpoint` | AIが書いた問い |
| `requestedSymbols` | AIが指定した対象シンボルIDの列 |
| `range` | commit範囲 |
| `steps` | 理解順の対象。`order`、`symbol`、`file`、`startLine`、`layer`、`boundaries`、`change`（`added`・`modified`・`unchanged`）、`code`、`changedLines`（`code`内の相対位置） |
| `edges` | `steps`のシンボルどうしの使う関係。`from`、`to`、`kind`（`call`・`new`・`type`・`inherit`）。`to`は`steps`、`from`は`steps`か`callers`のシンボル。ADR-0020より前の記録にはない（[ADR-0020](../maintainer-guide/decisions/0020-dependency-graph-view.md)） |
| `callers` | 呼び出し元。AIが指定したシンボルと変わったシンボルを呼び出す、`steps`にないシンボル（1段だけ）。`symbol`、`file`、`startLine`、`code`。ADR-0021より前の記録にはない（[ADR-0021](../maintainer-guide/decisions/0021-callers-in-dependency-graph.md)） |
| `unresolved` | 解析で解決できなかった参照の列 |
| `evidence` | 証拠の列。`kind`（`test`・`static`）、`name`、`status`（`pass`・`fail`・`missing`） |
| `budget` | レビュー予算。`changedLines`と`limit` |
| `fixture` | 固定データなら`true`、解析エンジンが作ったなら`false` |

## AIとのやり取り

依頼時、AIに返すのは依頼IDと状態だけです。観点が複数あるときは、1回の呼び出しにまとめて渡します。

```text
request_review(reviews: [{viewpoint, symbols}, ...], range) -> "R12 R13 pending"
```

修正した後は、元の依頼のIDを`follows`に渡して再依頼します。

```text
request_review(reviews: [{follows: "R13"}], range) -> "R13-1 pending"
```

- `follows`には、系列のどのIDを渡してもよい。引き継ぐのは、常に最新の依頼
- `follows`があれば、`viewpoint`と`symbols`は省略できる。省略したものは最新の依頼から引き継ぐ
- 新しい依頼と再依頼を、1回の呼び出しに混ぜてよい
- 存在しないIDへの再依頼や、同じ系列への再依頼を2つ含む呼び出しは、全体を拒否する

### 回答のまとまり

1回の呼び出しで出された依頼が、回答のまとまりになります（[ADR-0008](../maintainer-guide/decisions/0008-group-requests-per-call.md)）。

- UIの受付箱に出るのは、そのUIが開かれた依頼と同じ呼び出しの依頼だけ。ほかの未回答の依頼は件数だけを表示する
- 別の呼び出しの依頼への回答は、サーバーが拒否する。同じ会話でも、別々に出された依頼はそれぞれのUIから回答する
- 再依頼も、その呼び出しのまとまりに入る。元の依頼は、再依頼済みとして元のまとまりに残る
- `get_review_result`は、依頼IDを指定して取得する

1回の呼び出しは必ず1つの会話の中で起きるので、別の会話の依頼に回答してしまうことがありません。

回答は、UIの「まとめて送信」で1通にまとめ、1行に1つの回答を書く形式で返します。先頭の1行は、AIへの次の行動の指示です。

```text
[inloop] レビュー回答。fixは修正後にrequest_reviewのfollowsで再依頼、askは会話で答える:
R12 ok
R13 fix src/auth.ts#login#L42 "トークン期限切れは401で返す"
R13 ask src/auth.ts#login#L50-L53 "リトライは冪等?"
R14 ask "全体として妥当?"
R15 hold
R16-1 ok
```

| 値 | 意味 | 1つの依頼に付けられる数 |
|---|---|---|
| `ok` | 承認 | 単独の1行のみ |
| `hold` | 保留 | 単独の1行のみ |
| `fix` | 修正依頼（コメント必須） | 行ごとに複数 |
| `ask` | 質問（コメント必須） | 行ごとに複数 |

参照は、シンボルID（依頼全体へのコメントでは省略）、行（`#L42`）、行範囲（`#L50-L53`）のいずれかです。参照は依頼票に含まれるシンボルと、その表示範囲内の行に限ります。1行でも不正があれば、その回答全体を記録しません。

依頼の状態は、`fix`が1つでもあれば`fixing`、なければ`ask`があれば`answering`、`hold`なら`held`、`ok`なら`approved`になります。

コード抜粋は返しません。AIはrepositoryを読めるため、場所を示せば十分です。

### ブラウザで開く経路

MCP AppsのUIを表示できないクライアントでは、サーバーを`--ui browser`で起動し、同じUIをブラウザで開きます（[ADR-0012](../maintainer-guide/decisions/0012-browser-ui-path.md)）。

```text
request_review(reviews: [...]) -> "R12 R13 pending http://<アプリ名>.inloop.localhost:4656/r/R12"
get_review_result(ids: ["R12", "R13"], wait: 600) -> "R12 ok\nR13 fix ..."
```

- ブラウザからは会話へ送れないので、AIは`inloop wait R12 R13`をバックグラウンドのコマンドとして動かして手番を終え、コマンドが終わったら（人が送信したら）続きを始める（[ADR-0016](../maintainer-guide/decisions/0016-wait-in-background-command.md)）。バックグラウンドで動かせなければ、`get_review_result`の`wait`で待つ。時間切れなら、未回答の依頼を`R13 pending`として返す
- 保留・質問の回答を受け取った後に待つと、人が未回答に戻して答え直すまで待つ。新しい回答がなければ`no change`を返す

## 会話での議論と記録

横に開いた画面（ブラウザで開く経路）では、議論は会話で行い、画面は読む場所と記録にします（[ADR-0017](../maintainer-guide/decisions/0017-chat-centered-review-and-size-limit.md)）。

- 画面の「位置をコピー」（回答済みの画面では行のクリック）で、`R6 src/server/wait.ts#answersOf#L12-L15`の形の位置をコピーし、会話に貼って話す
- 人が会話で承認・保留の言葉（既定は「承認」「保留」、`~/.inloop/config.json`の`approvePhrases`・`holdPhrases`（配列）で変えられる）を言ったら、AIが`answer_review`で記録する。サーバーは言葉が設定と一致するときだけ記録する。必須の依頼は会話からは記録できない
- 画面の承認・保留のボタンも、これまでどおり使える
- 依頼票のコードの行数の合計が上限（既定60行、`maxReviewLines`）を超え、対象のシンボルが2つ以上なら、依頼は断られる

## UIでの回答の操作

画面は読む場所と記録で、修正依頼と質問は会話で行います（[ADR-0017](../maintainer-guide/decisions/0017-chat-centered-review-and-size-limit.md)、[ADR-0018](../maintainer-guide/decisions/0018-ui-as-reading-and-record.md)）。

- 依頼票の先頭に依存の図を出す。箱はシンボル、矢印は使う側から使われる側へ。箱を押すとそのコードへ移る。変わっていない依存と呼び出し元のコードは畳み、図や「コードを表示」で開く。呼び出し元は図の右の列に点線の枠で出す（[ADR-0021](../maintainer-guide/decisions/0021-callers-in-dependency-graph.md)、[ADR-0020](../maintainer-guide/decisions/0020-dependency-graph-view.md)）
- コード行をクリックすると位置（`<依頼ID> <参照>`）をコピーする。Shift+クリックで行範囲にする。会話に貼って話す
- 各依頼の「承認」「保留」は、押したらすぐ記録する。未回答の依頼が2件以上なら「まとめて承認」を出す
- 保留中・回答待ちの依頼は「未回答に戻す」で未回答に戻し、回答し直す
- 依頼票には、同じ系列でそれより前の依頼に付いた回答を「前の依頼への回答」、その依頼に付いた回答を「この依頼への回答」として分けて出す。再依頼の画面で、前回の指摘を確かめられる
- 回答した依頼の画面は記録として残す。上部に状態（「回答済み（修正依頼）」「承認済み」など）を出し、送信した直後から再読み込みした後まで同じ表示にする。後から変わるのは、再依頼されたときの「再依頼済み → R13-1」だけで、押すと引き継ぎ先の画面に移る（ブラウザで開く経路。MCP Appsでは、再依頼した会話の画面を案内する）
- 画面の依頼がすべて回答済みなら、送信の操作とほかの依頼の件数は出さない
- 画面は自動では最新にならない。後から再依頼された場合などは、再読み込みすれば最新になる

## 状態遷移

```text
pending ─ ok ──────────► approved
   │
   ├─ fix（1つ以上） ─► fixing
   ├─ ask（1つ以上） ─► answering ─ 人が未回答に戻す ─► pending
   └─ hold ───────────► held ────── 人が未回答に戻す ─► pending

再依頼（再依頼済みを除く、どの状態からでも）:
R13 ─ AIがfollowsで再依頼 ─► superseded（再依頼済み）
                              └─ R13-1 が pending で始まる
```

| 遷移 | 起こすもの | IDと依頼票 |
|---|---|---|
| `pending` → `approved`・`fixing`・`answering`・`held` | 人の回答 | 変わらない |
| `held`・`answering` → `pending` | 人が、その依頼の画面で未回答に戻す | 変わらない |
| `superseded`以外 → `superseded`、同時に枝番の依頼が`pending`で始まる | AIの再依頼 | 新しいIDと新しい依頼票 |

- `fixing`と`approved`は、人の操作では未回答に戻せません。依頼票が修正前のものなので、再依頼で引き継ぎます
- 質問には、AIが会話で答えます。人は答えを読んでから、同じ画面で未回答に戻して回答します。AIが質問を受けてコードを変えたときは、再依頼します
- 未回答に戻したことは、AIに伝えません。戻した依頼に回答した時点で、その回答が届きます
- 再依頼済みの依頼には回答できません。再依頼によって承認されることはありません
- マージの条件は、再依頼済みを除くすべての依頼が`approved`であることです

## 保存

依頼と回答は、対象のリポジトリの`.inloop/reviews.jsonl`（`--state-dir`を指定した場合はその`reviews.jsonl`）に、1行1件のJSONで追記します（[ADR-0010](../maintainer-guide/decisions/0010-target-repository-per-request.md)、[ADR-0014](../maintainer-guide/decisions/0014-target-path-not-in-record.md)）。対象のパスは記録に書きません。形式は[ADR-0007](../maintainer-guide/decisions/0007-append-only-review-log.md)のとおりです。状態は保存せず、記録を先頭から適用して再現します。

```text
{"v":1,"type":"request","at":"2026-10-10T13:00:00.000Z","packet":{"id":"R12", ...}}
{"v":1,"type":"answer","at":"2026-10-10T13:05:00.000Z","answers":[{"id":"R12","verdict":"hold"}]}
{"v":1,"type":"reopen","at":"2026-10-10T13:20:00.000Z","ids":["R12"]}
{"v":1,"type":"answer","at":"2026-10-10T13:21:00.000Z","answers":[{"id":"R12","verdict":"fix","comment":"..."}]}
{"v":1,"type":"request","at":"2026-10-10T13:40:00.000Z","packet":{"id":"R12-1", ...}}
```

| 種類 | 内容 |
|---|---|
| `request` | 依頼1件。`packet`は人に見せた依頼票の全体。枝番のIDなら再依頼で、系列のそれまでの最新の依頼を再依頼済みにする |
| `answer` | 1回の送信で記録した回答の列（`answers`）。未回答の依頼にだけ付けられる |
| `reopen` | 未回答に戻した依頼のIDの列（`ids`）。保留中か回答待ちの依頼にだけ使える |

- 1回の呼び出しの依頼は、連続した行として1回で書き込みます。`answer`と`reopen`は、1回の操作を1行にまとめます
- 読み込みでは、依頼票の形の全体と、状態遷移との整合を確かめます。合わない行があれば、行を示して拒否します。知らない項目は無視します
- 版`v`は1です。上げるのは、すでにある行をそのままでは読めなくなるときか、古い実装が新しい行を拒否せずに別の意味で読んでしまうときです（[ADR-0009](../maintainer-guide/decisions/0009-request-lifecycle-and-branch-ids.md)）
- 保存先の指定がなければ、メモリにだけ保持します

## 未決事項

- revision間でシンボルの同一性を保つ方法（名前の変更を追うか）
- 間接の依存、レイヤーの判定、証拠（テスト・静的解析の結果）の取り込み
- レビュー予算の単位（行数、シンボル数、判断箇所の数など）
- `required`の依頼を生む信頼境界ルールの記述形式と、再依頼で種別を決め直す方法
- 再依頼で、承認済みのシンボルとの差分だけを見せる仕組み
- 承認後に対象シンボルの本文が変わったことの検出（検出したときは、系列の新しい依頼として表す）
- 記録ファイルの整理（古い記録の退避）と、複数プロセスからの同時の依頼作成
