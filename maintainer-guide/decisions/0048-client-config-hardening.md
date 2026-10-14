# ADR-0048: クライアント設定の変更を必須の依頼にし、ブラウザの経路の対象を登録したアプリに限る

- 状態: Accepted
- 日付: 2026-10-14
- Supersedes: ADR-0010の「決めた対象が満たす条件」に1つ足す（ブラウザの経路では、登録したアプリであること）。ADR-0047の「既存のinloop登録は常に維持する」に警告を足す。

## 背景

ADR-0047のレビュー（2026-10-14）で、次の点が見つかった。

- `.mcp.json`と`.codex/config.toml`は、inloop自身を起動するコマンドを決める。AIがcommandを差し替えたり無効にしたりしても、信頼境界ルールに当たらなかった。
- Codexはroots通知が未確認で、AIが渡す`repo`は、実在する任意のgit作業ツリーになりうる。`request_review`はブラウザの経路で登録済みのアプリに限られていたが、`get_review_result`と`answer_review`は限られておらず、登録していない作業ツリーに`.inloop/`を作れた。
- 維持した既存のinloop登録が無効でも、`inloop init`は何も知らせなかった。

## 決定

- 本体と4つの雛形の`inloop.json`に、ルール`client-config`を足す。`.mcp.json`と`.codex/config.toml`を変えると必須の依頼になる。問いは、起動するコマンドがinloopのままか、無効にしていないか。
- `inloop mcp --ui browser`では、AIが渡した`repo`を含むすべての対象が、`inloop init`で登録したアプリでなければ拒否する。`request_review`・`get_review_result`・`answer_review`で同じ。拒否した対象には`.inloop/`を作らない。
- `inloop init`は、維持したCodexの既存登録が`enabled = false`、または`command`が`inloop`でないとき、警告を標準エラーに出す。書き換えはしない。
- `inloop init`は、既存の`.mcp.json`が読めないとき、登録やCodex設定の書き込みの前に止まる。

## 理由

- 起動コマンドの差し替えは、レビューの機構そのものを置き換えられる。`package.json`・`tsconfig.json`と同じく、人が確かめる対象にする。
- 画面のサーバーは登録したアプリしか配らないので、ブラウザの経路で登録外の対象を受けても使い道がない。rootsに頼らず対象を限れる。
- 既存設定を上書きしない方針（ADR-0047）は保ち、知らせるだけにする。

## 影響

- ブラウザの経路で、未登録の作業ツリーを`repo`に渡すと、`get_review_result`・`answer_review`も拒否される。先に`inloop init`が要る。
- 既存のアプリは、`inloop.json`に`client-config`を足さなければ、この必須の依頼は働かない（自動では足さない）。
- `--ui browser`を使わない経路（MCP Apps、`--state-dir`）の対象の決め方は変えない。

## 却下した代替案

- 生成する設定に`--allow`を入れる: 端末固有の絶対パスをcommitすることになる。
- 維持した登録を自動で直す: 利用者の設定を書き換えない方針（ADR-0047）に反する。

## 検証

`npm test`で、未登録の対象を3つのツールが拒否し`.inloop/`を作らないこと、維持した登録の警告、壊れた`.mcp.json`の事前拒否、雛形の`inloop.json`に`client-config`があることを確かめる。実際のCodexでの動作は未検証。

## 関連資料

- [ADR-0010](0010-target-repository-per-request.md)
- [ADR-0047](0047-codex-project-config.md)
