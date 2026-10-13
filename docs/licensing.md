# ライセンスと第三者の素材

## inloop本体

[MIT License](../LICENSE)です（Copyright (c) 2026 Tatsuya Suzuki）。コード、文書、`templates/`の雛形、アイコンを含みます。

選んだ理由: `inloop new`は`templates/`のファイルを利用者のアプリにコピーして作るので、コピー先に条件（NOTICEの同梱や特許条項への対応など）を持ち込まない、最も短い許諾にしました。依存パッケージはMITとApache-2.0が中心で、組み合わせても矛盾しません。種類は後から変えられます（作者が著作権を持つ範囲。他の人の貢献が入ったあとは、その人たちの同意が要ります）。

## 作ったアプリ

`inloop new`・`inloop generate scaffold`で作ったコードの権利と、公開時のライセンスは、利用者が決めます。雛形由来の部分はMITなので、利用者のアプリにコピーしたあとは、MITの著作権表示と許諾文を残せば、閉じたライセンスにもできます。雛形が入れるアイコン（`templates/desktop/src-tauri/icons/`、`templates/standalone/web/`）も同じです。差し替えて構いません。

## 依存パッケージ

inloop本体（`package.json`、`npm ci`で入るもの）の直接の依存:

| パッケージ | ライセンス |
|---|---|
| `@modelcontextprotocol/server`（開発では`client`も） | Apache-2.0 |
| `@modelcontextprotocol/ext-apps` | MIT |
| `typescript` | Apache-2.0 |
| `zod` | MIT |
| `esbuild`、`@types/node`（開発のみ） | MIT |

間接の依存を含め、`npm ci`で入るパッケージは、MIT・Apache-2.0・ISCです（2026-10-13時点、`node_modules`の各`package.json`の`license`欄で確認）。

`npm run build`は、画面のコード（`dist/ui/`）に`@modelcontextprotocol/ext-apps`などをesbuildでまとめて入れます。`dist/`はcommitしておらず、配布していません。配布物を作るときは、含まれる依存のライセンス文を同梱します。

雛形が使う依存（利用者のアプリの`package.json`に入る）:

| パッケージ | ライセンス | 入る雛形 |
|---|---|---|
| `hono`、`@hono/node-server`、`react`、`react-dom`、`vite`、`tsx`、`postject` | MIT | すべて、または`--desktop` |
| `@sqlite.org/sqlite-wasm` | Apache-2.0 | `--standalone`・`--sync` |
| `@tauri-apps/cli` | Apache-2.0またはMIT | `--desktop` |

ライセンスは各パッケージのnpmの登録情報で確認しました。上の表のパッケージのバージョンが変わったときは、確かめ直してください。

## アイコン・名称

アイコン（`templates/…/icons/`、`templates/standalone/web/`の`icon.png`と`extension/icon.png`）はこのプロジェクトで作ったもので、MITに含めます。名称「inloop」とアイコンの商標は、調査（J-PlatPat、USPTO）が済んでいません。名称・ロゴを使って別の製品を出すときは、混同が起きないようにしてください。
