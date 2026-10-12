# ADR-0039: サーバーなしで端末内で動く構成（`--standalone`）を足す

- 状態: Accepted
- 日付: 2026-10-12
- Supersedes: ADR-0011の却下した代替案「Tauriの画面の中でHonoを動かす」の部分だけ（端末内で動く構成を、別の選択肢として採る。標準の構成と`--desktop`は変えない）

## 背景

利用者は、思いついたアプリ（公私とも）をinloopで作り、デスクトップ、iPhone、Android、Chrome拡張のどれでも、サーバーを置かずに単体で使えるようにしたい（2026-10-12）。主な制約は次のとおり。

- Tauri 2はモバイルをビルドできるが、sidecar（外部プロセスの起動）が使えない。ADR-0019の「Node SEAにまとめたHonoを同梱」は、iOS・Androidでは成り立たない。
- iOSは、無料のApple IDで自作アプリを入れると7日で失効する。署名の期間を延ばすには有料のDeveloper Programが要る。ネイティブアプリの形は、「入れっぱなし」にしにくい。
- ADR-0011は、「画面の中でHonoを動かす」案を、SQLite接続の書き換えと、画面とサーバーの境目が消えることを理由に却下した。

## 決定

- `inloop new <dir> --standalone`を足す。標準の構成（サーバー向け、`--desktop`）は変えない。`--desktop`とは同時に指定できない。
- 構成: 画面（React、Vite）と、サーバー（Hono）を別のコードのまま残し、HonoはWeb Worker（`server/worker.ts`）の中で動かす。画面の`fetch("/api/...")`は、`web/src/local-api.ts`が差し替えてWorkerの`app.fetch`に渡す（ネットワークには出ない）。`/api`以外の`fetch`はそのまま通る。
- データベース: `server/`のコードは`node:sqlite`の使い方（`exec`、`prepare`の`all`・`get`・`run`）で書く。ブラウザ向けのビルドでは、`vite.config.ts`が`node:sqlite`を`server/sqlite-wasm.ts`（sqlite-wasm、OPFSのSAH poolに保存）に差し替える。テストは今までどおりNode.jsの`node:sqlite`で動く。保存領域を開けないときは、メモリ上のDBに黙って切り替えず、エラーにする。
- `server/db.ts`は`node:fs`・`process.env`に触れず、`openDb(path)`は`new DatabaseSync(path)`と表の作成だけにする。`inloop generate scaffold`の目印（`// inloop:tables`など）はそのまま使える。
- 配り方: `npm run build`の出力（`dist/web`、静的ファイル、約1.1MB）を、HTTPSの静的な置き場所（Cloudflare Pages、Tailscale Serveなど）に置き、PWAとして端末に入れる（`manifest.webmanifest`、`sw.js`、`offline.ts`で、読み込み済みのファイルをキャッシュしてオフラインで開く）。Chrome拡張とTauriのモバイルの外枠は、この構成の別の入れ物として、あとから足す（この決定には含めない）。
- 信頼境界ルールの雛形（`templates/standalone/inloop.json`）は、サーバー向けの雛形に、`offline-cache`（サービスワーカー）と`local-worker`（画面とWorkerの受け渡し、保存先）を足す。

## 理由

- iOSでは、署名の期限がなく、ホーム画面に追加すれば入れっぱなしにできるのは、PWAだけである。
- 画面とサーバーのコードを分けたまま、渡し方だけを差し替えるので、層の境目と信頼境界ルールは、サーバー向けの雛形と同じに当たる。ADR-0011の却下理由のうち、「境目が消える」は、渡し方の差し替えだけで避けられる。「SQLite接続の書き換え」は、`node:sqlite`の薄い差し替えで、アプリのコードに及ばない。
- `node:sqlite`の使い方をそのまま残せば、`inloop generate scaffold`が作るコードとテストが、そのまま使える。

## 影響

- 保存先がその端末のブラウザの中だけになる。ブラウザのデータを消すと失われ、端末どうしでは同期しない。書き出し・読み込みの仕組みは、まだない。
- OPFSのSAH poolは、同時に1つのWorkerしか開けない。同じアプリを複数のタブで開くと、2つ目は保存できずエラーになる。
- iOS 16.4より前は、OPFSの同期ハンドルがなく、保存できない（シミュレーターのiOS 16.0で確認、エラーになる）。
- `server/`のコードで、`DatabaseSync`のうち`exec`・`prepare`の`all`・`get`・`run`以外を使うときは、`server/sqlite-wasm.ts`に足す必要がある。
- ブラウザの`fetch`で`/api`以外を呼ぶと、インターネットに出る。外部通信の宛先は、レビューの対象にする（雛形のAGENTS.mdに書いた）。
- サービスワーカーが古い版を返し続けないよう、裏で更新する方式（stale-while-revalidate）にした。更新は、次に開いたときに反映される。

## 却下した代替案

- Tauriのモバイル（iOS）で配る: sidecarが使えず、署名の期限（無料は7日）の問題が残る。
- サーバーを別に置き、画面だけを端末で開く: 利用者の前提（スタンドアロン）と合わない。
- アプリ側のコードを、非同期のDB APIに書き換える: scaffoldとテストの形が変わり、レビューの負担が増える。

## 検証

確かめた（2026-10-12）:

- `npm test`（このリポジトリ）で、`--standalone`で作った雛形の中身と、`--desktop`との併用の拒否を確かめる。
- `INLOOP_APP_E2E=1`相当の手動確認（macOS、Node.js 22.18.0）: `inloop new --standalone`で作ったアプリで、`npm install`、`inloop generate scaffold task title:text done:bool`、`npm test`（5 pass）、`npm run build`（警告なし）が通った。
- Chromium（Chrome for Testing）で、`npm run preview`の画面から、メモとタスクのAPI（作成と一覧）が端末内のHonoとsqlite-wasmで動き、ページを開き直してもデータが残り、サービスワーカーが登録され、オフラインで開き直してもデータが読めた。
- iPhone実機（iOS 26.6.2）で、使い捨ての検証ページ（Claude Artifact内）で、`vfs: opfs-sahpool`となることを利用者が確認し、メモを追加して開き直しても残ったと利用者が報告した（スクリーンショットは、`opfs-sahpool`の表示まで）。

未検証:

- 生成したアプリを、iPhoneのホーム画面に追加して使うこと（PWAとして、オフラインを含む）。Android。Chrome拡張（MV3）でのWASMとOPFS。
- scaffoldで作った画面のブラウザ上の操作（フォーム、一覧の表示）。APIは確かめた。
- 複数のタブ、容量の上限、ブラウザのデータが自動で消される条件（iOSの7日の自動削除が、ホーム画面に追加したPWAに及ばないことを含む）。

## 関連資料

- [ADR-0011](0011-inloop-command-and-app-templates.md)
- [ADR-0019](0019-desktop-template-node-sea-sidecar.md)
- [ADR-0038](0038-scaffold-generator.md)
