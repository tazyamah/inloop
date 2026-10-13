# ADR-0044: 端末内で動くアプリを、Chrome拡張としても出せるようにする

- 状態: Accepted
- 日付: 2026-10-13
- Supersedes: なし（ADR-0039、ADR-0041の雛形に足す）

## 背景

利用者は、作ったアプリを、Chrome拡張としても使いたい（2026-10-12、コストは高くないこと）。端末内で動く構成（ADR-0039）では、サーバーを使わず、Honoと画面がブラウザの中で動くので、同じコードを拡張のページとして出せる見込みがあった。

## 決定

- `--standalone`と`--sync`の雛形に、`npm run build:extension`（`vite build --mode extension`）を入れる。出力は`dist/extension`で、Chromeの「パッケージ化されていない拡張機能を読み込む」で使う。ストアへの公開は、この決定に含めない。
- `web/extension/manifest.json`（Manifest V3）: ポップアップ（`index.html?popup=1`、幅380px）とオプションページ（タブいっぱい）で、同じ画面を開く。`content_security_policy`に`'wasm-unsafe-eval'`を入れる（sqlite-wasmが要る。Manifest V3の既定には入っていない）。権限（`permissions`、`host_permissions`）は、何も要求しない。
- 拡張のIDは、アプリごとに決める。`inloop new`が、アプリごとにRSA鍵を作り、公開鍵を`manifest.json`の`key`に入れる（秘密鍵は要らないので、捨てる）。IDは、公開鍵のハッシュ（`a`〜`p`の32文字）。`--sync`の`relay/wrangler.jsonc`の`ALLOWED_ORIGINS`に、`chrome-extension://<ID>`を足す。
- 拡張のビルドでは、サービスワーカー（オフライン用）、更新通知、PWAの`manifest.webmanifest`を出さない（拡張のファイルは、端末に入っている）。中継のURLは、`web/.env.production`の`VITE_SYNC_URL`を使う。

## 理由

- 拡張のページは、アプリの配布物と同じ静的ファイルで、Workerもsqlite-wasmも動くので、画面とサーバーのコードを変えずに出せる。
- アプリごとにIDが決まるので、中継のオリジンの許可を、事前に決められる。

## 影響

- ポップアップは、閉じるとWorkerごと止まるので、共有の同期は、ポップアップかタブが開いている間だけ動く（常時の同期はしない）。
- 拡張のデータの保存領域は、Webアプリ（PWA）とは別なので、同じアプリを、拡張とPWAの両方で使うと、別々のデータになる（共有すれば同期できる）。
- 拡張を読み込む手順は、人が行う（Chromeの画面操作）。

## 却下した代替案

- 拡張のバックグラウンド（サービスワーカー）で、同期を動かす: Manifest V3のサービスワーカーは、すぐ止まり、OPFSの保存領域を、複数の場所から開くと衝突するので、今回は見送る。
- ストアへの公開: 審査と手続きが要るので、利用者が使いたくなったときに、別に決める。

## 検証

- 確かめた（2026-10-13、macOS）: 生成した`--sync`のアプリで`npm run build:extension`が通り、Chrome for Testingに拡張を読み込んで（ヘッドレス）、ポップアップのページで、保存先が「端末内に保存（OPFS）」になり、メモを足して、ページを開き直しても残ること、ローカルの中継（`wrangler dev`、拡張のオリジンだけを許可）に、拡張から共有を始めて「同期しています」になることを確認した。`'wasm-unsafe-eval'`がないと、WASMがCSPで断られる（確認済み）。
- 未検証: 実際のChromeへの読み込み（`chrome://extensions`の画面操作）。ポップアップの見た目（画面の大きさ）。Chromeの再起動後の保持。

## 関連資料

- [ADR-0039](0039-standalone-in-browser-runtime.md)
- [ADR-0041](0041-approval-based-sync.md)
