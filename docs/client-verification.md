# クライアント検証の手順

最小のMCPサーバー（固定の依頼票を返す）を、実際のAIクライアントに登録して確かめる手順です。目的は、次の二つを同じ画面で両立できるクライアントを見つけることです。

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

対象のリポジトリは、先に`inloop init`で登録しておきます。`request_review`が`http://<アプリ名>.inloop.localhost:4656/r/R1`の形のURLを返すので、それをブラウザで開いて回答します（[ADR-0013](../maintainer-guide/decisions/0013-machine-wide-ui-server.md)）。画面のサーバーはマシン全体で1つで、MCPサーバーが起動時に、動いていなければ起動します。ポートは`INLOOP_PORT`で変えられます。AIは`get_review_result`の`wait`で回答を待ちます。

### Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.inloop]
command = "<node>"
args = ["<repo>/dist/server/main.js", "--state-dir", "<state>"]
```

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

会話で次のように頼みます。

> inloopのrequest_reviewで「発送済みの注文をキャンセルしようとした時、409で返す方針でよいか」をレビュー依頼して。対象は src/db/orders.ts#cancelOrder。

UIが表示されたら、コード行（例: 44行目）をクリックして修正依頼にし、コメントを書いて「まとめて送信」を押します。会話に次のような1通が届き、AIが続きの作業を始めれば成功です。

```text
[inloop] レビュー回答。fixは修正後にrequest_reviewのfollowsで再依頼、askは会話で答える:
R1 fix src/db/orders.ts#cancelOrder#L44 "..."
```

## 確認項目

クライアントごとに、次の表を埋めて[handoff](../maintainer-guide/handoff.md)に結果を残します。

| # | 確認すること | 見方 |
|---|---|---|
| 1 | サーバーに接続できる | クライアントのMCP設定画面、またはAIにツール一覧を尋ねる |
| 2 | AIに見えるツールが`request_review`・`get_review_result`・`answer_review`の3つだけ | AIにinloopのツール一覧を尋ねる。`inloop_get_request`・`inloop_submit`・`inloop_reopen`が見えたら、visibilityが効いていない |
| 3 | `request_review`の結果が`R1 pending`だけ | ツール呼び出しの詳細表示 |
| 4 | レビューUIが表示される | 会話内に依頼票が出る |
| 5 | 回答が会話に戻り、AIが続きを始める | 「まとめて送信」後の会話 |
| 6 | 「大きく表示」が使える | ボタンが表示され、押すと全画面になる |
| 7 | 同じ画面で、AIがローカルのrepositoryを編集できる | 適当なファイルの変更を頼む |
| 8 | AIの文脈に入る量が記録される | サーバーログの`model-bound`行 |

## 自動テストで確認済みの範囲

`npm test`は、MCPクライアントからのツール呼び出し、ツールの見え方の設定、戻り値の大きさ、回答の検証、stdioでの起動を確認します。

`INLOOP_UI_E2E=1 npm test`（Playwrightが必要）は、テスト用の最小ホスト（`test/harness/host.mjs`）でUIを実ブラウザに表示し、行クリック、まとめての回答、会話へのメッセージ送信、全画面表示の要求、ダークテーマを確認します。

これらは実際のクライアントでの動作を保証しません。特に、ツールをAIから隠せるか、会話へのメッセージを受け付けるか、全画面表示に対応するかはホストの実装次第です。
