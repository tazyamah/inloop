# ADR-0019: 手元で動くアプリの雛形は、Tauriの外枠に、NodeのSEAにまとめたHonoを同梱する

- 状態: Accepted
- 日付: 2026-10-11
- Supersedes: なし（ADR-0011の「手元で動くアプリ」の同梱の作り方を決める）

## 決定

- `inloop new <dir> --desktop`は、サーバー向けの雛形（`templates/server/`）の上に、`templates/desktop/`を重ねる。
- サーバー（Hono＋`node:sqlite`）は、`scripts/build-sidecar.mjs`でesbuildにより1つのCommonJSにまとめ、Nodeの単一実行ファイル（SEA）にして、Tauriの`externalBin`（sidecar）として同梱する。大きさは約105MB（Node.js本体を含む）。
- Tauri（`src-tauri/src/lib.rs`）は、開発中は画面（vite）のURLを開き、本番では空いているポートを選んでサーバーを起動し（`PORT`、`DB_PATH`＝アプリのデータフォルダ、`DESKTOP=1`）、待ち受けを確かめてから、そのURLをウィンドウで開く。アプリの終了時にサーバーを止める。画面のファイルは資源（`dist/web`）として同梱し、サーバーの作業ディレクトリを資源フォルダにする。
- `DESKTOP=1`のサーバーは、宛先（Host）が`127.0.0.1:<ポート>`か`localhost:<ポート>`でなければ、書き込みは送信元（Origin）が同じでなければ、拒否する（ADR-0013と同じ考え方）。
- Tauriの権限（capabilities）は空にする。サーバーはRust側から起動し、画面からは何も許さない。

## 検証

- 確かめた（macOS、arm64、Node.js 22.18.0）: 雛形から`npm run build:desktop`でSEAの実行ファイルができ、`DESKTOP=1`で起動して、API・画面の配信・SQLiteの書き込みが動くこと。宛先・送信元が違う要求を403で拒否すること（最初は、確認をルートより後に登録して効いておらず、直した）。
- 未検証: Rust側（`src-tauri`のビルド、アプリとしての起動、`tauri build`のインストーラー）。このMacにはRustが入っていない。
- 未検証: Windows・Linuxでのsidecarの作り方（macOSのcodesign以外は未確認）、アプリアイコンの生成（仮の1枚だけ）、署名と公証。

## 影響

- アプリが約105MB以上になる（ADR-0011の見込み50〜100MBを超えた）。Node.js本体を含むため。軽くしたければ、Bun・Denoのコンパイル機能や、`node:sqlite`を使わない構成を検討する。
- `node:sqlite`の実験的機能の警告が、同梱サーバーのログに出る。

## 関連資料

- [ADR-0011](0011-inloop-command-and-app-templates.md)
- [ADR-0013](0013-machine-wide-ui-server.md)
