# 実装の経緯

日付ごとの実装と検証の記録です（追記専用。古い記録は書き換えず、新しい記録を末尾に足します）。現在地は[handoff.md](handoff.md)、判断理由は[ADR一覧](decisions/README.md)を参照してください。見出しの日付は記録した日で、時系列に並んでいます。

## 2026-10-10 最小MCPサーバーとレビューUI

- `src/server/`: MCPサーバー（stdio）。AIから見えるツールは`request_review`（戻り値は`R1 pending`だけ）と`get_review_result`（sendMessageを使えないホスト向けの代替）。UI専用の`inloop_get_request`と`inloop_submit`は`visibility: ["app"]`。依頼と回答は、この時点ではプロセス内のメモリにだけ保持していた（保存は次々項）。
- `src/ui/`: MCP AppsのUI。依頼票（理解順の対象、信頼境界、未解決の参照、証拠）、未回答の依頼の受付箱、コード行クリックでの参照設定、まとめての回答、`sendMessage`での会話への送信、全画面表示の要求。esbuildで外部依存のない単一HTML（約610KB）にする。
- AIの文脈に入る量はstderrに`model-bound`として記録する。テストでの観測: `request_review`の戻り値は10文字、2件の回答メッセージは117文字（193バイト）、AIから見えるツール定義2件で838文字。
- 使用したSDK: `@modelcontextprotocol/ext-apps` 2.0.3、`@modelcontextprotocol/server`／`client` 2.3.1、TypeScript 7.0.2。

検証: `npm test`は8 pass・2 skip（ブラウザ検証）・fail 0（ローカルのLinux VM、Node.js 22.23.2）。`INLOOP_UI_E2E=1`で、クラウド環境のPlaywright 1.55.0＋Chromiumにより全10件pass（Node.js 22.22.0）。ライト・ダークの画面写真を目視で確認した。macOS（Node.js 22.18.0、nvm）でも`npm ci && npm run build && npm test`が8 pass・2 skip・fail 0。

## 2026-10-10 行起点のコメントUIと、1依頼への複数コメント

利用者の指摘を受けて、回答の操作をGitHubのコードレビュー風に作り直した。常に表示していたコメント欄を廃止し、行クリックで行の直下にコメント欄を開く。宛先候補（その行のシンボルを含む未回答の依頼）が複数なら先に依頼を選ばせる。Shift+クリックで行範囲、吹き出しの編集・削除、依頼全体へのコメント、⌘/Ctrl+Enterでの追加、Escでの取消し、書きかけ中の送信禁止、ウィンドウへのフォーカス時の受付箱の再取得を加えた。

プロトコルも変えた（[review-protocol](../docs/review-protocol.md)）。1つの依頼に`fix`/`ask`を行ごとに複数付けられ、参照に行範囲（`#L44-L46`）を使える。`ok`/`hold`は単独の1行のみ。参照は依頼票の表示範囲内の行に限る。受付箱の各項目に`symbols`を加えた。

Claude Desktop（通常の会話）での確認（2026-10-10）: 依頼2件で、44行目のクリックで宛先選択が出てR1を選び、Shift+クリックで44〜46行目の範囲コメントを付け、R2を承認して送信した。会話に`R1 fix src/db/orders.ts#cancelOrder#L44-L46 "..."`と`R2 ok`の2行が入り、AIは依頼IDと参照範囲を正しく復唱し、R2の承認も依頼内容と対応づけて理解した。

検証: クラウド環境で`INLOOP_UI_E2E=1`の全12件pass（サーバー9件、ブラウザ3件）。画面写真（宛先選択、回答入力、ダーク）を目視で確認した。

デバイス連携のLinux VMでのビルド: リポジトリのnode_modulesはmacOS用（TypeScript 7とesbuildのネイティブ実行ファイル）なので、VMではリポジトリ内で直接ビルドできない。VMの`~/inloop-linux`へnode_modulesとdistを除いて写し、そこで`npm ci && npm run build && npm test`を実行し、`dist/`だけをリポジトリへ上書きで戻す。distはプラットフォームに依存しない。リポジトリのnode_modulesには触れない。この手順で、上記の変更をビルドし、サーバーとstdioのテスト9件がVM上とリポジトリのdistの両方でpassした（ブラウザテストはVMにChromiumがないためskip）。

## 2026-10-10 依頼と回答の保存

保存先と形式をADR-0007で決め、実装した。

- `src/server/store.ts`: `ReviewStore`に保存先（`file`）を渡すと、追記専用のJSON Lines（`request`と`answer`の2種類、版`v: 1`）に記録する。状態は保存せず、記録を先頭から適用して再現する。各操作の前に、ファイルのまだ読んでいない部分だけを読み込むので、同じ記録を複数のプロセスが使える。読めない記録は行を示して拒否し、以後の操作も同じ理由で拒否し続ける。
- `src/server/main.ts`: `--state-dir <dir>`（`--state-dir=<dir>`も可）と環境変数`INLOOP_STATE_DIR`。引数が優先する。指定がなければメモリで動き、起動時のログに`state=memory`と出す。保存先を使えない、記録を読めない、知らない引数がある場合は、終了コード1で終わる。
- 回答の検証（参照が依頼票の表示範囲内か、など）は記録する前にだけ行う。記録を読むときは、依頼の存在と未回答であることだけを確かめる。
- AIから見えるツール、戻り値、UIは変えていない。

検証: デバイス連携のLinux VM（Node.js 22.23.2）で、下記の手順でビルドし、`npm test`が16 pass・3 skip（ブラウザ検証、VMにChromiumがない）・fail 0。追加したのはサーバー5件、stdio2件。リポジトリに戻した`dist/`に対しても同じ16件がpassした。UIを変えていないため、`INLOOP_UI_E2E=1`は実行していない。macOSでの`npm ci && npm run build && npm test`は未実行。

Claude Desktop（通常の会話）での確認（2026-10-10）: 登録に`--state-dir`を足して再起動し、起動ログが`state=<状態ディレクトリ>/reviews.jsonl`になった。依頼R1を出して承認し、アプリを再起動してから別の会話で依頼すると`R2`になり、受付箱にR1が承認済みで残っていた。再起動前の会話に戻ると、R1のUIが再表示された。

このとき利用者から指摘があった: 再起動前の会話（R1を依頼した会話）のUIにR2も出て、そこから回答できてしまう。これは次項で対処した。

## 2026-10-10 1回の呼び出しを回答のまとまりにする

経緯と、試して捨てた方式（会話の印をAIに持ち回らせる）はADR-0008に記録した。要点:

- ホストの情報では会話を区別できない。`tools/call`の`_meta`をログに出して調べた（`src/server/main.ts`の`[inloop] call tool=... meta=...`と`[inloop] initialize client=...`。引数は記録しない）。Claude Desktopは複数の会話で1つのサーバープロセスを共有し、AIからの呼び出しの`_meta`は`null`だった。
- 印をAIに持ち回らせる方式は、Claude Desktopで4通り試して、AIは2件目の依頼で一度も印を渡さなかった。
- そこで、1回の呼び出しをまとまりの単位にした。

実装:

- `request_review`: 引数を`reviews`（`{viewpoint, symbols?}`を1〜10件）と`range`にした。戻り値は`R1 R2 pending`、structuredContentは`{ids}`。
- `inloop_get_request`: 受付箱を、その依頼と同じ呼び出しの依頼だけにした。ほかの未回答の件数`elsewhere`を返す。
- `inloop_submit`: UIが開かれた依頼のID`from`を必須にした。まとまりが異なる依頼への回答を含む送信は、全体を拒否する。
- `get_review_result`: `ids`を必須にした。
- UI: 呼び出しで最初に作られた依頼を表示する。ほかに未回答の依頼があれば、受付箱の末尾に件数を出す。送信時に`from`を渡す。
- 記録: `packet.group`（その呼び出しで最初に作った依頼のID）が増えた。1回の呼び出しの依頼は1回で書き込む。`group`のない古い行は、その依頼だけのまとまりとして扱う（版は1のまま）。利用者の状態ディレクトリにある既存の記録（R1〜R13、`group`なし。R5以降は捨てた方式の`thread`を含むが無視される）が読めることを、写しで確認した。
- AIの文脈に入る量: `request_review`の戻り値は1件なら10文字のまま。AIから見えるツール定義2件は838文字から1043文字。

Claude Desktop（通常の会話）で確認できたこと（2026-10-10、印の方式の試行中）: 別々に出した依頼は、それぞれのUIの受付箱に自分の1件だけが出て、ほかの未回答は件数だけが表示された。別の会話の依頼に回答してしまう問題は起きなくなった。

検証: デバイス連携のLinux VM（Node.js 22.23.2）で`npm test`が19 pass・4 skip（ブラウザ検証）・fail 0。クラウド環境（Playwright 1.55.0＋Chromium）で`INLOOP_UI_E2E=1`の全23件pass。画面写真（ほかの依頼の件数表示）を、文言を変える前の版で目視で確認した。macOSでのテストは未実行。

Claude Desktop（通常の会話）での確認（2026-10-10）: 「次の2点をレビュー依頼して」と観点を2つ並べて頼むと、AIは1回の呼び出しにまとめ、R14とR15が1つのUIの受付箱に並んだ。記録でも2件が同じまとまり（`group`がR14）だった。末尾には「ほかに未回答の依頼が12件あります」と出た（それまでの試行で残ったR2〜R13）。続けて、R14の44行目に修正依頼のコメントを付け、R15を承認して「まとめて送信」を押すと、会話に`R14 fix src/db/orders.ts#cancelOrder#L44 "..."`と`R15 ok`の2行が1通で入った。AIはR14の依頼IDと参照行を復唱し、R15の承認を依頼内容と対応づけて理解した。記録にも、この2行が1回の送信として残った。

## 2026-10-11 状態遷移の確定（再依頼の枝番、未回答に戻す操作）

判断と理由はADR-0009に記録した。利用者との相談で、再依頼は「同じIDが未回答に戻る」でも「新しい通し番号」でもなく、元のIDに枝番を付ける形にした。

実装:

- 依頼ID: 新しい依頼は`R13`、再依頼は`R13-1`、`R13-2`。枝番を除いたIDが同じ依頼を系列と呼ぶ。新しい依頼の番号は、枝番に関係なく続きから振る。
- 状態に`superseded`（再依頼済み）を足した。再依頼すると、系列のそれまでの最新の依頼が`superseded`になり、枝番の依頼が`pending`で始まる。`superseded`の依頼には、どの画面からも回答できない。
- `request_review`: `reviews`の項目に`follows`（元の依頼のID、系列のどれでもよい）を足した。`follows`があれば`viewpoint`と`symbols`は省略でき、最新の依頼から引き継ぐ。不正な依頼が1つでもあれば、呼び出し全体を拒否する（エラーの文はAIに返る。テストでは最長20文字）。
- `inloop_reopen`（UI専用）: `held`・`answering`の依頼を、同じ依頼票のまま`pending`に戻す。`fixing`と`approved`は戻せない（再依頼で引き継ぐ）。会話には何も送らない。
- `inloop_get_request`: 戻り値に`history`（その依頼と、系列でそれより前の依頼に付いた回答）を足した。受付箱の項目に`supersededBy`を足した。
- 記録: 種類`reopen`（`ids`）を足した。再依頼は、枝番のIDを持つ`request`として記録する。版は1のまま（判断の基準はADR-0009）。読み込みで、依頼票の形の全体と、状態遷移との整合を確かめるようにした（`src/server/store.ts`の`packetSchema`）。知らない項目は無視する。
- 回答のメッセージの先頭行を変えた: `[inloop] レビュー回答。fixは修正後にrequest_reviewのfollowsで再依頼、askは会話で答える:`。
- UI: 保留中・回答待ちの依頼に「未回答に戻す」ボタン。依頼票に「これまでの回答」。再依頼の依頼票には「R13の再依頼（1回目）」。再依頼済みの依頼は「再依頼済み → R13-1」と表示する。
- AIの文脈に入る量: AIから見えるツール定義2件は1043文字から1139文字。回答のメッセージの先頭行は46文字から62文字。`request_review`の戻り値は、再依頼1件で`R13-1 pending`（13文字）。
- [review-protocol](../docs/review-protocol.md)を、確定した内容に書き換えた。「草案」の扱いは、解析エンジンに関わる未決事項だけになった。

検証（クラウド環境、Node.js 22.22.0）:

- `npm test`: 25 pass・6 skip（ブラウザ検証）・fail 0。追加したのはサーバー6件。
- `INLOOP_UI_E2E=1 npm test`（Playwright 1.56.0＋Chromium）: 全31件pass。追加したのはブラウザ2件。画面写真（再依頼の画面、再依頼済みの表示）を目視で確認した。
- 1つ前のcommitの実装に新しい記録を読ませ、`reopen`の行を「知らない種類」、枝番の依頼を「依頼票の形が不正」として拒否すること、新しい機能を使っていない記録はそのまま読めることを確かめた。逆に、古い形の記録（`group`なし、知らない項目`thread`あり）を新しい実装が読めることも確かめた。
- 既存のブラウザテストにあった競合を直した。全画面表示の要求がホストに届く前に結果を見ていて、画面写真を保存しながら実行すると1回失敗した。届くまで待つようにした。
- macOSでのテスト、デバイス連携のLinux VMでのビルドは未実行。利用者の手元の`dist/`は、この変更を含んでいない。Claude Desktopで使うには、ビルドし直してClaude Desktopを再起動する。

## 2026-10-11 macOSでのテストと、Claude Code（デスクトップアプリ）の確認

実装は変えていない。`claude/review-lifecycle`（76c5be8）で確かめた。

- macOS（Node.js 22.18.0、nvm）で`npm ci && npm run build && npm test`: 25 pass・6 skip（ブラウザ検証）・fail 0。`INLOOP_UI_E2E=1`は実行していない。
- 既存の記録の読み込み: 確かめられなかった。利用者の状態ディレクトリの`reviews.jsonl`は0バイトで、作成時刻は2026-10-10 23:55（JST）だった。Claude Desktopのサーバーログには、その前にR14・R15の依頼と送信が残っており、23:55にサーバーが再起動した時点で前のファイルはなかった（サーバーは空のファイルを作る）。R1〜R15の記録が消えた原因は調べていない。写しも見つかっていない。
- Claudeデスクトップアプリの中のClaude Codeに、`claude mcp add`（スコープはlocal）で、別の状態ディレクトリを指定してinloopを登録し、アプリを再起動して確かめた。
  - Claude Codeが起動したサーバーは接続した（`initialize`のクライアント名は`claude-code` 2.1.295）が、ツールの呼び出しは届かなかった。`mcp__inloop__request_review`の呼び出しは、Claude Desktopの設定（`claude_desktop_config.json`）で起動された同名の`inloop`サーバーに届き、その状態ディレクトリに記録された。同じ名前のサーバーが両方にあると、Claude Desktopの設定のほうが使われるらしい（記録とログからの推測）。名前を変えて登録した場合は確かめていない。
  - AIに見えたツールは`request_review`と`get_review_result`の2つだけ。`request_review`（2件）の結果としてAIに見えたのは`{"ids":["R1","R2"]}`（structuredContent）で、テキストではなかった。回答のない`get_review_result`の結果は`None`と見えた（テキストは`none`）。Claude Desktopの通常の会話と同じく、structuredContentだけがAIに渡るとみられる。
  - レビューUIは表示されなかった（利用者が画面で確認）。そのため、回答の会話への反映、「大きく表示」、ADR-0009で足した機能（未回答に戻す、`follows`での再依頼、再依頼の画面）は、このクライアントでは確かめていない。
  - サーバーログの`model-bound`: `request_review`（2件）が13文字、`get_review_result`が4文字。
- この確認の途中で、上の経路の取り違えにより、利用者の状態ディレクトリの記録に依頼2件（R1・R2）を書き込んだ。利用者の判断で0バイトに戻した。動いていたClaude Desktopのサーバーは「記録が短くなっている」として以後の操作を拒否するので、再起動が要る。

## 2026-10-11 ブラウザで開く経路と、複数のアプリを作るときの形

判断と理由はADR-0010、ADR-0011、ADR-0012に記録した。

実装（ADR-0012）:

- `src/server/browser.ts`: `--ui browser`で、127.0.0.1の空いているポートにHTTPを開く。起動ごとの鍵（URLの`t`）とHostヘッダーを確かめ、UI専用のツールだけを`POST /api/call`で呼べる。
- `src/ui/browser-host.ts`・`browser-host.html`: ブラウザ側のホスト。既存のレビューUIをiframeに読み込み、MCP Appsのホストの役を務める。`dist/ui/browser.html`（約600KB）になる。
- `src/server/create-server.ts`: UI専用のツールを`appTools`に切り出し、MCPとHTTPで共通にした。ブラウザの経路では、`request_review`が`R1 R2 pending <URL>`と`{ids, url}`を返す。`get_review_result`に`wait`（最大1800秒）を足した。保留・質問を受け取った後に待つと、人が答え直すまで待つ。
- `src/server/main.ts`: `--ui browser|mcp-apps`。標準入力が閉じたら終わる。`initialize`の`capabilities`もログに出すようにした（クライアントがrootsを知らせられるかを調べるため、ADR-0010）。
- AIの文脈に入る量: 依頼の戻り値はURLの分（約55文字）増える。AIから見えるツール定義は、どちらの経路でも1500文字未満（テスト）。

検証:

- macOS（Node.js 22.18.0）で`npm test`が30 pass・6 skip（ブラウザ検証）・fail 0。追加したのはブラウザの経路4件、stdio1件。`INLOOP_UI_E2E=1`は、このMacにPlaywrightのパッケージがないため実行していない。UIのコードは変えていない。
- 試験用のサーバーで、Claudeデスクトップアプリのブラウザペインに画面を表示し、受付箱の2件、承認と保留の送信、「回答を記録しました」の表示を確かめた（Claude Codeのブラウザ操作で確認）。
- Claudeデスクトップアプリの中のClaude Codeに`inloop-code`として`--ui browser`で登録し、依頼2件（R1・R2）を出した。記録は登録した状態ディレクトリに入った。利用者がURLを普通のブラウザで開き（ブラウザペインは利用者の画面に出なかった）、R1を保留、R2を質問で送信すると、待っていた`get_review_result`に2行が届いた。R2を未回答に戻して承認すると記録に残ったが、待ち受けが答え直しを待たずに戻った。この不具合を直し、直した後は自動テストでだけ確かめている。
- 手順4のうち、修正依頼と`follows`での再依頼は、このクライアントでは確かめていない。
- Claudeデスクトップアプリの中のClaude Codeでは、Claude Desktopの設定に登録したMCPサーバーも、同じ名前でツールとして見えた（`claude-code`を足すと`mcp__claude-code__*`が現れた）。名前が重なると、Claude Desktopの設定のほうが呼ばれる。

設計（ADR-0010、ADR-0011、利用者と相談して決定）:

- 対象はgitの作業ツリー1つ。記録は`<対象>/.inloop/reviews.jsonl`。依頼IDは対象ごと。対象はAIの引数`repo`、起動時の`--repo`、クライアントのrootsで決め、決まらなければ拒否する。別の作業ツリー（`git worktree`）は別の対象。gitでないフォルダは拒否する。
- `inloop`コマンドを手元に1回入れる（当面はgitでcloneしてパスを通す）。`inloop mcp`、`init`、`new`、`update`。
- 標準の構成: サーバーで動くアプリはReact＋Hono＋SQLite。手元で単体で動くアプリはReact＋Tauri＋同梱したHono＋SQLite。PostgreSQLはオプション。

Claude Desktopから手元のMacを直接扱う試み: 利用者が`claude_desktop_config.json`に`claude-code`（`claude mcp serve`）を足し、アプリが起動したことを確かめた（作業ディレクトリは`/`）。通常の会話で使えるか、速いかは未検証。

## 2026-10-11 回答した依頼の画面を記録として残す

利用者の指摘を受けて、回答した後の画面の表示を変えた（[review-protocol](../docs/review-protocol.md)の「UIでの回答の操作」）。方針は、遠い未来に記録を見ても矛盾がないこと、回答し終えた画面は記録として残し、次の依頼へ辿れる程度の変化に留めること。画面を自動で最新にする仕組みは作らず、再読み込みする運用とした。

- 上部に回答後の状態を出す。再依頼された後は、目立つボタン「再依頼済み → R13-1」になり、ブラウザで開く経路では押すと引き継ぎ先のページに移る（ブラウザのホストが`openLink`の`inloop:review/<ID>`を受けて移る）。MCP Appsでは、再依頼した会話の画面を案内する。
- 「これまでの回答」を「前の依頼への回答」と「この依頼への回答」に分けた。送信の直後に記録を取り直し、再読み込みした時と同じ表示にする。
- 画面の依頼がすべて回答済みなら、送信の操作、操作の説明、ほかの依頼の件数を出さない。

検証: macOS（Node.js 22.18.0）で、`playwright@1.56.0`を`--no-save`で一時的に入れ、別のプロジェクトにあったChromium 149（Playwrightのrevision 1228）を`INLOOP_CHROMIUM`で指定して、`INLOOP_UI_E2E=1 npm test`が36件すべてpass。画面写真（再依頼済みの表示）を目視で確かめた。利用者がClaudeデスクトップアプリのブラウザペインで、R3の画面の上部のボタン、押すとR3-1に移ること、ほかに気になる表示がないことを確かめた。

見つかった問題（未対応）: サーバーが起動し直すと、ポートと鍵が変わり、それまでの画面のURLが使えなくなる。URLのうち`/r/<ID>`は変わらない。

この問題への対処として、画面をマシン全体で1つのサーバーから`http://<アプリ名>.inloop.localhost:4656/r/<ID>`で配り、鍵の代わりにHostとOriginを確かめることにした（ADR-0013、未実装）。`appa.inloop.localhost`がhostsの設定なしに自分のMacへ向くことを、`curl`、Claudeアプリのブラウザペイン、Safari（利用者が確認）で確かめた。

## 2026-10-11 対象のリポジトリごとの記録（ADR-0010、ADR-0014）

- `src/server/target.ts`: `Targets`が対象を決め、リポジトリごとの`ReviewStore`を持つ。順序は`--repo`、AIの`repo`、ちょうど1つのroots。gitの作業ツリーの最上位に正規化し、rootsと`--allow`の外は拒否する。`.inloop/`を作るとき、中に`*`だけの`.gitignore`を置く。`--state-dir`があれば、対象が決まらなくてもそこに記録する（互換）。
- `request_review`・`get_review_result`・UI専用のツールに、省略できる`repo`を足した。`request_review`の結果の`_meta`（`inloop/repo`）でUIに対象を渡す。記録と`structuredContent`には対象を入れない（ADR-0014）。
- ブラウザで開く経路のURLは`/r/<対象の印>/<依頼ID>`になった。HTTPの呼び出しは`/api/<対象の印>/call`で、対象はURLの印で決める。
- 起動引数に`--repo`と`--allow`（複数可）を足した。`--state-dir`がなければ、起動ログは`state=repo`になる。これまでの「指定がなければメモリにだけ保持する」動きはなくなった。
- AIから見えるツール定義は、`repo`の分だけ増えた（1500文字未満、テスト）。

検証: macOS（Node.js 22.18.0）で`npm test`が38 pass・6 skip・fail 0。追加したのは対象のテスト7件、stdio1件。`playwright@1.56.0`（`--no-save`）とChromium 149で`INLOOP_UI_E2E=1 npm test`が全44件pass。実際のクライアントでは未検証。

Claudeデスクトップアプリの中のClaude Codeでの確認（2026-10-11）: `--state-dir`なしで`--ui browser`の登録に直して開き直すと、起動ログは`state=repo`になった。AIが`repo`を渡さずに依頼すると、作業フォルダ（roots）からinloopリポジトリが対象に決まり、記録が`.inloop/reviews.jsonl`に入り、`.inloop/.gitignore`（`*`）ができ、記録に対象のパスは入らなかった。利用者がブラウザペインで承認すると、`get_review_result`の`wait`に`R1 ok`が届いた。このとき、AIの側で読み込んだツール定義は再登録前の古い説明（`repo`なし）のままだった。Claude Codeがツール定義を取り直すのはいつかは確かめていない。

ADR-0010との差異: ADR-0010は「依頼票に対象を記録し、UIの上部に表示する」としていたが、実装では記録に書かず、表示もしない。理由と決定はADR-0014に記録した。

## 2026-10-11 inloopコマンドと、マシン全体の画面のサーバー（ADR-0011の一部、ADR-0013）

- `bin/inloop`と`src/cli.ts`: `inloop mcp`（今の`dist/server/main.js`と同じ。中身は`src/server/mcp.ts`の`runMcp`）、`server`（画面のサーバーを前面で動かす）、`init [<dir>] [--name]`（登録簿に登録し、`.inloop/.gitignore`を置く）、`apps`、`update`（`git pull --ff-only`、`npm ci`、`npm run build`）。`new`と雛形、`.mcp.json`の作成、inloopの設定ファイルはまだない。
- `src/server/apps.ts`: 登録簿`~/.inloop/apps.json`（`INLOOP_HOME`で変えられる）。名前は既定でディレクトリ名を小文字にしたもの。
- `src/server/ui-server.ts`・`ui-main.ts`: 画面のサーバー。`127.0.0.1`と`::1`のポート4656（`INLOOP_PORT`）。Hostが`<登録したアプリ名>.inloop.localhost:<ポート>`でなければ拒否し、書き込みはOriginが同じ画面でなければ拒否する。`/_inloop/health`（宛先が127.0.0.1の場合だけ）で、ほかのプロセスが動作を確かめる。`--ui browser`のMCPサーバーが、起動時と依頼のたびに、動いていなければ別のプロセスとして起動する（MCPサーバーが終わっても残る）。
- ADR-0012のプロセスごとのポートと鍵（`src/server/browser.ts`）はなくした。`--ui browser`と`--state-dir`は併用できない。
- 登録していないリポジトリへの依頼は、記録の置き場所を作る前に拒否する。

検証: `npm test`が40 pass・6 skip・fail 0。`INLOOP_UI_E2E=1`（`playwright@1.56.0`、Chromium 149）で全46件pass。実プロセスのテストで、2つ目のMCPサーバーが動いている画面のサーバーを使い、URLが変わらないことを確かめた。inloopリポジトリを`bin/inloop init`で登録した（アプリ名`inloop`、URLは`http://inloop.inloop.localhost:4656/r/<ID>`）。

Claudeデスクトップアプリの中のClaude Codeでの確認（2026-10-11）: 開き直すとMCPサーバーが画面のサーバーを別のプロセスとして起動し、`127.0.0.1`と`::1`の4656で待ち受けた。依頼R2のURL`http://inloop.inloop.localhost:4656/r/R2`をブラウザペインで開いて利用者が承認し、`wait`に`R2 ok`が届いた。もう一度アプリを開き直すと、MCPサーバーは新しいプロセスになったが、画面のサーバーは同じプロセスのまま残り、同じURLでR2の画面（承認済み）が開けた。

未対応: ログイン時の自動起動はない（MCPサーバーが起動する）。

## 2026-10-11 画面のサーバーの管理と、inloop new（ADR-0011の一部）

- `inloop server status|stop|restart|start`。引数なしは前面で動かす。画面のサーバーは`SIGTERM`で止まる。
- 画面のサーバーは`/_inloop/health`でビルドの印（`dist/server/ui-server.js`の更新時刻）を返す。MCPサーバーは、動いているのが今のビルドより古ければ、止めて起動し直す。`inloop update`やビルドの後は、次の依頼で新しい版になる。
- `inloop new <dir> [--name] [--db sqlite]`: `templates/server/`を写し（`__APP_NAME__`を置き換え、`gitignore`を`.gitignore`にする）、`git init`し、`inloop init`と同じ登録をする。空でないディレクトリ、使われているアプリ名は拒否する。`--db postgres`と`--desktop`（Tauri）は「まだない」として拒否する。
- 雛形（サーバーで動くアプリ）: React 19＋Vite 8（`web/`）、Hono 4＋`@hono/node-server`（`server/`、ポート8787）、SQLiteはNode.js組み込みの`node:sqlite`（Node.js 22.13以上、起動時に実験的機能の警告が1回出る）。ネイティブのビルドが要らずTauriへの同梱（ADR-0011）が楽なので、`better-sqlite3`ではなくこれにした（利用者と確認、2026-10-11）。サーバーの実行とテストは`tsx`、型検査はTypeScript 7。例としてメモの一覧と追加、テスト2件。AIへの指示は`AGENTS.md`（`CLAUDE.md`から読む）に、レビュー依頼の出し方を書いた。
- `.mcp.json`の作成と、inloopの設定ファイル（ルール、版）はまだない。`.mcp.json`は、Claude Desktopの設定と名前がぶつかる件（ADR-0012の影響）をどう扱うか決めてから作る。

検証: `npm test`が41 pass・6 skip・fail 0（追加はstdio2件の拡張と`inloop new`1件）。`INLOOP_UI_E2E=1`で全47件pass。`inloop new demo-app`で作ったリポジトリで、`npm install`、`npm test`（2 pass）、`npm run build`（型検査と画面のビルド）が通り、`npm start`相当でサーバーを起動して`/api/health`・メモの追加と一覧・ビルドした画面の表示（ブラウザペインでReactの描画とメモの表示）を確かめた。`npm run dev`は確かめていない。

## 2026-10-11 .mcp.jsonの作成

- `inloop init`と`inloop new`が、リポジトリの`.mcp.json`に`inloop`（`command: "inloop"`、`args: ["mcp", "--ui", "browser"]`）を書く。ほかのサーバーの登録は残し、同じ内容なら書き直さない。端末固有のパスを含めないので、commitしてよい。
- Claudeデスクトップアプリの中のClaude Codeは、MCPサーバーにシェルの`PATH`（nvmのnodeや`~/.local/bin`を含む）を渡していた。`inloop`を使うには、シェルの設定で`<inloopのclone>/bin`に`PATH`を通す。
- inloopリポジトリ自身にも`bin/inloop init .`で`.mcp.json`を置いた。
- 名前の重なり: Claude Desktopの設定に`inloop`があると、Claudeデスクトップアプリの中のClaude Codeでは、そちらが呼ばれる（2026-10-11）。`.mcp.json`の`inloop`を使うには、Claude Desktopの設定の`inloop`を外す必要がある。利用者の環境では外した（Claude Desktopの通常の会話ではinloopを使わない状態）。

検証: `npm test`が42 pass・6 skip・fail 0（`.mcp.json`のテストを追加）。

Claudeデスクトップアプリの中のClaude Codeでの確認（2026-10-11）: 利用者が`~/.zshrc`で`bin`に`PATH`を通し、Claude Desktopの設定から`inloop`を外し、`inloop-code`の登録を外して開き直した。許可を求める画面ははっきりとは出なかったが、`.mcp.json`の`inloop`が`PATH`の`inloop`で起動し、依頼R3が`http://inloop.inloop.localhost:4656/r/R3`を返し、ブラウザペインでの承認が`wait`に届いた。ターミナルの`claude mcp list`では、このサーバーは「承認待ち」のままだった（ターミナル版の承認は別に管理されているらしい）。このとき、古い版の画面のサーバーが新しい版に自動で作り直されたことも確かめた。AIの側で読み込んだツール定義は、古い版の説明のままだった（引数`wait`は実際には働いた）。

## 2026-10-11 解析エンジンの最初の版（ADR-0015）

- `src/engine/project.ts`: TypeScript 7の`typescript/unstable/sync`を使う部分。リポジトリ直下の`tsconfig.json`を読み、宣言の一覧（シンボルID`パス#名前`、メンバーは`.`）と、宣言の中の呼び出し・`new`・型の参照・継承の行き先を返す。別名（import）は`getAliasedSymbol`でたどる。APIが返すパスは小文字のことがあるので、小文字で突き合わせる。
- `src/engine/diff.ts`: 範囲の基点と作業ツリーの`git diff -U0`から、変わった行を出す。
- `src/engine/build.ts`: 依頼票を組み立てる。指定したシンボルと直接の依存を（数の上限なく）定義が先の順に並べる。クラスを型として参照しただけなら並べず、`new`ならコンストラクター。宣言までたどれない呼び出しは未解決。`kind`は`optional`、`layer`・`boundaries`・`evidence`は空。
- `ReviewStore`に依頼票の作り方（`build`）を渡せるようにした。対象のリポジトリの記録はエンジン、それ以外は固定データ。作れなければ（見つからないシンボルなど）何も記録しない。
- 依頼票の`change`に`unchanged`、`fixture`に`false`を足した（版は1のまま）。UIは`fixture`のときだけ固定データの注意を出し、空の`layer`を出さず、証拠がなければ「まだ取り込んでいない」と出す。
- `typescript`（7.0.2固定）を実行時の依存にした。
- テスト用のリポジトリは`test/helpers.mjs`の`makeRepo`（tsconfig.jsonと小さなソース）で作る。

検証: `npm test`が52 pass・6 skip・fail 0（追加はエンジン9件、対象1件）。`INLOOP_UI_E2E=1`で全58件pass。inloop自身のコードで、`createServer`・`main`・`Targets.resolve`の依頼票を作り、並びと変更行を目で確かめた（1回200〜450ミリ秒）。実際のクライアントでは未検証。

## 2026-10-11 R4の指摘への対応と、バックグラウンドで待つ方式（ADR-0016）

- 利用者のレビュー（R4、本物の依頼）で、依頼票に並べる数の上限（12個）は根拠がなく、画面の側では無制限にし、制限はAIの側に課すべきと指摘された。上限をなくし、ADR-0015を直した（R4-1で承認）。AIの側に課す制限（何を数えるか、上限の値）は未決。
- 利用者から、「まとめて送信」で会話に知らせ、ポーリングのように待たない形がよいという要望。channelsはデスクトップアプリで使えない見込みなので、`inloop wait`をバックグラウンドで動かす方式にした（ADR-0016）。`src/server/wait.ts`の`answersOf`を、`get_review_result`の`wait`と共通にした。
- 利用者から、往復の議論をするにはこの画面は使いづらいかもしれない、という感想。どこがやりにくいかは未確認。

検証: `npm test`が53 pass・6 skip・fail 0。実際のクライアントで、R6のあとAIが`inloop wait R6`をバックグラウンドで動かして手番を終え、利用者の送信だけでAIの続きが始まった（利用者は会話に何も書いていない）。

## 2026-10-11 会話での議論と記録、依頼の大きさの上限（ADR-0017）

- 利用者ごとの設定`~/.inloop/config.json`（`src/server/apps.ts`の`userConfig`）: `maxReviewLines`（既定60）、`approvePhrases`（既定`["承認"]`）、`holdPhrases`（既定`["保留"]`）。
- 依頼票のコードの行数が上限を超え、対象のシンボルが2つ以上なら、依頼を断る（`src/engine/build.ts`）。
- 画面に「位置をコピー」。回答できる依頼のない行は、クリックで位置をコピー（Shiftで範囲）。形は`<依頼ID> <参照>`。
- AIから見えるツール`answer_review`: 人が会話で設定の言葉を言ったときだけ、承認・保留を記録する。言葉が一致しなければ記録しない。必須の依頼は対象外。記録の種類は`chatAnswer`。画面には「会話で」と出る。
- 雛形のAIへの指示（`templates/server/AGENTS.md`）に、会話での議論、言葉での記録、行数の上限を書いた。
- 利用者のメモ: 行数の上限は、データの流れなどの図で判断できるようになれば不要になるかもしれない。

検証: `npm test`が57 pass・7 skip・fail 0。`INLOOP_UI_E2E=1`で全64件pass。実際のクライアントでは未検証。

## 2026-10-11 画面を読む場所と記録に絞る（ADR-0018）

コメント欄と「まとめて送信」を外し、承認・保留を押したらすぐ記録、「まとめて承認」を足した。行のクリックは常に位置のコピー。`inloop wait`は既定では使わない。承認・保留の言葉は配列（`approvePhrases`・`holdPhrases`、R7の指摘）。検証: `INLOOP_UI_E2E=1 npm test`で全64件pass。実際のクライアントでは未検証。R7-1は未回答のまま。

## 2026-10-11 手元で動くアプリの雛形（ADR-0019）

`inloop new <dir> --desktop`でTauriの外枠を重ねた雛形を作る（`templates/desktop/`）。サーバーはNodeのSEAにして同梱。SEAのビルドと起動、宛先・送信元の確認は、生成したアプリで確かめた。Rust 1.99.0を入れて（利用者の許可、rustup）、生成したアプリで`cargo build`と`npm run package -- --bundles app`（118MB）が通り、`.app`を開いてサーバーの自動起動・画面の表示（利用者が目で確認）・終了時のサーバーの停止を確かめた。未検証: `npm run dev:desktop`、dmgなどのインストーラー。`inloop new`が画像を壊すバグを直した。

## 2026-10-11 信頼境界ルールと必須の依頼（ADR-0022）

- `inloop.json`（リポジトリ直下、commitする）: `format`（1）と`boundaries`（`id`・`question`・`match`）。当て方は`import`（`names`は任意）・`global`・`files`・`symbols`。知らない項目は拒否する。`src/engine/rules.ts`。
- `src/engine/boundaries.ts`: 範囲の基点から作業ツリーまでに変わったファイルにルールを当てる。TypeScriptは宣言ごと（`import`・`global`・`symbols`）、`files`に当たったファイルと最上位の文はファイル全体を1つの単位にする。TypeScript以外のファイルと消したファイルは`files`だけ。ルールは基点と作業ツリーの`inloop.json`の和。`inloop.json`の変更には組み込みの`inloop-config`が当たる。
- `src/engine/project.ts`: `uses`（importした名前と、外の名前の連なり）、`topLevel`（最上位の文）、`referencesIn`を足した。importの判定は型の解決で宣言をたどる。
- `src/engine/build.ts`: ルールに当たった単位ごとの必須の依頼を、同じ解析で作る。`#`のないシンボルID（ファイル）を扱う。`inloop.json`と消したファイルは、基点の中身を`<基点>:<パス>`として並べる。必須の依頼は行数の上限で断らない。
- `src/server/store.ts`: 同じ単位の必須の系列の最新の依頼のコードが今と同じなら作らず、違えば枝番の再依頼にする（`triggeredBy`は和）。必須の系列への`follows`で、対象と観点を変えさせない（固定データは対象外）。`reviews`が空の呼び出しを受け付ける。
- `request_review`: 必須の依頼があれば、テキストの末尾に`required:R6`、structuredContentに`required`。
- `inloop check [--repo] [--range]`（`src/server/check.ts`）: 当たった単位ごとに`ok`・`missing`・`changed`・状態を出し、1つでも`ok`でなければ終了コード1。記録は書かない。
- 雛形（`templates/server/inloop.json`、`templates/desktop/inloop.json`）とinloop自身（`inloop.json`）にルールを置いた。雛形のAIへの指示に、必須の依頼と`inloop check`を書いた。

検証: デバイス連携のLinux VM（Node.js 22.23.2、aarch64）で`npm test`が71 pass・7 skip・fail 0（追加は`test/boundaries.test.mjs`の13件）。VMからnpmの登録簿に届かなかったので、利用者の`node_modules`（macOS用）を写し、TypeScript 7とesbuildのLinux用の実行ファイルだけをクラウド環境で取って足した。UIは変えていないので、`INLOOP_UI_E2E=1`は実行していない。inloop自身で`inloop check --range main`を動かすと、この変更で必須の依頼が10件（すべて`missing`）になった。macOSでのテスト、実際のクライアントでの確認は未実施。

## 2026-10-11 依存の図と、変わっていない依存の折りたたみ（ADR-0020）

- 依頼票に`edges`（並べたシンボルどうしの使う関係、`call`・`new`・`type`・`inherit`）を足した。解析エンジンが、並べたすべてのシンボルの参照から作る（依存どうしの関係も含む。新しいシンボルは足さない）。`src/engine/project.ts`の`references`が`uses`（行き先と種類）も返す。読み込みで両端が`steps`にあることを確かめる。記録の版は1のまま。
- 画面: 依頼票の先頭に依存の図（`src/ui/graph.ts`、自前のSVG）。使われる側が左、矢印は使う側から使われる側へ。色は変更の印、太枠はAIの指定、未解決の参照を含むシンボルに印。箱を押すとそのコードへ移る。各シンボルの見出しの下に「使う」「使われる」。変わっていない依存（AIが指定していないもの）のコードは既定で畳み、「コードを表示（N行）」で開く。
- 「データの流れ」（値の追跡）は作っていない。
- 利用者の判断で、呼び出し元を1段だけ足した（ADR-0021）。依頼票の`callers`。指定したシンボルと変わったシンボルを呼び出す（`new`を含む、型の参照は含めない）宣言を、プロジェクト全体から探す。図の右の列に点線の枠で出し、コードは「呼び出し元」に畳んで並べる。inloop自身で1回の依頼が0.4〜0.6秒。
- [review-protocol](../docs/review-protocol.md)の「UIでの回答の操作」が、ADR-0018より前のコメント欄の説明のままだったので、今の操作に直した。

検証（クラウド環境、Node.js 22.22.0）: `npm test`が60 pass・10 skip・fail 0（追加はエンジン2件。サーバーの形の確認に6例）。`playwright@1.56.0`（`--no-save`）とChromiumで`INLOOP_UI_E2E=1 npm test`が全70件pass（追加はブラウザ3件）。画面写真（固定データの図、3つの関数の図と折りたたみ、呼び出し元）を目視で確かめた。ダークテーマの図も画面写真で確かめた。実際のクライアントでの表示、macOSでのテストは未検証。

## 2026-10-12 Claude Desktopの通常の会話での確認（ADR-0010）

- 設定は`mcpServers`に`inloop`を`--state-dir`なしで登録（起動ログは`state=repo`）。Claude Desktop（`claude-ai` 0.1.0）は`io.modelcontextprotocol/ui`のMIMEタイプを宣言するが、`roots`は宣言しない。
- 起動ログと`inloop-demo/.inloop/reviews.jsonl`で確認: AIが`repo`を渡し、依頼R6の記録が対象のリポジトリの`.inloop/`に書かれた（ADR-0010が実機で動く）。`request_review`の呼び出しの`meta=null`（`_meta`は届かない）でも、画面が`inloop_get_request`・`inloop_submit`を呼び、承認の回答が記録され、`answer_message`が会話に送られた。
- 利用者が貼ったAIの回答で、AIから見えるツールは`request_review`・`get_review_result`・`answer_review`の3つ（画面専用の`inloop_get_request`・`inloop_submit`・`inloop_reopen`は見えない）。`visibility: ["app"]`はClaude Desktopでも効いている。`answer_review`はAIが人の言葉を記録する設計どおりのツールで、必須の依頼は拒否される（ADR-0017、ADR-0022）。
- 利用者の報告: 画面は会話の中に出て、見え方も良かった（MCP Appsの表示がClaude Desktopの通常の会話で動く。画面写真は未確認）。
- `claude mcp serve`の登録で、Desktopの通常の会話から`inloop-demo/server/app.ts`を編集できた。許可の確認は0回、遅さは感じなかった（利用者の報告、ファイルの変更を確認）。
- `fix`への`follows`の再依頼（R7→R7-1）と「未回答に戻す」（R7-1の保留→reopen→承認、R3-5も同様）は、`reviews.jsonl`で確認した。R7に回答がなかったので、R7-1に`prior`は付かない（ADR-0029の仕様どおり）。
- Desktopでは、行クリックの位置のコピー自体は成功していたが、結果の表示欄が画面の最下部で見えなかった（利用者の確認）。利用者の要望で、位置を`sendMessage`で会話の入力欄に入れ、見える位置の通知も出す形にした（ADR-0032）。Desktopでは承認の`sendMessage`が、送らずに入力欄に入ることを、利用者の貼り付けから確認した。位置の挿入と、クリックした位置のすぐ上に出る通知は、実際のDesktopで確認した（利用者の報告、2026-10-12）。


## 2026-10-12 手元で動くアプリの雛形の残り（`dev:desktop`、インストーラー）

同じMac（arm64、Node.js 22.18.0、Rust 1.99.0）で、`inloop new <dir> --desktop`で作ったアプリを使って確かめた。

- `npm run dev:desktop`: 雛形のままでは起動しなかった。直した3点:
  - 画面（vite）が`localhost`、つまりこのMacでは`[::1]:5173`だけで待ち受け、Tauriが待つ`http://127.0.0.1:5173`に届かず、180秒で止まった。`templates/server/vite.config.ts`で`host: "127.0.0.1"`、`port: 5173`、`strictPort: true`にした（サーバー向けの雛形のREADMEも元から127.0.0.1と書いていた）。
  - Tauriのビルドは、開発中でも同梱するもの（`binaries/server-<ターゲット>`と`../dist/web`）がないと止まる。`scripts/prepare-dev.mjs`を足し、`beforeDevCommand`で先に動かす（`dist/web`を作り、sidecarがなければ作る。開発中の画面はvite＋tsxで動き、どちらも使わない）。
  - 直した後: 新しく作ったアプリ（sidecarと`dist`なし）で`npm run dev:desktop`が通り、`target/debug/dapp`のウィンドウ（960×720）が画面に出て、WebKitがviteにつながり、viteを通した`/api/notes`の読み書きが動いた。プロセスグループへのSIGINT（端末のCtrl+C）で、アプリ・vite・tsxがすべて止まり、ポートも空いた。ウィンドウの中身は目では確かめていない（画面収録の許可がない）。ウィンドウを閉じたときに`tauri dev`が止まるかは未検証。
  - 補足: `tauri dev`のプロセスだけにSIGINTを送ると、viteとtsxは止まるがアプリのウィンドウは残る（端末のCtrl+Cはグループに送るので問題にならない）。
- インストーラー: 既定の`npm run package`（`targets: "all"`）で、`.app`（118.05MiB）と`.dmg`（`src-tauri/target/release/bundle/dmg/<名前>_<版>_aarch64.dmg`、37.09MiB）ができた。署名・公証はしていない。`hdiutil verify`が通り、読み取り専用でマウントした`.dmg`の中の`.app`を起動すると、同梱のサーバーが空いているポートで起動し、`/api/health`と画面が返った。アイコンは仮のpng 1枚のまま（`.icns`はTauriが作った）。
- 直したバグ: アプリをシグナルで止める（強制終了、`kill`）と、Tauriの終了処理が動かず、同梱のサーバーが残っていた。`DESKTOP=1`のサーバーは、親とつながった標準入力が閉じたら終えるようにした（`templates/desktop/server/index.ts`）。直した後、アプリの`kill -9`でもサーバーが止まること、Apple Eventでの通常の終了でも止まること、動いている間はサーバーが止まらないことを確かめた。
- Windows・Linux: 未検証。このMacからは作れない。sidecarが今動いているNode（`process.execPath`）を写して作るので対象のOSのNodeが要り、TauriもLinuxはWebKitGTK、WindowsはMSVCとWebView2の環境で各OSのビルドを前提にする。CIなら、GitHub ActionsでOSごとのジョブ（`ubuntu-22.04`に`libwebkit2gtk-4.1-dev`などを入れる、`windows-latest`）で`npm ci && npm run package`を動かす。
- 検証: `npm test`が58 pass・7 skip・fail 0（`inloop new --desktop`のテストに、`prepare-dev.mjs`・`beforeDevCommand`・`devUrl`・viteの待ち受けの確認を足した）。ADR-0022のmainを取り込んだ後、同じMacで`npm test`が71 pass・7 skip・fail 0（ADR-0022のテストのmacOSでの初めての実行）。生成したアプリの`npm test`が2 pass。inloopのUIは変えていないので、`INLOOP_UI_E2E=1`は動かしていない。
- ADRの番号: 並行したセッションで、信頼境界ルールと依存の図の両方がADR-0020を使った。GitHubのmainにある依存の図（0020）と呼び出し元（0021）はそのままにし、信頼境界ルールを0022に振り直した（ファイル名、本文、一覧、コード・文書・`inloop.json`の参照。利用者の判断）。そのうえでGitHubのmainを取り込み、`src/engine/build.ts`（ファイル単位の並びと`edges`・`callers`の両方）、`src/engine/project.ts`（`topLevel`と`repoFiles`、`references`の`uses`）、ADR一覧、handoffの衝突を、両方の変更を残して解消した。
- 取り込んだ後の検証（同じMac）: `INLOOP_UI_E2E=1 npm test`が全83件pass（Playwright 1.56.0、Chromiumは手元にあったheadless shell 1228を`INLOOP_CHROMIUM`で指定）。取り込んだ雛形で作り直したアプリの`npm test`が2 pass、`npm run build`が通った。ファイルを対象にした必須の依頼（`#`のないID）の依頼票で、`callers`がどう振る舞うかは確かめていない（名前の照合はファイル名の末尾で行われ、呼び出し元は見つからない見込み）。

## 2026-10-12 ブランチをmainに統合

`claude/review-lifecycle`の未マージ分（アイコン2コミット）をmainに取り込んだ（`templates/desktop/README.md`の衝突は両方の記述を残した）。`claude/trust-boundary-rules`、`tauri-scaffold-remaining`、`claude/dependency-graph`はmainに含まれていた。検証: macOSで`npm ci`・`npm run build`、`npm test`が73 pass・10 skip・fail 0、`playwright@1.56.0`（`--no-save`）とChromium 149で`INLOOP_UI_E2E=1 npm test`が全83件pass。この環境ではSSHの鍵が使えず、GitHubとのやり取りはhttps（`gh`の認証）で行った。

## 2026-10-12 inloop.jsonのレイヤーと版の下限（ADR-0023）

- `inloop.json`に省略できる`layers`（`{id, files}`）と`minVersion`を足した。ファイルが最初に当たったレイヤーが依頼票の`layer`になる（それまで常に空）。`minVersion`が今のinloopより新しければ、`request_review`と`inloop check`が拒否する。向きの検査（`mayUse`）は作っていない。
- 次の一手の1番にあった「アイコンの生成」は、すでにmainにあった（`npm run icon`）ので、そちらは完了として外した。

検証: macOSで`npm run build && npm test`が75 pass・10 skip・fail 0（追加は2件）。UIは変えていないので`INLOOP_UI_E2E=1`は未実行。実際のクライアントでの表示は未検証。

## 2026-10-12 証拠（検査の実行結果）の取り込み（ADR-0024）

- `inloop.json`に省略できる`evidence`（`{id, kind, name, command}`）を足した。`inloop evidence run [<id>...]`がコマンドを実行し、`.inloop/evidence.json`に結果と作業ツリーの指紋を記録する。`request_review`は、結果が今の指紋とコマンドに合えば`pass`・`fail`、そうでなければ`missing`（名前に理由）を、すべての依頼票の`evidence`に入れる（`src/engine/evidence.ts`）。
- シンボルごとの結び付け、SQLの解析、証拠による承認の制限は作っていない。UIは変えていない（既存の証拠の表示のまま）。

検証: macOSで`npm test`が80 pass・10 skip・fail 0（追加は`test/evidence.test.mjs`の5件）。UIは変えていないので`INLOOP_UI_E2E=1`は未実行。実際のクライアントでの表示は未検証。

## 2026-10-12 証拠のシンボル単位の結び付け（ADR-0025）

- `evidence`の項目に省略できる`tests`（globの列）を足した。`tests`のある検査は、そのファイルの宣言の中と最上位の文が直接呼び出す・`new`するシンボルを集め（`testCoverage`）、依頼票の対象（指定したシンボルと変わったシンボル）を参照していなければ`missing`、一部なら名前に件数を足す（`bindEvidence`、`src/engine/evidence.ts`）。
- 間接の呼び出し、importだけの参照、SQLの解析は作っていない。inloop自身と雛形の`inloop.json`には`tests`を足していない。

検証: macOSで`npm test`が81 pass・10 skip・fail 0（追加は1件）。UIは変えていないので`INLOOP_UI_E2E=1`は未実行。実際のクライアントでの表示は未検証。

## 2026-10-12 SQLのテーブル解析（ADR-0026）

- 依頼票に省略できる`tables`（シンボル、テーブル、`read`・`write`・`schema`）を足した。並べた宣言の中の`.prepare(...)`・`.exec(...)`の文字列リテラルのSQLを、字句で読む（`src/engine/sql.ts`）。動的な`prepare`の引数は`unresolved`に出す。画面に「データベースのテーブル」を足した。
- 列、ORM、間接（SQLを実行する関数の呼び出し先）、テーブルを使った信頼境界ルールは作っていない。

検証: macOSで`npm test`が83 pass・10 skip・fail 0（追加は`test/sql.test.mjs`の2件）。画面を変えたが`INLOOP_UI_E2E=1`と画面写真は未確認。実際のクライアントでの表示は未検証。

## 2026-10-12 次の一手の1〜4番（ADR-0027、ADR-0028、ADR-0029）

- レイヤーの向き（ADR-0027）: `layers`に省略できる`mayUse`を足した。使う側のレイヤーの`mayUse`にないレイヤーを、変わった宣言（と最上位の文）が直接使うと、組み込みのルール`layer-direction`が当たり、必須の依頼になる（`inloop check`も同じ）。基点と作業ツリーの`layers`の両方で判定する。`inloop new`の雛形（サーバー、手元）の`inloop.json`に`layers`を足した（`test`・`db`・`http`・`web`）。
- テーブルでの信頼境界ルール（ADR-0028）: 当て方`{table, access?}`を足した。変わった宣言と、それが直接使う宣言のSQLのテーブルで当て、動的なSQLを含む単位にも当てて理由を問いに足す。列と2段以上の間接は作っていない。
- 行数の数え方（ADR-0029）: 畳んで見せるコード（変わっていない依存、再依頼で前回と同じシンボル）を、行数の上限に数えない（`reviewLines`、`src/engine/build.ts`）。
- 再依頼の差分（ADR-0029）: 再依頼の依頼票に`prior`（前の依頼のIDと、同じコードで指摘のないシンボル`same`）を足した。前の依頼に回答がない・保留がある・シンボルを指さない修正や質問がある場合は付けない。画面は`same`を畳み、「R13から変更なし」を出す。
- 次の一手のうち、「信頼境界ルールを実際のクライアントで使う」「依存の図を実際の依頼で使って上限の数え方を見直す」は、クライアントで人が使う作業なので未実施（数え方は第一候補を実装した）。

検証: macOSで`npm test`が96 pass・10 skip・fail 0（追加は`test/review-scope.test.mjs`の13件。`test/engine.test.mjs`の上限のテストは`reviewLines`を使うよう直した）。`playwright`のChromium headless shell 1228を`INLOOP_CHROMIUM`で指定して`INLOOP_UI_E2E=1 npm test`が全106件pass。ただし画面の見出し「から変更なし」と`prior.same`の畳み方は、固定データの画面では`prior`を作れず、e2eでは未検証。実際のクライアントでの表示も未検証。

## 2026-10-12 実際のクライアントでの信頼境界ルールの確認（次の一手の1番）

`inloop new`で作った試験用アプリ（リポジトリの外）に、レイヤー違反（`server/app.ts`が`web/`の関数を呼ぶ）、`audit_log`への書き込み、`inloop.json`の変更を仕込み、Claudeデスクトップアプリの中のClaude Code（ブラウザの経路）で、利用者が操作した。

- AIは依頼を5件出した（任意2件、エンジンが加えた必須3件: `inloop-config`、`layer-direction`、`audit-table`と`db-write`）。必須を省かず、作業の終わりに自分から`inloop check --range main`を動かした。承認前は終了コード1で、AIは「必須の依頼は会話から記録できない、画面で答えてほしい」と案内した。
- 画面に`レイヤーの向きに反する使い方: http→web`と、`tables`の`audit_log`の`write`・`schema`が出た。利用者は問いの文を「判断できる」とした。必須の1件を保留にすると、AIは再依頼か、理由を説明しての承認かを選ばせた。全件を承認すると`inloop check`が通った（3件`ok`）。
- 直したこと: UIの`使う`・`使われる`を`uses`・`used by`にした（利用者の希望、コードが英語のため）。必須の依頼の問いに含まれる改行が画面で潰れていたので、`white-space: pre-line`にした。
- 分かったこと: 値としての参照だけ（`String(App)`）は「使う」に数えず、`layer-direction`に当たらない。呼び出し・`new`・型・継承だけが対象で、ADR-0027は明記していないが、ADR-0020の`references`と同じ範囲。`inloop new`の雛形の`inloop.json`には`table`の当て方がない。試験用アプリで`npm install`をしていないと、`node:sqlite`の型が引けず、`db.exec`・`db.prepare`が未解決の参照に出る（`npm install`後は消えた。テーブルの解析は影響を受けなかった）。
- 未確認: 必須の系列への`follows`での再依頼（枝番の`R4-1`）。利用者は承認で終えた。

検証: macOSで`npm test`が96 pass・10 skip・fail 0。`INLOOP_UI_E2E=1`は未実行。

## 2026-10-12 SQLの間接（ADR-0030）

- `tables`に省略できる`via`を足し、並べていない宣言のSQLを、呼び出し・`new`で2段まで（`INDIRECT_DEPTH`、`src/engine/sql.ts`）たどって出す。並べた宣言で止まる。たどった宣言の動的なSQL・未解決の参照は`unresolved`に足す。画面は`（a → b 経由）`を付ける。`table`の当て方も、対象が直接使う宣言から2段先までのSQLに当てる。
- SQLの列は作っていない（次の一手の2番の後半として残す）。

## 2026-10-12 雛形の`inloop.json`に`table`のルール

- 雛形（server・desktop）に`db-schema`を足した。テーブルや列の追加・削除・変更（`CREATE`・`DROP`・`ALTER`）に必須の依頼を出す。動的なSQLを含む単位にも当たる（ADR-0028）。特定のテーブル・列のルールの書き方（`table`・`access`・`columns`）は、雛形のAGENTS.mdに足した。`npm test`で形を確かめる。雛形のコピーのリポジトリで、`ALTER TABLE`を足すと`db-schema`が当たることを`inloop check`で確かめた（クライアントでの表示は未検証）。

## 2026-10-12 SQLの列（ADR-0031）

- `tables`に省略できる`columns`を足した（`src/engine/sql.ts`の`tablesOf`）。書く列はINSERTの列の並び・UPDATEのSET・DO UPDATE、読む列は別名の結び付けと、読むテーブルが1つのときの列。決められないものは`*`。`;`で文を分けて読む。`table`の当て方に`columns`（glob）を足し、`*`とスキーマの変更にも当てる。画面は`（列, ...）`を出す。
- 暗黙の別名・`ORDER BY`の別名を列として数える、`WHERE`の列を出さない、スキーマの列を読まない（ADR-0031の影響）。
- Claude Code（デスクトップ）の実利用で確かめた（2026-10-12、雛形のメモアプリ`inloop-demo`、利用者の画面写真）: `columns`の表示（読む`notes(body, created_at, id)`・書く`notes(body, created_at)`）、`SELECT *`が`全列または不明`と出て`notes-body`が当たること、列指定のSELECTでも同じシンボルが`body`を書くので`notes-body`が付くこと（シンボル単位）。`follows`の再依頼で、前の依頼が承認なら`Note`・`Db`に「R5-1から変更なし」が付いて畳まれる。前の依頼が保留（R5）だと畳まれない（ADR-0029の仕様どおり。保留のあとも畳むかは未決）。行単位の差分が要るかは、利用者の感想待ち。
- 検証: `npm test`で全103件pass・skip 10。`INLOOP_UI_E2E=1 npm test`は、この環境にPlaywrightのブラウザがなく実行できなかった（未検証）。画面の変更は1行。実際のクライアントでの表示は未検証。

検証: macOSで`npm test`が98 pass・10 skip・fail 0（追加は2件）。画面を変えたが`INLOOP_UI_E2E=1`と画面写真は未確認。大きなリポジトリでの時間、実際のクライアントでの表示は未検証。

## 2026-10-12 次の一手の1・3・4番の自動で閉じられる部分

- 再依頼の画面の「R1から変更なし」と畳み方を、実リポジトリを対象にしたe2eで確認した（`test/ui.e2e.test.mjs`。前回の指摘のシンボルは開き、同じコードで指摘のなかったシンボルは畳んで押せば開く）。固定データの画面では`prior`を作れないため未検証だった部分。
- 承認済みの必須の依頼への`follows`の再依頼が、必須のまま`prior`を付けることを自動テストで確認した（`test/boundaries.test.mjs`）。
- 直したこと: `使う:`を`uses:`にした変更で古くなっていたe2eの期待値2件（依存の図、呼び出し元）を直した。
- 次の一手の1番の雛形の`table`の当て方は、足さないと決めた（`db-schema`と、AGENTS.mdの書き方で足りる）。
- 人の確認が要る項目（手順は「次の一手」の下）: 実際の依頼での依存の図と上限の見直し、「から変更なし」の使い心地と行単位の差分の要否、保留のあとも畳むか、必須の系列への`follows`の画面。未実施。

検証: macOSで`npm test`が105 pass・11 skip・fail 0。`INLOOP_UI_E2E=1`（`playwright@1.56.0`を`--no-save`、Chromium headless shell 1228）で全116件pass。実際のクライアントでの表示は未検証。

## 2026-10-12 人の確認の途中結果（Claude Code、`inloop-demo`、利用者の発言と`reviews.jsonl`を根拠）

- 依頼は別タブではなく会話内の埋め込みで出た。利用者は、これを望む動作とした（別画面のブラウザでなくてよい）。依存の図は問題なし。図の箱を押すと畳まれたコードが開き、そこまでスクロールした。利用者は、このコード量なら行数・依存・図の量はこのままでよいとした（3番。大きな依頼では未確認）。
- 行クリックで入力欄に入った位置に、そのままコメントを続けたいという要望があり、位置の後ろに空白を1つ足した（`src/ui/main.ts`の`copyText`。クリップボードには足さない）。e2eの期待値も直した。Claude Desktop・Claude Codeの実機では未確認。
- 修正はチャットで伝えたため、R11には回答が記録されず、R11-1に`prior`が付かなかった（`reviews.jsonl`で確認。ADR-0029は、前の依頼に回答がないと`prior`を付けない）。そのため「R11から変更なし」は画面に出なかった。ADR-0032以降、修正を会話で伝える流れでは、`prior`が付く場面がほとんどない。利用者の選択で、回答がなくても同じコードを畳むようにした（ADR-0033）。実クライアントでの表示は未確認。
- R11-1に保留を押した（11:23:48）。保留のあとの再依頼（R11-2）が畳まれないことの確認は未実施。
- 保留のあとの再依頼R11-2は`prior`が付かず（`reviews.jsonl`）、仕様どおり。利用者が見た`Db`の畳みは、`prior`ではなく「変わっていない依存は既定で畳む」（ADR-0020）によるもので、保留のあとの`prior`の使い心地の判断材料にはならない。
- 必須の再依頼の確認（1番）は未実施。原因: `inloop-demo`の`inloop.json`は`db-schema`の追加前に作られていて、`ALTER`を足しても必須の依頼が出ない。雛形の`db-schema`を足してから確認する。
- 利用者の案（実装した、ADR-0034）: コードの表示を3段にする（畳む、変更行の前後、対象ファイル全体をその場で開く。行番号つきのコメントのため）。静的解析で無関係と言い切れる範囲を絞る必要はなく（言い切れないものは未解決とする原則）、全体表示は閲覧の補助で構造を足さない。位置の指定（`シンボル#行`）がシンボルの外の行に届くかは未検討。


- 3段目（ファイル全体、ADR-0034）を実装した。見出しの「ファイル全体」で開き、行クリックで`ファイル名#L行`の位置を入れる。実機で確認済み（下の記録）。
- 必須の再依頼の確認（1番、`inloop-demo`の`reviews.jsonl`を根拠）: `inloop-config`の必須R2-1と、`db-schema`・`db-write`・`notes-body`・`secrets`の必須R14-1→R14-2（再依頼）が、必須のまま`prior`（`R14-1`の`server/db.ts#Db`）を付けて出て、承認された。利用者の発言では、AIは`inloop check`を動かした。私が手元で動かした`inloop check`は、デモの別の未承認の必須（R15、R3-7）が残るため通らなかった。この確認で見る範囲（再依頼の必須の系列）は成功。
- 保留のあとの`prior`と、行単位の差分は、利用者の判断待ちのまま（今のところ困っていない）。

- 3段目の実機確認で「ファイル全体」が出なかった（利用者の発言、2026-10-12）。原因: 操作を同じファイルの最初のシンボル（変わっていない依存`Note`で、畳まれている）にだけ付けていたため。畳まれていない最初のシンボルに付けるよう直し、e2eに畳まれた依存が先頭にある場合を足した。ADR-0034の「同じファイルの最初のシンボルにだけ出す」は「コードが開いている最初のシンボルにだけ出す」が実際の動き（結論の変更ではなく、記述の訂正）。実機の確認は再度必要。

- 3段目の実機確認の結果（利用者の発言、2026-10-12）: Claude Desktopを再起動しないと新しい版にならなかった（新しい会話だけでは足りない）。「ファイル全体」が1ファイルの最初の差分にしか出ないので、差分ごとに出すよう直した（開閉はシンボルごと）。位置の後ろの空白も改行も、ホストに削られた。指示（importの行の位置）はAIに通じた。
- 呼び出し元からは「ファイル全体」が開けなかった（利用者の発言）。開けるよう直し、位置の末尾を「:」にして、会話に入れたときのクリップボードへの複写をやめた（ADR-0035）。実機の確認は未実施。
- 実機の確認結果（利用者の発言、2026-10-12、Claude Desktop）: 位置の末尾の「:」、会話に入れたときにクリップボードへ写さないこと、呼び出し元の「ファイル全体」は、すべてOK（ADR-0035）。差分ごとのファイル全体（ADR-0034）は、前の確認で「呼び出し元だけ出ない」以外はOKだったので、これで全部確認済み。

## 2026-10-12 handoffの分割と主なクライアントの変更（ADR-0037）

- handoffが516行になったので、経緯（このファイル）、クライアント検証の結果、既知の制約、未決の方向性を別の文書に分け、handoffを現在地・次の一手・未検証事項だけの50行にした。内容は移しただけで書き換えていない（見出しの階層だけ変えた）。「決まっていること」の節は、ADR一覧と重なるので載せていない（消した内容はgitの履歴にある）。
- 利用者の方針（2026-10-12）で、主なクライアントをClaude Code（デスクトップ）にし、他のクライアント・ミドルウェア・OSは後回しにした（ADR-0037、ADR-0006をSupersedes）。PostgreSQLの雛形とSQL解析は、ブランチ`claude/postgres-template`に未マージで保管した（PR 18は閉じた）。
- 検証（macOS）: `npm test`が106 pass・13 skip・fail 0。コードは変えていないので、UIの`INLOOP_UI_E2E=1`は動かしていない。

## 2026-10-12 scaffoldの生成と雛形の見た目（ADR-0038）

- `inloop generate scaffold <名前> <列>...`（`src/scaffold.ts`）。表（`server/db.ts`）、API（`server/routes/`）、テスト、画面（`web/src/pages/`）を生成し、目印の行（`// inloop:tables`など）の直前に追記する。雛形に共通のCSS・メニューつきの画面の枠・目印を入れ、メモは`pages/Notes.tsx`に移した。`vite-env.d.ts`を足した（CSSのimportの型検査のため）。
- 検証（macOS）: `npm test`が110 pass・14 skip・fail 0。`INLOOP_APP_E2E=1`で、生成したアプリの`npm install`、`npm test`（8 pass、`task`と`category`を生成した後）、`npm run build`が通った。生成したAPIの`buildPackets`で、`tasks`の読みと書き（列つき）が出て、動的なSQLの未解決がない。ブラウザ（ダークテーマ）で、一覧・追加・編集の表示と操作を確かめた。UIのe2e（`INLOOP_UI_E2E=1`）は、inloopの画面は変えていないので動かしていない。
- 気づき: zshでは`due:date?`が展開されて失敗するので、省略できる列は`:optional`にした。
- 未検証: 実際のClaude Codeの会話での使用、ライトテーマ・狭い画面・`--desktop`のアプリでの表示。

## 2026-10-12 端末内で動く構成`--standalone`（ADR-0039）

- 利用者の方針（2026-10-12）: 作ったアプリを、デスクトップ・iPhone・Android・Chrome拡張で、サーバーなしで使いたい。iOSは自作アプリの署名が7日で失効するため、PWAにする。Tauriのモバイルはsidecarが使えず、ADR-0019の構成が成り立たない。
- 使い捨ての検証（Hono＋sqlite-wasm＋OPFS）: アプリ内ブラウザで保存と再読み込みの持続、iOS 16.0のシミュレーターではOPFSが使えずメモリに切り替わる（`The local OPFS API is too old`）、iPhone実機（iOS 26.6.2）はClaude Artifactの検証ページで`opfs-sahpool`（利用者のスクリーンショット）。持続は利用者の報告。
- 実装: `templates/standalone/`（`server/sqlite-wasm.ts`、`server/worker.ts`、`server/db.ts`、`web/src/local-api.ts`、`offline.ts`、`web/public/sw.js`など）と、`inloop new --standalone`（`src/cli.ts`）。`node:sqlite`を`vite.config.ts`のaliasで差し替えるので、`server/`のコードとscaffold、Node.jsのテストは変わらない。
- 検証（macOS）: 生成したアプリで`inloop generate scaffold`、`npm test`（5 pass）、`npm run build`が通った。Chrome for Testingで、APIの作成と一覧、再読み込みでデータが残ること、サービスワーカーの登録、オフラインで開き直してもデータが読めることを確認した（アプリ内ブラウザはサービスワーカーを登録できず、検証には使えなかった）。
- 気づき: iOSシミュレーターの起動で、Macの`SafariBookmarksSyncAgent`が落ちるダイアログが出た。シミュレーターは終了した。
- 実機の確認（利用者の発言、2026-10-12）: `inloop new memo --standalone`で作ったアプリを、Cloudflare Pages（無料、`wrangler pages deploy dist/web --project-name memo --branch production`）に置き、iPhone（iOS 26.6.2）のホーム画面に「Webアプリとして開く」で追加。メモの保存、終了後の再起動での保持、機内モードでの表示と追加ができた。Safariのタブとホーム画面のアプリは保存領域が別。
- 気づき: `--branch`を付けないと、gitにcommitがないためプレビュー扱いのURLになる。固定のURL（`<プロジェクト>.pages.dev`）に出すには`--branch production`。URLが変わると保存領域も別になる。保存領域を開けないことに気づけるよう、画面の下に保存先の状態を出すようにした（`web/src/local-api.ts`）。
- 更新通知（`web/src/offline.ts`、`vite.config.ts`の`build-id`、`web/public/sw.js`）: ビルドごとの識別子を`version.txt`に出し、開いたときと画面に戻ったときに置き場所の値と見比べ、違えば「更新」を出す。押すとキャッシュを捨てて読み込み直す。Chromiumで、版を上げて再ビルドすると表示が出て、押すと消えることを確認（実機は未確認）。
- 機能カタログのデモアプリ（`~/work/catalog`、雛形の外。Cloudflare Pagesの`catalog`）: PWAで使える31の機能（SQLite、保存容量、ファイル、通知、バッジ、センサー、カメラ、マイク、読み上げ、共有、パスキーなど）を試す画面と、試した結果をSQLiteに残す履歴（`inloop generate scaffold trial`で生成）。Chromium（狭い画面）で、12の機能の実行と履歴の保存を確認。カメラ・マイク・通知・センサーなどの実機での動作は未確認。
- 気づき: `wrangler pages project create`は、`package.json`にHonoがあると別の自動設定に回って失敗する。空のディレクトリで`--force`を付けて作る（初回だけ）。

