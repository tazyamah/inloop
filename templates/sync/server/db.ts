// データベース（SQLite）。node:sqlite の使い方で書く。ブラウザ向けのビルドでは、vite.config.ts が
// node:sqlite を server/sqlite-wasm.ts に差し替える（Node.jsで動かすテストは、そのまま node:sqlite を使う）。
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

/** データベースを開き、表がなければ作る。":memory:" を渡すとメモリ上に作る（テスト用）。 */
export function openDb(path = ":memory:"): Db {
  const db = new DatabaseSync(path);
  // 同期する表は、端末ごとに作れる文字列のid（uid）を主キーにし、消したときは行を残して deleted を立てる。
  // updated_at（ミリ秒）が新しい変更が勝つ（端末の時計が頼り）。dirty=1 は、中継にまだ送っていない変更。
  // 同期する表は server/sync-tables.ts にも書く。
  db.exec(`CREATE TABLE IF NOT EXISTS notes (
    uid TEXT PRIMARY KEY,
    body TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    dirty INTEGER NOT NULL DEFAULT 1
  )`);
  // inloop:tables（`inloop generate scaffold`が、ここに表を足す）
  // 同期の設定（端末の鍵、共有の記録、グループ鍵など）。
  db.exec("CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  return db;
}
