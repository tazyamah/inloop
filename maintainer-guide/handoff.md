# inloop継続開発ハンドオフ

現在地、未検証事項、次の一手だけを記録します。短く保つため、経緯と詳細は次の文書に分けています。考え方は[docs/concept.md](../docs/concept.md)、構成は[docs/architecture.md](../docs/architecture.md)、判断理由は[ADR一覧](decisions/README.md)を参照してください。

| 文書 | 内容 |
|---|---|
| [implementation-log.md](implementation-log.md) | 日付ごとの実装と検証の記録（追記専用） |
| [client-verification-results.md](client-verification-results.md) | クライアントごとの確認結果の表 |
| [known-limitations.md](known-limitations.md) | 既知の制約 |
| [open-questions.md](open-questions.md) | 方向性はあるが未決のこと |

## 現在地

最終更新: 2026-10-14

- 実装済み: MCPサーバーとレビューUI（会話内の埋め込みと、ブラウザの経路）、依頼と回答の記録（リポジトリごと）、解析エンジン（TypeScript＋SQLの依頼票、依存の図、畳み、証拠）、信頼境界ルールと必須の依頼、`inloop`コマンド（`new`・`init`・`apps`・`mcp`・`server`・`update`）、標準の構成の雛形（サーバー向け、`--desktop`のTauri）。詳細は[implementation-log.md](implementation-log.md)とADR。
- 主なクライアントは **Claude Code（デスクトップクライアント）**、構成は「macOS＋Claude Code＋SQLite」（利用者の方針、2026-10-12、ADR-0037）。この構成で、`inloop-demo`を使った信頼境界ルール・依存の図・再依頼の畳みの確認まで終えた（[implementation-log.md](implementation-log.md)の「人の確認の途中結果」）。
- テスト: macOSで`npm test`が通る（直近の数は[implementation-log.md](implementation-log.md)の末尾）。UIを変えたときは`INLOOP_UI_E2E=1 npm test`も動かす。
- `inloop generate scaffold`（ADR-0038）を実装した。表・API・テスト・画面の生成と、雛形の共通の見た目。自動テストと、生成アプリのビルド・ブラウザでの表示まで。実クライアントでの使用は未確認。
- `inloop new --standalone`（ADR-0039）を実装した。サーバーなしで、HonoをWeb Workerで動かし、SQLiteはsqlite-wasm（OPFS）に保存する。PWAとして配る。Chromiumと、iPhone実機のホーム画面のPWA（Cloudflare Pagesに置いた）で、保存・再起動後の保持・機内モードでの動作まで確認。Android、Chrome拡張は未確認。
- 端末どうしの共有（ADR-0040、ADR-0041）: `inloop new <名前> --sync`で、承認方式・暗号化・中継つきの共有を作れる（ローカルの中継と2つのブラウザまで確認）。`~/work/shopping`は旧方式（ADR-0040）のままで、新しい雛形へ移し直す予定。iPhone実機2台で承認の流れを確認済み（2026-10-13）。別のオーナーの検出の実機での表示は未（テストで確認）。`inloop generate scaffold`は、`--sync`のアプリにも使える（ADR-0042、生成した表の実機での同期は未）。
- データの書き出し・読み込み（ADR-0043）: `--standalone`・`--sync`の雛形に「データ」画面を入れた（Chromiumまで確認、iPhoneは未）。
- Chrome拡張（ADR-0044）: `npm run build:extension`で`dist/extension`を出す。アプリごとのIDで、中継に拡張のオリジンを許可する（実際のChromeへの読み込みとポップアップでの動作を確認済み、2026-10-13）。
- セキュアコードの検査（ADR-0045）: `inloop lint`と、雛形の`npm test`・`npm run build`、`inloop check`、scaffoldの生成での検査を実装した。自動テストまで。実際のClaude Codeでの使用と、既存のアプリでの偽陽性は未確認。
- 保管中の作業: PostgreSQLの雛形とSQL解析は、ブランチ`claude/postgres-template`に未マージで置いてある（PR 18は閉じた。他のミドルウェアはずっと後の方針のため）。
- npmでの名前の確保は行わない方針（`package.json`は`private: true`）。商標（J-PlatPat、USPTO）は未確認。
- 依頼票の図の文書[docs/diagrams.md](../docs/diagrams.md)を足した（2026-10-13）。図は依存の図とユースケース図（下）の2種類で、ER図・データフロー図は生成しない。サンプルは`scripts/diagram-samples.mjs`で作り直す。`npm test`は`inloop new --sync`の1件が失敗する（この変更の前から。[implementation-log.md](implementation-log.md)の2026-10-13のセキュアコードの検査を参照）。
- ユースケース図（ADR-0046）: `inloop.json`の`usecases`と命名規則の検査（`uc-*`）で、HTTPの入口ごとに、データ（テーブル・列）とテストを結ぶ。`inloop usecases`と、依頼票の画面の図。サーバー向けの雛形に入れた。自動テストとChromiumでの表示まで。値の流れは作らない。実クライアントでの使用、既存アプリの偽陽性、他の雛形（`--standalone`・`--sync`・`--desktop`）への適用は未。
- 公開向けの文書（README、LICENSE=MIT、docs/gallery.md、docs/licensing.md）を整えた（2026-10-13）。ライセンスの種類は暫定の既定で、利用者の確認待ち。
- 紹介スライド（`docs/slides/inloop-intro.html`、19枚、4枚目の直後に画面のイメージ、発表者モード・PDF印刷つきの単一HTML、2026-10-13）。本文は`inloop-intro.src.html`で、`node scripts/build-slides.mjs`でまとめ直す。Chromiumでの表示と発表者モードの同期まで確認。Safari・Firefox・macOSは未。

- Codex対応（ADR-0047）: init・newでプロジェクトMCP設定を生成する。既存設定を保持し、対象repoを全ツール呼び出しへ渡す。実クライアントの往復は未検証。最新mainへ統合済み。ADR番号の修正後のinit（R8-1）と、既存雛形の例外を本体のlint設定へ反映した変更（R9）は、人の承認済み（2026-10-14）。npm testは137 pass・16 skip・fail 0、inloop lintは違反なし。

## 次の一手

利用者の方針（2026-10-12）: まず、Claude Code（デスクトップ）で、webアプリとデスクトップアプリを楽に作れるようにする。ほかのクライアント（Claude Desktop、Codex、VS Code、Claude Code CLI）、他のミドルウェア（DBなど）、他のOSは、それが済んでからでよい。ただし設計は、後から足せるように保つ。

1. scaffoldの実クライアントでの確認と調整（ADR-0038。実装済み）。Claude Codeの会話で、AIが`inloop generate scaffold`を使って機能を作るか、生成された画面の見た目と操作が使えるものか、足りないもの（関連、並べ替え、検索、列の型、日本語の表示名など）を、実際にアプリを作って洗い出す。手順は、新しいアプリを`inloop new`で作り、Claude Codeで開いて「○○を管理する機能を作って」と頼む。
2. データの書き出し・読み込み（ADR-0043）の、iPhoneでの確認。拡張からの共有（同期）の実機での確認。
3. `--standalone`（ADR-0039）の次: Chrome拡張の入れ物（MV3）を足す。データの書き出し・読み込み。配る手順（Cloudflare Pagesへの`wrangler pages deploy`）の雛形への反映。
4. 利用者の判断待ち（困ったときに戻る）: 再依頼で、保留のあとも畳むか。行単位の差分が要るか。

Codex対応は2026-10-14の依頼で先行した（ADR-0047、レビュー指摘の修正はADR-0048）。次はCodexで依頼・UI表示・人の回答取得を確認する。

後回し（理由: 上の方針）: Codex以外の他のクライアントでの確認、他のDB（PostgreSQLは上の保管中の作業）、Windows・Linux、署名と公証。

## 未検証事項

- ユースケース図（ADR-0046）を、実際のClaude Codeの会話で、AIが命名規則（`uc-*`）に反して書いたとき`inloop lint`の出力から直せるか。`usecases`を書いた既存アプリでの偽陽性。テストのない入口を違反にするか。
- セキュアコードの検査（ADR-0045）を、実際のClaude Codeの会話で、AIが違反を書いたときに自力で直せるか。既存のアプリ（`~/work/shopping`など）での偽陽性。
- `--standalone`（ADR-0039）で作ったアプリの、Android。Chrome拡張でのWASMとOPFS。複数タブ、容量、ブラウザのデータの自動削除。scaffoldで作った画面のブラウザ上の操作。
- `inloop generate scaffold`（ADR-0038）を、実際のClaude Codeの会話でAIが使うこと。生成した画面のライトテーマ、狭い画面、`--desktop`のアプリでの表示。古い雛形のアプリ（目印がない）での案内。
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
