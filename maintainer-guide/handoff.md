# inloop継続開発ハンドオフ

現在地、未検証事項、次の一手だけを記録します。短く保つため、経緯と詳細は次の文書に分けています。考え方は[docs/concept.md](../docs/concept.md)、構成は[docs/architecture.md](../docs/architecture.md)、判断理由は[ADR一覧](decisions/README.md)を参照してください。

| 文書 | 内容 |
|---|---|
| [implementation-log.md](implementation-log.md) | 日付ごとの実装と検証の記録（追記専用） |
| [client-verification-results.md](client-verification-results.md) | クライアントごとの確認結果の表 |
| [known-limitations.md](known-limitations.md) | 既知の制約 |
| [open-questions.md](open-questions.md) | 方向性はあるが未決のこと |

## 現在地

最終更新: 2026-10-12

- 実装済み: MCPサーバーとレビューUI（会話内の埋め込みと、ブラウザの経路）、依頼と回答の記録（リポジトリごと）、解析エンジン（TypeScript＋SQLの依頼票、依存の図、畳み、証拠）、信頼境界ルールと必須の依頼、`inloop`コマンド（`new`・`init`・`apps`・`mcp`・`server`・`update`）、標準の構成の雛形（サーバー向け、`--desktop`のTauri）。詳細は[implementation-log.md](implementation-log.md)とADR。
- 主なクライアントは **Claude Code（デスクトップクライアント）**、構成は「macOS＋Claude Code＋SQLite」（利用者の方針、2026-10-12、ADR-0037）。この構成で、`inloop-demo`を使った信頼境界ルール・依存の図・再依頼の畳みの確認まで終えた（[implementation-log.md](implementation-log.md)の「人の確認の途中結果」）。
- テスト: macOSで`npm test`が通る（直近の数は[implementation-log.md](implementation-log.md)の末尾）。UIを変えたときは`INLOOP_UI_E2E=1 npm test`も動かす。
- 保管中の作業: PostgreSQLの雛形とSQL解析は、ブランチ`claude/postgres-template`に未マージで置いてある（PR 18は閉じた。他のミドルウェアはずっと後の方針のため）。
- npmでの名前の確保は行わない方針（`package.json`は`private: true`）。商標（J-PlatPat、USPTO）は未確認。

## 次の一手

利用者の方針（2026-10-12）: まず、Claude Code（デスクトップ）で、webアプリとデスクトップアプリを楽に作れるようにする。ほかのクライアント（Claude Desktop、Codex、VS Code、Claude Code CLI）、他のミドルウェア（DBなど）、他のOSは、それが済んでからでよい。ただし設計は、後から足せるように保つ。

1. scaffold的な生成と、雛形の見た目（利用者が方針を承認、2026-10-12）。`inloop generate scaffold <名前> 列:型 ...`が、テーブル、Honoの一覧・作成・更新・削除と検証、テスト、画面の一覧とフォームを決まった形で生成する。雛形に最低限の見た目（共通のCSSとレイアウト）を入れ、生成した画面がそれを使う。生成したコードは信頼境界ルールに今までどおり当たる。最初はSQLiteのサーバー向けで作り、デスクトップ向けも同じコードに載せる。設計をADRにしてから実装する。
2. 利用者の判断待ち（困ったときに戻る）: 再依頼で、保留のあとも畳むか。行単位の差分が要るか。

後回し（理由: 上の方針）: 他のクライアントでの確認、他のDB（PostgreSQLは上の保管中の作業）、Windows・Linux、署名と公証。

## 未検証事項

- 「AIがローカルのrepositoryを編集できる」ことと「MCP AppsのUIを表示できる」ことを、同じ画面で両立できるクライアント。
- CodexのクライアントアプリのMCP Apps対応。
- 実際のホストが、UIからの`sendMessage`を会話に入れ、AIの作業を再開させるか。
- 1回のレビューループの実際のトークン消費量。文字数は記録しているが、ホスト側で付加される分は含まない。
- 観点をまとめるよう明示しない依頼文でも、AIが自分からまとめるか。
- ADR-0009より前の実装が書いた実際の記録を、依頼票の形の全体を確かめるようになった実装で読めるか。利用者の記録（R1〜R15）は2026-10-10に失われ、確かめられなかった。古い形の記録を読むことは、テストで作った記録でだけ確かめている。
- 利用者の記録（R1〜R15）が2026-10-10 23:55ごろに失われた原因。
- Claudeデスクトップアプリの中のClaude Codeで、ブラウザの経路の`wait`が、未回答に戻して答え直した回答を待てるか（直した後の版）。`follows`での再依頼と、再依頼の画面の表示。
- Claude Codeでrootsにより対象が決まるか（rootsへの対応は起動ログで確認済み: Claude Codeは対応、Claude Desktopは非対応）。Claude Desktopで`_meta`が届かない場合の画面の動き（下の節）の、画面での見え方。
- Tauriにサーバーを同梱した手元のアプリのメモリ（ADR-0011）。大きさは`.app`が118MB、`.dmg`が37MB（macOS arm64）。
- 手元で動くアプリの雛形のWindows・Linuxでのビルドと起動（sidecarの作り方を含む）。署名と公証。`npm run dev:desktop`で、ウィンドウを閉じたときに開発用のプロセスが止まるか。
- 実際のクライアントで、AIが`required:`の依頼を人に伝えるか、作業の終わりに`inloop check`を動かすか（ADR-0022）。
- 大きなリポジトリで、`request_review`のたびに範囲のすべての変更にルールを当てる時間（inloop自身で、`main`からの範囲の`inloop check`は1秒未満）。
- `inloop new`で作ったアプリで、雛形の`inloop.json`が狙いどおりに当たるか（`createApp`、`openDb`など）。
- `inloop evidence run`と依頼票の証拠の表示を、実際のクライアントで使うこと。inloop自身の`inloop.json`には`evidence`を足していない。
- 依存の図と折りたたみで、行数の上限（ADR-0017）を超える依頼を人が判断できるか。実際の依頼で確かめていない。畳むコードを数えない数え方（ADR-0029）で、上限が緩すぎないかも同じ。
- `layer-direction`（ADR-0027）と`table`の当て方（ADR-0028）を、実際のクライアントで使うこと。`inloop new`の雛形の`layers`が、狙いどおり当たるか（雛形のアプリで`server/app.ts`から`web/`を使うなどの違反を作って確かめる）。
- 再依頼の画面の「から変更なし」（ADR-0029）の実クライアントでの見え方と、人が畳んだシンボルを開き直す使い勝手。画面の畳み方と開き直しは、実ブラウザのe2eで確認した（2026-10-12）。
