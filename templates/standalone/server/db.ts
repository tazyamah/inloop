// データベース（SQLite）。node:sqlite の使い方で書く。ブラウザ向けのビルドでは、vite.config.ts が
// node:sqlite を server/sqlite-wasm.ts に差し替える（Node.jsで動かすテストは、そのまま node:sqlite を使う）。
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

/** データベースを開き、表がなければ作る。":memory:" を渡すとメモリ上に作る（テスト用）。 */
export function openDb(path = ":memory:"): Db {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  // inloop:tables（`inloop generate scaffold`が、ここに表を足す）
  return db;
}
