# 構成

## 主役はAIクライアント

inloopは、AIを呼び出すIDEではありません。人は普段どおりAIクライアント（Claude、Codexなど）で開発し、レビューが必要なときだけ、inloopのUIがクライアントの中に現れます。

```text
AIクライアント（人が普段使う画面）
  │  会話・コード編集はAIエージェントが行う
  │
  ├─ 必要なときに request_review を呼ぶ
  ▼
inloop MCPサーバー（クライアントが自動起動）
  ├─ 解析エンジン: 依頼票をAIなしで組み立てる
  ├─ 依頼・回答・承認状態の保存
  └─ レビューUI（MCP Apps）: クライアントの画面内に表示
```

この構成を選んだ理由は[ADR-0003](../maintainer-guide/decisions/0003-hosted-by-ai-client-via-mcp.md)を参照してください。

## 構成要素

| 要素 | 役割 | 言語 |
|---|---|---|
| 解析エンジン | シンボル解析、理解順の並べ替え、影響範囲、信頼境界ルールの評価 | TypeScript |
| MCPサーバー | エンジンを包み、ツールの提供と状態の保存を担う | TypeScript |
| レビューUI | 依頼の受付箱、依頼票の表示、まとめての回答（MCP Apps） | TypeScript / HTML |
| スキル | いつ・どの粒度で依頼するかをAIに指示する | Markdown |

MCP Appsに対応しないクライアント向けに、同じUIをローカルのブラウザで開く代替経路があります（`--ui browser`、[ADR-0012](../maintainer-guide/decisions/0012-browser-ui-path.md)）。画面はマシン全体で1つの画面のサーバーが`http://<アプリ名>.inloop.localhost:4656`で配ります（[ADR-0013](../maintainer-guide/decisions/0013-machine-wide-ui-server.md)）。ツールの呼び出し方は共通で、回答はAIが`get_review_result`の`wait`で受け取ります。

## 解析エンジン

既存の言語に「レビューしやすい投影」を後付けします。言語自体を設計して構築時に対応関係を埋め込む方式に比べ、正確さは「構築による保証」から「解析による近似」に下がります。これを次の方針で補います。

- 型情報まで含めてシンボルを解決する（TypeScriptはコンパイラAPIを使う）
- フレームワークごとの**レイヤー対応ルール**で、コードを論理レイヤーと信頼境界に対応づける（例: HTTPハンドラの登録は入口、クエリの実行はDB層）。Semgrepのように、ルールを外付けのファイルとして管理する
- 解決できなかった参照は未解決として明示する
- 信頼境界ルールは、対象のリポジトリ直下の`inloop.json`に書く。エンジンが範囲の変更に当て、当たった単位ごとに必須の依頼を作る（[ADR-0022](../maintainer-guide/decisions/0022-trust-boundary-rules.md)）
- `inloop.json`の`layers`で、ファイルのレイヤーを依頼票の`layer`に入れる。`minVersion`で必要なinloopの版を示す（[ADR-0023](../maintainer-guide/decisions/0023-config-layers-and-min-version.md)）。`mayUse`でレイヤー間の依存の向きを決め、反した使い方は必須の依頼になる（[ADR-0027](../maintainer-guide/decisions/0027-layer-direction.md)）

依頼票に出る図と、その作り方は[diagrams.md](diagrams.md)にまとめています。

最初の対象はTypeScriptとSQLです（[ADR-0005](../maintainer-guide/decisions/0005-typescript-first-and-self-hosting.md)）。重い処理は、将来Rust製モジュールへの差し替えを検討します。

## 利用枠の節約

人間が見る情報と、AIが読む情報を完全に分けます（[ADR-0004](../maintainer-guide/decisions/0004-minimal-model-context.md)）。

- `request_review`の入力はシンボルIDとcommit範囲で、戻り値は依頼IDと状態だけ
- 依頼票の中身は、UIがサーバーから直接取得する。ツールの戻り値に載せない
- 回答は1行1件の短い形式で、まとめて1通で返す
- 再依頼は、承認時に記録したシンボル本文のハッシュと比べて、変わった部分だけ
- AIから見えるツールの数と説明文を最小限にする
- バイト圧縮（gzip、base64）は使わない。トークン数はむしろ増える。圧縮は参照・省略・重複排除で行う

1回のレビューループで消費したトークン数を、最初から計測できるようにします。

## 確認が必要な前提

- 「AIがローカルのrepositoryを編集できる」ことと「MCP AppsのUIを表示できる」ことを、同じ画面で両立できるクライアントはどれか。ターミナル版のクライアントはUIを表示できない。
- Codexのクライアントアプリが、MCP Appsに対応しているか。
- MCP Appsで、UIだけが使うツールをAIから見えなくできる範囲。
