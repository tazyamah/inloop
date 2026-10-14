# クライアント検証の手順

MCPサーバーを実際のAIクライアントに登録し、対象コードから生成したレビュー依頼票を確認する手順です。会話内の埋め込みと、ブラウザで開く経路を分けて検証します。

- AIがローカルのrepositoryを編集できる
- MCP AppsのレビューUIが表示され、回答が会話に戻る

## 準備

```sh
cd <inloopのrepository>
npm ci
npm run build
npm test
which node   # 登録で使う絶対パスを控える
```

`dist/server/main.js`がMCPサーバーの入口です（`bin/inloop mcp`と同じ）。GUIアプリからはシェルの`PATH`が見えないことがあるため、`node`は絶対パスで指定します。

`inloop`コマンド（[ADR-0011](../maintainer-guide/decisions/0011-inloop-command-and-app-templates.md)）は、cloneしたinloopの`bin/`にパスを通して使います。

```sh
export PATH="<repo>/bin:$PATH"
inloop generate scaffold <名前> <列>... # 資源（表・API・テスト・画面）を決まった形で作る
inloop new <ディレクトリ>          # 新しいアプリを標準の構成（React＋Hono＋SQLite）で作り、登録する
inloop init <アプリのリポジトリ>   # 既存のリポジトリを登録する（ブラウザで開く経路で使う）
inloop apps                        # 登録したアプリと画面のURL
inloop server status|stop|restart  # 画面のサーバーの状態を見る、止める、起動し直す
inloop wait R4 R5                  # 回答が記録されるまで待つ（AIがバックグラウンドで動かす）
```

利用者ごとの設定は`~/.inloop/config.json`です（[ADR-0017](../maintainer-guide/decisions/0017-chat-centered-review-and-size-limit.md)）。

```json
{ "maxReviewLines": 60, "approvePhrases": ["承認"], "holdPhrases": ["保留"] }
inloop update                      # inloopを更新してビルドし直す（画面のサーバーは次の依頼で新しい版になる）
```

## 依頼と回答の保存

依頼と回答は、対象のリポジトリの`.inloop/reviews.jsonl`に保存します（[ADR-0010](../maintainer-guide/decisions/0010-target-repository-per-request.md)）。対象は依頼ごとに、AIが渡す`repo`（gitの作業ツリーの絶対パス）、起動時の`--repo <dir>`、クライアントが知らせる作業フォルダ（roots、1つの場合）の順で決め、決まらなければ依頼を拒否します。`--allow <dir>`で対象を限れます。

引数`--state-dir <dir>`（または環境変数`INLOOP_STATE_DIR`）を指定すると、対象に関係なく`<dir>/reviews.jsonl`に保存します（これまでの登録との互換、[ADR-0014](../maintainer-guide/decisions/0014-target-path-not-in-record.md)）。どちらで動いているかは、起動時のログの`state=`で分かります。

以下の登録例の`<state>`は状態ディレクトリの絶対パスに置き換えます。`--state-dir`を外せば、リポジトリごとの記録になります。

## 登録方法

以下の`<node>`は`which node`の結果、`<repo>`はrepositoryの絶対パスに置き換えます。

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "inloop": { "command": "<node>", "args": ["<repo>/dist/server/main.js", "--state-dir", "<state>"] }
  }
}
```

保存後にClaude Desktopを再起動します。サーバーのログ（stderr）は`~/Library/Logs/Claude/mcp-server-inloop.log`に出ます。

### Claude Code

```sh
claude mcp add inloop -- <node> <repo>/dist/server/main.js --state-dir <state>
```

`inloop init`と`inloop new`は、リポジトリに`.mcp.json`（`inloop mcp --ui browser`を`PATH`の`inloop`で起動する登録）を書きます。Claude Codeでそのリポジトリを開けば、上の登録をしなくても使えます（初回は、このサーバーを使ってよいかを聞かれる）。Claude CodeはMCPサーバーにシェルの`PATH`を渡すので（2026-10-11に確認）、シェルの設定で`<repo>/bin`に`PATH`を通しておきます。

Claudeデスクトップアプリの中のClaude Codeは、レビューUIを会話に表示しない（2026-10-11）。ブラウザで開く経路（[ADR-0012](../maintainer-guide/decisions/0012-browser-ui-path.md)）を使います。Claude Desktopの設定にも`inloop`がある場合は、そちらが呼ばれるので、別の名前で登録します。

```sh
claude mcp add inloop-code -s local -- <node> <repo>/dist/server/main.js --ui browser
```

Claude Codeは作業フォルダ（roots）を知らせるので、`--state-dir`も`--repo`も付けずに、セッションのフォルダのリポジトリが対象になります（2026-10-11、`initialize`の`capabilities`で`roots`を確認）。

対象のリポジトリは、先に`inloop init`で登録しておきます。`request_review`が`http://<アプリ名>.inloop.localhost:4656/r/R1`の形のURLを返すので、それをブラウザで開いて回答します（[ADR-0013](../maintainer-guide/decisions/0013-machine-wide-ui-server.md)）。画面のサーバーはマシン全体で1つで、MCPサーバーが起動時に、動いていなければ起動します。ポートは`INLOOP_PORT`で変えられます。AIはURLを示して会話を待ち、人が回答したと伝えたら`get_review_result`で取得します（ADR-0018）。

### Codex

`inloop init <アプリのリポジトリ>`と`inloop new`は、Claude Codeの`.mcp.json`に加えて、Codexの`.codex/config.toml`を生成します。既存ファイルのコメントと他の設定は残し、inloopの登録がなければ追記します。既存のinloop登録は上書きしません。不正なTOMLや追記できないインラインテーブルは、登録前に拒否します。

```toml
[mcp_servers.inloop]
command = "inloop"
args = ["mcp", "--ui", "browser"]
```

Codexは、信頼したプロジェクトでだけプロジェクト設定を読みます。対象アプリのフォルダをCodexで開き、信頼の確認が出たら内容を確認して承認してください。設定を追加したあとはMCPサーバーを再接続してください。`.mcp.json`だけではCodexへの登録になりません。[公式のMCP設定](https://developers.openai.com/codex/mcp)を参照してください。

生成した設定は、`PATH`から`inloop`を起動します。GUIでコマンドが見つからない場合は、利用者の`~/.codex/config.toml`に次の登録を置けます。`<node>`はNode.jsの絶対パス、`<inloop-repo>`はinloop本体の絶対パスです。端末固有のパスはアプリのリポジトリへcommitしません。

```toml
[mcp_servers.inloop]
command = "<node>"
args = ["<inloop-repo>/dist/server/main.js", "--ui", "browser"]
```

CLIで同じ利用者設定を追加する場合は、次を実行できます。すでにinloopを登録している場合は、既存設定を確認してから変更してください。

```sh
codex mcp add inloop -- <node> <inloop-repo>/dist/server/main.js --ui browser
codex mcp get inloop
```

Codexでのroots通知は未確認です。`request_review`・`get_review_result`・`answer_review`のすべてで、対象アプリのgit作業ツリーの絶対パスを`repo`に渡します。`--state-dir`は互換用の固定依頼票になるので、コードをレビューする登録には付けません。Codexが返されたURLをアプリ内ブラウザで開ける場合は表示し、人の回答を待ちます。承認・保留ボタンは人が押します。ブラウザの回答は会話へ自動送信されないため、人が会話に「回答した」と伝えたら`get_review_result`で読みます。`inloop wait`による自動再開やMCP Appsの埋め込みは、実クライアントで確認するまで利用可能と断定しません。

### VS Code

ワークスペースの`.vscode/mcp.json`:

```json
{
  "servers": {
    "inloop": { "type": "stdio", "command": "<node>", "args": ["<repo>/dist/server/main.js", "--state-dir", "<state>"] }
  }
}
```

## 試し方

`inloop new`で作ったアプリをAIクライアントで開き、会話で次のように頼みます。

> inloopのrequest_reviewで「メモの入力検証と保存方法を確認したい」をレビュー依頼して。対象はserver/app.ts#createApp。repoにはこのアプリのgit作業ツリーの絶対パス、rangeにはHEADを渡して。

ブラウザの経路では、返ってきたURLを開いてください。依頼票に対象の実コードが出ることを確かめます。コード行をクリックし、コピーされた`R1 server/app.ts#createApp#L行:`を会話へ貼り、質問や修正依頼を書いてください。会話内の埋め込みでは、位置が会話へ入るかも確かめます。

内容に納得できたら、人が「承認」を押してください。ブラウザの経路では会話に「回答した」と伝えます。AIが`get_review_result`で`R1 ok`を受け取れば、依頼・表示・回答取得の往復は成功です。保留の確認には別の依頼を作り、人が「保留」を押します。画面は「回答済み（保留）」、取得結果は`R2 hold`になることを確かめます。UIのコメント欄と「まとめて送信」はADR-0018で廃止されています。

## 確認項目

クライアントごとに、次の表を埋めて[クライアント検証の結果](../maintainer-guide/client-verification-results.md)に結果を残します。

| # | 確認すること | 見方 |
|---|---|---|
| 1 | サーバーに接続できる | クライアントのMCP設定画面、またはAIにツール一覧を尋ねる |
| 2 | AIに見えるツールが`request_review`・`get_review_result`・`answer_review`の3つだけ | AIにinloopのツール一覧を尋ねる。`inloop_get_request`・`inloop_submit`・`inloop_reopen`が見えたら、visibilityが効いていない |
| 3 | 戻り値がID・状態だけ（ブラウザの経路はURL、必須依頼は`required`も含む） | ツール呼び出しの詳細表示。コード本文を含まない |
| 4 | レビューUIが表示される | 会話内または返されたURLに、対象の実コードを含む依頼票が出る |
| 5 | 人の回答をAIが受け取る | 承認・保留の押下後、埋め込みの会話への通知または`get_review_result`の結果 |
| 6 | 埋め込みでは「大きく表示」が使える | ボタンを押すと全画面になる。ブラウザの経路では対象外 |
| 7 | 同じ画面で、AIがローカルのrepositoryを編集できる | 適当なファイルの変更を頼む |
| 8 | AIの文脈に入る量が記録される | サーバーログの`model-bound`行 |

## 自動テストで確認済みの範囲

`npm test`は、MCPクライアントからのツール呼び出し、ツールの見え方の設定、戻り値の大きさ、回答の検証、stdioでの起動を確認します。

`INLOOP_UI_E2E=1 npm test`（Playwrightが必要）は、テスト用の最小ホスト（`test/harness/host.mjs`）でUIを実ブラウザに表示し、行クリック、承認・保留の即時記録、会話へのメッセージ送信、全画面表示の要求、ダークテーマを確認します。

これらは実際のクライアントでの動作を保証しません。特に、ツールをAIから隠せるか、会話へのメッセージを受け付けるか、全画面表示に対応するかはホストの実装次第です。
