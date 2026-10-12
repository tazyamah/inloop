// データベース（SQLite）。Node.js組み込みの node:sqlite を使う。
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

/** データベースを開き、表がなければ作る。":memory:" を渡すとメモリ上に作る（テスト用）。 */
export function openDb(path = process.env.DB_PATH ?? "data/app.db"): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  // inloop:tables（`inloop generate scaffold`が、ここに表を足す）
  return db;
}
