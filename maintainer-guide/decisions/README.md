# 設計判断記録（ADR）

複数の短い開発セッションでinloopを一貫して変更するための記録です。現在の作業状態は[../handoff.md](../handoff.md)を参照します。

## 運用規則

次のいずれかを変えるときにADRを追加します。

- 依頼票の構造、生成方法、AIに返す情報の範囲
- MCPのツール、公開contract、互換性
- 信頼境界ルール、必須依頼の条件
- 対応言語、対応クライアント、大きな依存関係

小さなバグ修正やテスト結果だけならADRは不要で、handoffに記載します。

ファイル名は`NNNN-kebab-case.md`とし、番号は再利用しません。状態は`Proposed`、`Accepted`、`Deprecated`、`Superseded`、`Rejected`のいずれかです。Accepted ADRの結論は書き換えず、新しいADRから`Supersedes ADR-NNNN`として更新します。誤字やリンク修正は可能です。

新規作成時は[0000-template.md](0000-template.md)を複製します。

## 一覧

| ADR | 状態 | 判断 |
|---|---|---|
| [0001](0001-push-review-requests.md) | Accepted | AIが人にレビューを依頼するpush型にし、信頼境界の変更は必須依頼にする |
| [0002](0002-deterministic-review-projection.md) | Accepted | 依頼票の構造をコードから決定的に生成し、AIの推測を混ぜない |
| [0003](0003-hosted-by-ai-client-via-mcp.md) | Accepted | MCPサーバー＋MCP AppsとしてAIクライアントにホストされる |
| [0004](0004-minimal-model-context.md) | Accepted | AIの文脈には参照・差分・短い列挙値だけを返す |
| [0005](0005-typescript-first-and-self-hosting.md) | Accepted | 最初の対象をTypeScript＋SQLとし、セルフホストする |
| [0006](0006-claude-desktop-chat-as-primary-client.md) | Accepted | 当面の主なクライアントをClaude Desktopの通常の会話にする |
| [0007](0007-append-only-review-log.md) | Accepted | 依頼と回答を、状態ディレクトリの追記専用JSON Linesに保存する |
| [0008](0008-group-requests-per-call.md) | Accepted | 1回の呼び出しで出された依頼を、回答のまとまりにする |
| [0009](0009-request-lifecycle-and-branch-ids.md) | Accepted | 再依頼を枝番のIDで表し、保留と質問は同じ依頼のまま未回答に戻す。依頼票の構造は現在の形で確定し、記録の版は上げない |
| [0010](0010-target-repository-per-request.md) | Accepted | 対象のリポジトリを依頼ごとに決め、記録をリポジトリごとの`.inloop/`に置く |
| [0011](0011-inloop-command-and-app-templates.md) | Accepted | inloopコマンドでアプリのリポジトリを作り、標準の構成（React＋Hono＋SQLite、手元はTauriにHonoを同梱）を固定する |
| [0012](0012-browser-ui-path.md) | Accepted | MCP AppsのUIを表示できないクライアント向けに、同じUIをブラウザで開き、回答はAIが待って受け取る（ポート・鍵・URLの形はADR-0013で更新） |
| [0013](0013-machine-wide-ui-server.md) | Accepted | 画面をマシン全体で1つのサーバーから`<アプリ名>.inloop.localhost`のURLで配り、鍵の代わりにHostとOriginを確かめる |
| [0014](0014-target-path-not-in-record.md) | Accepted | 対象のリポジトリのパスは記録に書かず、記録の置き場所で表す。`--state-dir`では対象が決まらなくても記録する |
| [0015](0015-typescript-analysis-engine-v1.md) | Accepted | 解析エンジンの最初の版をTypeScript 7のAPIで作る。シンボルIDは`パス#名前`、直接の依存を定義が先の順に並べる |
| [0016](0016-wait-in-background-command.md) | Accepted | ブラウザで開く経路の回答は、AIが`inloop wait`をバックグラウンドで動かして待つ。送信でAIの続きが始まる |
| [0017](0017-chat-centered-review-and-size-limit.md) | Accepted | 議論は会話で行い、画面は読む場所と記録にする。会話の決まった言葉でAIが承認・保留を記録できる。依頼票の行数に上限（利用者ごとの設定） |
| [0018](0018-ui-as-reading-and-record.md) | Accepted | 画面からコメント欄と送信を外し、承認・保留は押したらすぐ記録。AIは`inloop wait`を既定では動かさない |
