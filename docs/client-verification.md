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

`dist/server/main.js`がMCPサーバーの入口です。GUIアプリからはシェルの`PATH`が見えないことがあるため、`node`は絶対パスで指定します。

## 依頼と回答の保存

引数`--state-dir <dir>`（または環境変数`INLOOP_STATE_DIR`）を指定すると、依頼と回答を`<dir>/reviews.jsonl`に保存し、クライアントやサーバーを再起動しても残ります。対象のrepository直下の`.inloop`を絶対パスで指定することを推奨します（[ADR-0007](../maintainer-guide/decisions/0007-append-only-review-log.md)）。

指定しない場合はメモリにだけ保持し、再起動で消えます。どちらで動いているかは、起動時のログの`state=`で分かります。指定した保存先を使えない場合、サーバーは起動しません。

以下の登録例は保存先を指定しています。`<state>`は状態ディレクトリの絶対パスに置き換えます。

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
[inloop] レビュー回答。fixは修正後にrequest_reviewで差分を再依頼:
R1 fix src/db/orders.ts#cancelOrder#L44 "..."
```

## 確認項目

クライアントごとに、次の表を埋めて[handoff](../maintainer-guide/handoff.md)に結果を残します。

| # | 確認すること | 見方 |
|---|---|---|
| 1 | サーバーに接続できる | クライアントのMCP設定画面、またはAIにツール一覧を尋ねる |
| 2 | AIに見えるツールが`request_review`と`get_review_result`だけ | AIにinloopのツール一覧を尋ねる。`inloop_get_request`と`inloop_submit`が見えたら、visibilityが効いていない |
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
