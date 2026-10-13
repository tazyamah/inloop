# __APP_NAME__

inloop で作った、端末の中だけで動き、少人数で共有もできるアプリです（画面: React、サーバー: Hono、データベース: SQLite）。
Honoは画面とは別のWeb Workerの中で動き、データはブラウザのOPFSに保存したSQLiteに残ります。共有は、小さな中継（`relay/`、Cloudflare Workers）を通して、端末どうしで変更を受け渡します。内容は暗号化されていて、中継は読めません。

```sh
npm install
npm run dev       # http://127.0.0.1:5173
npm test          # server/ のテスト（Node.jsで動かす）
npm run build     # 型検査と、dist/web への静的ファイルの出力
npm run preview   # 作った静的ファイルを 127.0.0.1 で確かめる
```

「データ」画面で、データをファイルに書き出し・読み込めます（端末を替えるときや、ブラウザのデータを消す前のバックアップ。共有の鍵は含まれません）。共有する表は、新しい変更を残して合わせ、読み込んだ行は、共有先にも送られます。

## 配る（無料）

画面（`dist/web`）と中継は、どちらもCloudflareの無料枠で動きます。

```sh
# 1. 中継を置く（初回だけ、`npx wrangler login` でCloudflareにログインする）
cd relay && npm install && npx wrangler deploy      # 表示されたURL（https://<名前>.<アカウント>.workers.dev）を控える
# 2. 画面のビルドに、中継のURLを入れる（https を wss に替える）
echo "VITE_SYNC_URL=wss://<名前>.<アカウント>.workers.dev" > web/.env.production
# 3. 画面を置く（--branch production を付ける。付けないとURLが毎回変わり、保存したデータが別のものになる）
npm run build && npx wrangler pages deploy dist/web --project-name <アプリ名> --branch production
# 4. 3で出た画面のURL（https://<アプリ名>-xxx.pages.dev）を、中継の許可に入れて、中継を置き直す
#    relay/wrangler.jsonc の ALLOWED_ORIGINS を、そのURLにして: cd relay && npx wrangler deploy
```

初めて`wrangler pages project create`をするとき、`package.json`にHonoがあると失敗することがあります。そのときは、空のディレクトリで `npx wrangler pages project create <アプリ名> --production-branch production --force` を一度だけ動かします。

## 共有のしくみ

- **共有を始めた人がオーナー**（管理者）です。オーナーは1人だけです。
- 参加するには、オーナーが作る**招待コード**（10分で切れて、1回だけ使える）を入れ、オーナーの画面で、**確認の数字（4桁）が参加する端末の画面と同じ**ことを見比べて**承認**します。招待コードが漏れても、承認がなければ入れません。
- 参加者は、オーナーが外せます。外すと、鍵が新しくなり、外された端末は以後の変更を読めません。
- **オーナーが複数いる**（オーナーの鍵が複製された、中継に偽の記録がある）と、各端末が検出して、同期を止めてアラートを出します。
- オーナーの端末をなくすと、承認ができなくなります（共有を作り直してください）。
- 共有しなくても、中継が止まっていても、オフラインでも、アプリは使えます。変更は端末に溜まり、つながったときに送られます。

## 無料枠を使い切られたとき

中継の無料枠（Workersは1日10万要求）を超えると、課金されずに共有の同期だけが止まります（日本時間の午前9時に戻ります）。アプリは、端末で使い続けられ、データは失われません。
嫌がらせを受けて止められる場合は、(1) 翌日を待つ、(2) 中継を別の名前で置き直して、`VITE_SYNC_URL`を差し替えて画面を置き直す、(3) `cd relay && npx wrangler delete` で中継を消す（共有はできなくなる）、の順で対処します。ドメインを取れば、Cloudflareのレート制限（WAF）も使えます。

AIへの指示は [AGENTS.md](AGENTS.md) にあります。
