# ADR-0047: CodexのプロジェクトMCP設定を生成する

- 状態: Accepted
- 日付: 2026-10-14
- Supersedes: ADR-0037のCodex対応を後回しにする部分だけ。Claude Codeの既存対応と、他のDB・OSの優先順位は維持する。

## 背景

利用者からCodex対応の追加・変更を依頼された。AGENTS.mdとMCPのツールは共通だが、init・newはClaude Codeの.mcp.jsonだけを生成し、Codex向けの手順は互換用の固定依頼票を返すstate-dir設定だった。

## 決定

init・newは`.codex/config.toml`にもinloopを登録する。起動は`inloop mcp --ui browser`とし、端末固有のパスを含めない。プロジェクトを信頼する操作と、GUIからPATHが使えない場合の利用者設定を文書で案内する。利用者のホームにあるCodex設定は変更しない。

既存のTOML本文とコメントを保持して追記する。既存のinloop登録は無効化を含めて上書きしない。TOMLをsmol-tomlで解析し、不正な構文や追記できない形式は書き込み前に拒否する。パーサーのエラーに設定本文が含まれうるため、本文をエラー出力に載せない。

Codexのroots通知を前提にせず、全ツール呼び出しにrepoを渡す。レビューのUIと承認ルールは共通とし、人の回答をAIが代行しない。ブラウザで回答したとの連絡後にget_review_resultで取得する。実クライアントでの埋め込み、自動再開、ツールの非表示は未検証として扱う。

## 理由

プロジェクト設定なら、アプリのリポジトリと一緒に移動できる。既存のブラウザ経路を使うことで、クライアント固有のUIを増やさずに対応できる。構文解析で引用キーやドットキーも判別し、重複した登録を作らない。

## 影響

init・newで生成するファイルが増え、実行時依存にsmol-tomlが加わる。既存のinloop登録の移行は自動では行わない。追記できないインラインテーブルは、通常のテーブルに直してからinitを再実行する。

## 却下した代替案

- Codex専用のUIと承認経路を作る。既存のレビュー契約と二重になる。
- 利用者のCodex設定を自動で書き換える。他のプロジェクトにも影響する。
- 正規表現でTOMLの登録を判定する。引用キーやインライン形式を確実に扱えない。

## 検証

npm testで、生成、既存設定の保持、繰り返し、引用キー・ドットキー・インライン形式の既存登録の保持、不正な設定の拒否を確認する。Codex CLIで生成したTOMLを読み取ることと、実際のCodex会話でレビューすることは別の確認として記録する。

## 関連資料

- [ADR-0010](0010-target-repository-per-request.md)
- [ADR-0018](0018-ui-as-reading-and-record.md)
- [ADR-0037](0037-primary-client-claude-code.md)
- [OpenAIのMCP設定](https://developers.openai.com/codex/mcp)
