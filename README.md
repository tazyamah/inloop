# inloop

**AIコーディングに、人間の納得感を取り戻すためのレビュー基盤**

inloopは、AIエージェントがコードを書く開発で、人間を判断の輪（human-in-the-loop）の中に入れ続けるためのツールです。

AIは人間がレビューしきれない量のコードを生成できます。人間が自分で書いたコードを信頼できるのは、品質が高いからではなく、書く速度が理解の速度と一致していて、書きながらレビューできていたからです。inloopは、AIの生成速度を人間の理解速度に合わせ直します。

## 何をするか

- **AIが人にレビューを依頼する。** 人が対象を探しに行くのではなく、AIが機能ごとに「この観点で見てほしい」と依頼票を出します。
- **依頼票の中身はAIなしで組み立てる。** 対象コード（理解順に並べたシンボル）、データの流れ、影響範囲、テスト結果は、解析エンジンがコードから決定的に生成します。AIが書くのは問いの文だけです。
- **信頼境界に触れた変更は必ず依頼される。** 認証、外部入力、秘密情報、DB書き込みなどに触れた変更は、ルールによって自動で依頼対象になり、AIはこれを取り消せません。
- **人の回答で後続タスクが動く。** 承認・修正依頼・質問・保留を構造化して返し、修正後は前回からの差分だけを再依頼します。
- **AIクライアントの中で完結する。** MCPサーバーとして動き、レビューUIはMCP Appsとしてクライアント内に表示されます。自作のIDEやAPI課金を必要としません。

## 状態

MCPサーバー、レビューUI、`inloop`コマンドと、解析エンジンの最初の版（TypeScriptのシンボルと直接の依存を理解順に並べ、変更行に印を付ける）があります。信頼境界ルール、証拠の取り込み、SQLの解析はまだありません。

```sh
npm ci
npm run build
npm test
```

`bin/inloop`が`inloop`コマンドです（`new`・`init`・`apps`・`mcp`・`server`・`update`）。`inloop new <ディレクトリ>`で、標準の構成（React＋Hono＋SQLite、雛形は`templates/server/`）のアプリを作れます。AIクライアントへの登録と確認の手順は[docs/client-verification.md](docs/client-verification.md)にあります。

- 考え方: [docs/concept.md](docs/concept.md)
- 構成: [docs/architecture.md](docs/architecture.md)
- 開発のイテレーション: [docs/iteration.md](docs/iteration.md)
- レビュー依頼のプロトコル: [docs/review-protocol.md](docs/review-protocol.md)
- クライアント検証: [docs/client-verification.md](docs/client-verification.md)
- 開発者向け: [AGENTS.md](AGENTS.md)、[maintainer-guide/](maintainer-guide/README.md)
