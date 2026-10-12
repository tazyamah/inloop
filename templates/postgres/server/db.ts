// データベース（PostgreSQL）。接続先は環境変数 DATABASE_URL。"memory:" を渡すとメモリ上のPostgreSQL（PGlite）に作る（テスト用）。
import pg from "pg";

/** サーバーが使うのは query だけ。pg の Pool と PGlite のどちらもこの形を満たす。 */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS notes (
  id BIGSERIAL PRIMARY KEY,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

/** データベースを開き、表がなければ作る。 */
export async function openDb(url = process.env.DATABASE_URL): Promise<Db> {
  if (url === undefined || url === "") throw new Error("DATABASE_URL を設定する（例: postgres://localhost/mydb）");
  let db: Db;
  if (url === "memory:") {
    const { PGlite } = await import("@electric-sql/pglite");
    db = new PGlite();
  } else {
    db = new pg.Pool({ connectionString: url });
  }
  await db.query(SCHEMA);
  return db;
}
