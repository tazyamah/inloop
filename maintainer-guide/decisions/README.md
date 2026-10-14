# 設計判断記録（ADR）

複数の短い開発セッションでinloopを一貫して変更するための記録です。現在の作業状態は[../handoff.md](../handoff.md)を参照します。

## 運用規則

次のいずれかを変えるときにADRを追加します。

- 依頼票の構造、生成方法、AIに返す情報の範囲
- MCPのツール、公開contract、互換性
- 信頼境界ルール、必須依頼の条件
- 対応言語、対応クライアント、大きな依存関係

小さなバグ修正やテスト結果だけならADRは不要で、[implementation-log](../implementation-log.md)に記載します。

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
| [0006](0006-claude-desktop-chat-as-primary-client.md) | Superseded（0037） | 当面の主なクライアントをClaude Desktopの通常の会話にする |
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
| [0019](0019-desktop-template-node-sea-sidecar.md) | Accepted | 手元で動くアプリの雛形は、Tauriの外枠にNodeのSEAにまとめたHonoを同梱する（`.app`まで確認） |
| [0020](0020-dependency-graph-view.md) | Accepted | 依頼票に並べたシンボルどうしの使う関係（`edges`）を残し、画面の先頭に依存の図を出す。変わっていない依存のコードは畳む |
| [0021](0021-callers-in-dependency-graph.md) | Accepted | 依頼票に呼び出し元（`callers`、1段、呼び出しと`new`だけ）を残し、依存の図の右の列に出す。コードは畳む |
| [0022](0022-trust-boundary-rules.md) | Accepted | 信頼境界ルールをリポジトリの`inloop.json`に書き、当たった変更ごとにエンジンが必須の依頼を作る。`inloop check`で承認を確かめる |
| [0023](0023-config-layers-and-min-version.md) | Accepted | `inloop.json`に`layers`（ファイルからレイヤーを決めて依頼票の`layer`に入れる）と`minVersion`を足す。向きの検査は後回し |
| [0024](0024-evidence-runs.md) | Accepted | `inloop.json`の`evidence`の検査をinloopが実行して記録し、依頼票の`evidence`に入れる。作業ツリーの指紋が違う結果は`missing`にする |
| [0025](0025-evidence-symbol-binding.md) | Accepted | `evidence`に`tests`を足し、そのテストが直接呼び出す・newするシンボルの依頼票にだけ結果を結び付ける。参照するテストがなければ`missing` |
| [0026](0026-sql-table-access.md) | Accepted | 依頼票に並べたシンボルの`prepare`・`exec`のSQL文字列から読む・書くテーブルを取り出し、`tables`に出す。読めない動的なSQLは未解決にする |
| [0027](0027-layer-direction.md) | Accepted | `layers`に`mayUse`を足し、レイヤーの依存の向きに反した使い方を、組み込みのルール`layer-direction`で必須の依頼にする |
| [0028](0028-table-matcher.md) | Accepted | 信頼境界ルールに、SQLのテーブルでの当て方`table`を足す。動的なSQLの単位にも当てる |
| [0029](0029-folded-lines-and-reread-diff.md) | Accepted | 畳んで見せるコードを行数の上限に数えない。再依頼では、前の依頼票と同じコードで指摘のないシンボルを`prior.same`として畳む |
| [0030](0030-indirect-sql-tables.md) | Accepted | SQLを実行する宣言を、呼び出しを2段までたどって探し、`tables`に`via`つきで出す。`table`の当て方も2段先まで当てる |
| [0031](0031-sql-columns.md) | Accepted | `tables`に読み取れた列`columns`を足し、`table`の当て方にも`columns`を足す。決められない列は`*`にして当たる側に倒す |
| [0032](0032-send-position-to-chat.md) | Accepted | 行クリックの位置を`sendMessage`で会話の入力欄に入れる（クリップボードにも写す）。入れられないホストはコピーだけ |
| [0033](0033-fold-same-without-answer.md) | Accepted | 前の依頼に回答がなくても、再依頼で同じコードのシンボルを畳む（ADR-0029の1項目だけを変える） |
| [0034](0034-whole-file-view.md) | Accepted | コードの3段目としてファイル全体を開き、`ファイル名#L行`の位置を受け付ける |
| [0035](0035-position-colon.md) | Accepted | 行クリックの位置の末尾に「:」を付け、会話に入れたときはクリップボードに写さない。ファイル全体は呼び出し元からも開ける |
| [0037](0037-primary-client-claude-code.md) | Accepted | 主なクライアントをClaude Code（デスクトップ）にする。ほかのクライアント・DB・OSは後回し（ADR-0006をSupersedes） |
| [0038](0038-scaffold-generator.md) | Accepted | `inloop generate scaffold`で表・API・テスト・画面を決まった形で生成し、雛形に共通の見た目を入れる |
| [0039](0039-standalone-in-browser-runtime.md) | Accepted | サーバーなしで端末内（ブラウザ・PWA）で動く構成`--standalone`を足す。HonoをWeb Workerで動かし、SQLiteはsqlite-wasm（OPFS）に差し替える |
| [0040](0040-e2e-encrypted-sync-relay.md) | Accepted | 端末どうしの同期は、端末のSQLiteを正にし、暗号化した変更を小さな中継（Cloudflare Workers）で受け渡す |
| [0041](0041-approval-based-sync.md) | Accepted | 共有は、オーナーの承認と端末ごとの鍵で行い、別のオーナーを検出してアラートにし、標準のオプション`--sync`にする（ADR-0040の共有コードによる参加をSupersedes） |
| [0042](0042-scaffold-for-sync-apps.md) | Accepted | `inloop generate scaffold`を共有（`--sync`）のアプリに対応させる（ADR-0041の「まだ使えない」の部分をSupersedes） |
| [0043](0043-backup-export-import.md) | Accepted | 端末内で動くアプリに、データの書き出し・読み込み（バックアップ）を標準で付ける |
| [0044](0044-chrome-extension.md) | Accepted | 端末内で動くアプリを、Chrome拡張（Manifest V3、アプリごとのID）としても出せるようにする |
| [0045](0045-secure-code-lint.md) | Accepted | IPAの注意喚起から導いたセキュアコードの規則を`inloop lint`で検査し、違反すると雛形のテスト・ビルド、`inloop check`、scaffoldの生成を失敗させる |
| [0046](0046-usecase-map-and-naming-lint.md) | Accepted | HTTPの入口（ユースケース）から、データ（テーブル・列）とテストへ結ぶ図を、命名規則の検査（`uc-*`）と`inloop.json`の`usecases`で作る。値の流れは作らない |
| [0047](0047-codex-project-config.md) | Accepted | init・newでCodexのプロジェクトMCP設定も生成し、既存設定と共通の承認ルールを維持する |
| [0048](0048-client-config-hardening.md) | Accepted | クライアント設定（`.mcp.json`、`.codex/config.toml`）の変更を必須の依頼にし、ブラウザの経路の対象を登録したアプリに限る（ADR-0010・0047を補う） |
