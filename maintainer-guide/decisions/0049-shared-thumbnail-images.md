# ADR-0049: 画像は端末の中で縮小し、データURLとしてtext列に入れて、いまの同期に載せる

- 状態: Proposed
- 日付: 2026-10-14
- Supersedes: なし（ADR-0040の中継の1行の上限と、ADR-0038の列の型の一覧に、足すだけ）

## 背景

利用者は、画像つきの買い物リストを端末内（iPhoneのPWA）で使い、共有もしたい（2026-10-14）。調べると、次の点で作れなかった。

- `inloop generate scaffold`の列の型に画像がない（`text`・`int`・`real`・`bool`・`date`）。
- 中継（ADR-0040）が受け付ける1行は4096文字までで、画像は共有に載らない。
- データの書き出し（ADR-0043）は、バイナリの行を拒否する。

## 決定

- 案A（小さい画像だけ、いまの同期に載せる）を採る。大きい画像の共有（R2など）は、この決定に含めない。
- 列の型`image`を足す（`inloop generate scaffold photo:image:optional`）。値は、縮小した画像のデータURL（`data:image/webp|jpeg|png;base64,…`）で、SQLiteでは`TEXT`列に入る。BLOBは使わない。
- 縮小は端末の中で行う（`web/src/image.ts`の`shrinkImage`、画像の列があるアプリにscaffoldが1回だけ作る）。長辺320pxのWebPから始め、使えない端末（iOS Safariは`toDataURL("image/webp")`でPNGを返す）はJPEGにし、36000文字に収まるまで画質と大きさを下げる。元の画像は保存しない。
- 生成するAPIは、`isImage`（WebP・JPEG・PNGのデータURLで、36000文字以内）で検証する。共有のアプリでは、`sync-tables.ts`に`text`、`max: 36000`で登録する。
- 中継の1行の上限`blobChars`を4096から56000にする。1通の上限（64KiB、`index.ts`）と、暗号化したblobの膨らみ（base64で4/3倍）に収まる大きさ。
- 参加時（`hello`）に最新の行を送るとき、blobの文字数の合計が約512KiBを超えたら通を分ける。最後の1通だけが全体の最新の`seq`を持つ。
- 「データ」画面に、保存領域の使用量（`navigator.storage.estimate()`）と、ブラウザに消されにくくする要求（`navigator.storage.persist()`）を足す。

## 理由

- 買い物リストは、一覧で見分けられる程度の縮小版で足りる。1枚あたり10〜30KBほどで、数百枚が無料枠に収まる見込み。
- 画像をtext列に入れれば、書き出し・読み込み（ADR-0043）と同期（ADR-0040）の仕組みを、そのまま使える。新しいサーバーも費用も要らない。中継は、これまでどおり内容を読めない。
- 元の画像を保存しないので、保存領域の使い方が読める。

## 影響

- 当初は画像を別の表の行にする案だったが、列にした（既存の仕組みに乗せる最小の変更のため）。一覧の取得ごとに画像のデータも読む。
- 中継の1行が最大約56KBになり、無料枠（Durable ObjectsのSQLite）の消費が増える。部屋の行数の上限（5000）はそのまま。画像の行が多い部屋は、参加時の通信量が増える（約512KiBずつに分けて送る）。
- 元の解像度の画像は残らない。大きい画像の共有は別の決定になる。
- 中継の上限を変えるので、既存の中継は再デプロイするまで古い上限（4096文字）のままで、画像の行を断る。端末側（アプリ）だけ新しくしても、共有には載らない。
- `server/sync/engine.ts`の列の検証は、`text`の`max`で足りるので変えていない。

## 却下した代替案

- Cloudflare R2に暗号化した画像を置く（案B）: 実装と信頼境界のレビューが重く、支払い方法の登録が要る見込み。必要になったら別のADRで決める。
- SQLiteのBLOB列＋バイナリ対応の書き出し: 書き出し・同期の両方を変える必要があり、縮小したデータURLで足りる。
- 画像を何行にも分けて中継に載せる: 行の整合（一部だけ届く）の扱いが増える。

## 検証

確かめた（2026-10-14、Linux、Node.js 22）:

- `npm test`（このリポジトリ）: 画像の列の生成物（`isImage`、`shrinkImage`の取り込み、`image.ts`、`sync-tables.ts`の`max`）と、画像の列がない資源には何も足さないこと。
- `INLOOP_APP_E2E=1`: `photo:image:optional`を含む資源を生成した、通常のアプリと`--sync`のアプリで、`npm install`、`npm test`（中継の上限いっぱいの行の受け付け、分割して送ること、を含む）、`npm run build`、`npm run build:extension`が通る。
- Chromium（Playwright）で、3000×2000のPNG（約134KB）を`shrinkImage`に通すと、WebPのデータURL（約11.6千文字）になる。画像でないファイルは断る。

未検証:

- iPhone実機（Safariで`image/webp`の書き出しがJPEGに切り替わること、写真アプリからの選択、向きの補正）。
- 2台の端末での画像の同期。本物の中継（Cloudflare Workers）での上限と、再デプロイ。
- `persist()`が、iOSのホーム画面のPWAで許可されること。実際の保存領域の上限と、自動削除の条件（ADR-0039の未検証のまま）。
- 数百枚の画像のある部屋での、参加時の時間と無料枠の消費。

## 関連資料

- [ADR-0038](0038-scaffold-generator.md)
- [ADR-0039](0039-standalone-in-browser-runtime.md)
- [ADR-0040](0040-e2e-encrypted-sync-relay.md)
- [ADR-0043](0043-backup-export-import.md)
