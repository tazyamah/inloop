# ADR-0045: IPAの注意喚起から導いたセキュアコードの規則を、`inloop lint`で検査し、違反するとテスト・ビルド・マージ・生成を失敗させる

- 状態: Accepted
- 日付: 2026-10-13
- Supersedes: なし（ADR-0022の必須の依頼とは別の仕組みを足す。ADR-0022の結論は変えない。docs/iteration.mdの「書けない構造」を、構文で決まる範囲で実装する）

## 背景

利用者の問い: 「セキュアなコードだけしか書けなくする機能が予定されていたのでは」。確認した結果は次のとおり。

- 予定はあった。docs/iteration.mdの「0. 土台づくり」に「書けない構造: 生のSQLの禁止、秘密情報の取得経路の限定などを、リンターやフレームワークで強制する」とあり、フェーズ4の機械検証（Semgrepなど）は「inloopから独立したツールに任せる」とされていた。
- 実装はなかった。ADR-0001〜0044のうち、ADR-0022（信頼境界ルール）とADR-0027（レイヤーの向き）は、違反を**書けなくする**のではなく、人のレビューを**必須にする**仕組みで、`inloop new`の雛形にもリンターや禁止規則はなかった。

IPAの注意喚起（2026-10-09、`alert20261009`）は、不正アクセスによる漏えいが続いたことを受けた、経営者向けの点検と対策の要請である。コードの書き方の規則そのものは書かれておらず、「安全なウェブサイトの作り方」も本文では推奨されていない（ナビゲーションにあるだけ）。そのため、文書が挙げる対策のうち、アプリのコードで機械的に検査できるものを導いた。

| 文書の対策 | 導いた規則 |
|---|---|
| 外部公開範囲の見直し | `sec-bind`（待ち受けをloopbackに限る）、`sec-cors`（許可元を`*`にしない） |
| 認証機能の強化 | `sec-secret`（認証情報をコードに書かない）、`sec-crypto`（弱いハッシュ・パスワードをただのハッシュにかけない・予測できる乱数）、`sec-cookie`（http-onlyとsameSite） |
| ログの取得内容の見直し | `sec-log`（秘密情報・環境変数をログに出さない） |
| データの暗号化 | `sec-crypto`（弱い暗号方式）、`sec-tls`（証明書の検証を無効にしない）、`sec-cleartext`（外部との通信は暗号化） |
| 外部公開アプリケーションの精査（外部入力、内部情報） | `sec-sql-literal`、`sec-shell`、`sec-eval`、`sec-html`、`sec-stack` |
| 追加実装可能なセキュリティ対策、構成要素単位の管理 | `sec-unchecked`（検査から漏れるファイルを許さない）、`secure-gate`（検査を外す変更と依存の追加を必須の依頼にする） |

運用の点検（ログの確認、アカウントの棚卸し、パッチ適用など）と、多要素認証、データを持つ必要性の再検討、保管場所は、コードの構文では決まらないので対象にしない。

## 決定

### 検査

- `inloop lint [--repo <dir>]`を足す。リポジトリの`tsconfig.json`（直下と、`relay/`のような下の階層のもの）が含むTypeScriptのファイルを、構文木で検査し、規則に反するものを`規則id<TAB>ファイル:行<TAB>内容<TAB>→ 直し方`の1行ずつで出す。1件でもあれば終了コード1。型の解決はしない（importは同じファイルの宣言で追う）。同じコードからは同じ結果になる（ADR-0002）。
- 規則は14（上の表）。`sec-unchecked`は、どの`tsconfig.json`にも入っていない`.ts`・`.tsx`を違反にする（検査から漏れる穴を塞ぐ）。`.js`・`.mjs`は検査しない。
- テストのファイル（`*.test.*`、`test/`）では、`sec-secret`の名前による判定と`sec-cleartext`を適用しない。鍵の本体の形（`AKIA…`、`-----BEGIN … PRIVATE KEY-----`など）は、テストでも違反にする。
- コメントなどで違反を無効にする書き方は作らない。

### 例外

- `inloop.json`に省略できる`secure`を足す: `{"allow": [{"rule": "<規則id>", "files": ["<glob>"], "reason": "<10文字以上の理由>"}]}`。`format`は1のまま。知らない規則id、理由のない例外は拒否する。
- `inloop.json`の変更は、ADR-0022の組み込みのルール`inloop-config`で必須の依頼になるので、AIが自分で例外を足しても、人が理由を確かめるまでは`inloop check`が通らない。例外は作業ツリーの`inloop.json`のものを使う（基点とは合わせない）。

### 失敗させる場所

- `inloop check`: 必須の依頼の確認に加えて、同じ検査を動かし、違反があれば失敗する。マージの条件（ADR-0001）に含まれる。
- 雛形の`npm test`と`npm run build`（`build:extension`を含む）の最初に`inloop lint`を動かす。サーバー向け、`--desktop`、`--standalone`、`--sync`のすべて。
- `inloop generate scaffold`は、書いたあとに検査し、違反があれば終了コード1にする。
- 雛形の`inloop.json`に`secure-gate`（`**/package.json`、`**/tsconfig.json`に当たる`files`のルール）を足す。検査を`scripts`から外す、`include`を狭める、依存を足す変更が、必須の依頼になる。
- 雛形のAGENTS.mdに、規則の一覧と例外の書き方を足す。AIが書く前に知るため。
- 雛形の`inloop.json`の`secure.allow`には、標準のコードの中で規則に当たるが、問題のないものだけを、理由つきで入れた: `--standalone`・`--sync`の`server/backup.ts`（実在する表・列と突き合わせて引用した識別子を組み立てる）、`server/sqlite-wasm.ts`・`relay/src/index.ts`・`server/sync/sync.test.ts`（SQLの文字列を受け渡すだけの層）、`server/worker.ts`（Worker内の仮のURL）。

## 理由

- 構文で決まるものだけを対象にしたのは、同じ入力から同じ結果になり（ADR-0002）、AIの判断を挟まないためである。「書けない」は、書いた時点ではなく、テスト・ビルド・マージ・生成の段階で落とすことで実現する。エディタで書くこと自体は止められない。
- inloop本体に実装したのは、アプリのリポジトリに検査器をコピーすると、AIが書き換えられるからである。アプリに残るのは`package.json`の呼び出しだけで、その変更は`secure-gate`で必須の依頼になる。`inloop check`が`package.json`によらず同じ検査を動かすので、呼び出しを外しても、マージの前に落ちる。
- 例外を`inloop.json`に置くのは、既存の必須の依頼の仕組み（`inloop-config`）で人の確認に乗せるためで、新しい承認の仕組みを作らない。
- ADR-0022と別の仕組みにしたのは、信頼境界ルールは「人が見る」、この検査は「そもそも書かせない」と、目的が違うからである。両方に当たるコード（外部コマンドなど）は、検査に通るものだけが、人のレビューに進む。
- SemgrepやCodeQLなどに任せる方針（docs/iteration.md）は変えない。それらは`evidence`（ADR-0024）で結果を取り込める。この検査は、依存なしで雛形に最初から入れられる最低限の規則で、それらの代わりではない。

## 影響

- `inloop`コマンドが`PATH`にある環境でだけ、雛形の`npm test`・`npm run build`が動く（`inloop mcp`と同じ前提）。ない環境のCIでは、`inloop`を入れるか、`scripts`を書き換える必要がある（書き換えは`secure-gate`の対象）。
- 既存のアプリは、`package.json`に呼び出しがないので、自動では変わらない。`inloop check`は検査を動かすので、既存のアプリで違反があれば失敗するようになる。
- 規則の追加・変更は、検査の厳しさを変えるので、このADRの更新（新しいADR）で行う。

## 却下した代替案

- ESLint・Semgrepを雛形に入れる: 依存が増え、規則の置き場所がアプリ側になって、AIが書き換えられる。結果の取り込みは`evidence`でできる。
- 検査器の複製を雛形に置く: AIが書き換えられる。
- コメントで違反を無効にする: AIが自分で足せ、人の確認に乗らない。
- 違反を必須の依頼にする（ADR-0022の延長）: 人の注意を使わずに落とせるものは、落とすほうが確実である。
- IPAの運用の点検（ログ、アカウント、パッチ）まで検査にする: コードから決まらない。

## 検証

`npm test`の`test/secure.test.mjs`で次を確かめる。

- 14の規則それぞれが、違反する例を見つけ、似ていて問題のない例を見つけないこと
- テストのファイルでの扱い、`tsconfig.json`に入らないファイル、下の階層の`tsconfig.json`
- `secure.allow`が、規則とファイルが合うものだけを除くこと。形の不正を拒否すること
- `inloop lint`と`inloop check`が、違反で終了コード1になること
- 4種類の雛形が違反なしで、`package.json`の`test`・`build`が`inloop lint`で始まり、`secure-gate`とAGENTS.mdの規則があること
- `inloop generate scaffold`が、違反なしで成功し、違反のある状態では失敗すること

未検証: 実際のClaude Codeの会話で、AIが規則に反するコードを書いたときに、`npm test`の失敗から自力で直せるか。既存のアプリ（`~/work/shopping`など）での偽陽性。`INLOOP_APP_E2E=1`の生成アプリの`npm install`込みのテスト。

## 関連資料

- [ADR-0001](0001-push-review-requests.md)
- [ADR-0002](0002-deterministic-review-projection.md)
- [ADR-0022](0022-trust-boundary-rules.md)
- [ADR-0024](0024-evidence-runs.md)
- [ADR-0038](0038-scaffold-generator.md)
- [docs/iteration.md](../../docs/iteration.md)
- [IPA 注意喚起 2026-10-09](https://www.ipa.go.jp/security/security-alert/2026/alert20261009.html)
