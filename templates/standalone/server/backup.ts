// データの書き出しと読み込み（バックアップ）。端末のブラウザの中だけにあるデータを、ファイルに残して、
// 端末を替えたり、ブラウザのデータを消したりしたときに戻せるようにする。
// 表と列の名前は、書き出し・読み込みのたびに、データベースの中にあるものと照らす（外からの名前をSQLに使わない）。
import { Hono } from "hono";
import type { Db } from "./db.ts";

type Value = string | number | null;
export interface Backup {
  format: 1;
  exportedAt: number;
  tables: Record<string, { columns: string[]; rows: Value[][] }>;
}

/** 書き出さない表。共有の鍵（端末の秘密鍵など）が入っているので、バックアップに含めない。 */
const SKIP = new Set(["sync_state"]);
const MAX_ROWS = 200_000;
const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

function tablesOf(db: Db): string[] {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as unknown as { name: string }[];
  return rows.map((r) => r.name).filter((n) => !SKIP.has(n));
}

function columnsOf(db: Db, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${quote(table)})`).all() as unknown as { name: string }[]).map((c) => c.name);
}

export function exportAll(db: Db, now: () => number = Date.now): Backup {
  const tables: Backup["tables"] = {};
  for (const table of tablesOf(db)) {
    const columns = columnsOf(db, table);
    const rows = db.prepare(`SELECT ${columns.map(quote).join(", ")} FROM ${quote(table)}`).all() as unknown as Record<string, unknown>[];
    tables[table] = { columns, rows: rows.map((r) => columns.map((c) => toValue(r[c]))) };
  }
  return { format: 1, exportedAt: now(), tables };
}

function toValue(v: unknown): Value {
  if (v === null || typeof v === "string") return v;
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  throw new Error("バイナリのデータは、書き出せません");
}

/**
 * バックアップを読み込む。すべて成功するか、何も変えないか（途中で失敗したら元に戻す）。
 * uid と updated_at を持つ表（共有する表）は、新しいほうを残して合わせる（同期の対象にもなる）。
 * それ以外の表は、中身を入れ替える。
 */
export function importAll(db: Db, data: unknown): { tables: number; rows: number } {
  if (typeof data !== "object" || data === null) throw new Error("バックアップのファイルではありません");
  const b = data as Partial<Backup>;
  if (b.format !== 1 || typeof b.tables !== "object" || b.tables === null) throw new Error("バックアップの形式が違います");
  const known = new Set(tablesOf(db));
  let total = 0;
  const plan: { table: string; columns: string[]; rows: Value[][] }[] = [];
  for (const [table, t] of Object.entries(b.tables)) {
    if (!known.has(table)) throw new Error(`この版にない表「${table}」が含まれています`);
    const actual = new Set(columnsOf(db, table));
    if (!t || !Array.isArray(t.columns) || !Array.isArray(t.rows)) throw new Error(`表「${table}」の形が違います`);
    if (t.columns.some((c) => typeof c !== "string" || !actual.has(c)) || new Set(t.columns).size !== t.columns.length) throw new Error(`表「${table}」に、この版にない列があります`);
    for (const row of t.rows) {
      if (!Array.isArray(row) || row.length !== t.columns.length || row.some((v) => v !== null && typeof v !== "string" && typeof v !== "number")) throw new Error(`表「${table}」の行の形が違います`);
    }
    total += t.rows.length;
    if (total > MAX_ROWS) throw new Error("行が多すぎます");
    plan.push({ table, columns: t.columns, rows: t.rows as Value[][] });
  }

  db.exec("BEGIN");
  try {
    for (const { table, columns, rows } of plan) {
      const actual = columnsOf(db, table);
      const shared = actual.includes("uid") && actual.includes("updated_at") && columns.includes("uid") && columns.includes("updated_at");
      // 共有する表に読み込んだ行は、中継にまだ送っていない変更として扱う。
      const cols = shared && actual.includes("dirty") && !columns.includes("dirty") ? [...columns, "dirty"] : columns;
      const extra = cols.length > columns.length ? [1] : [];
      if (!shared) db.prepare(`DELETE FROM ${quote(table)}`).run();
      const names = cols.map(quote).join(", ");
      const marks = cols.map(() => "?").join(", ");
      const sql = shared
        ? `INSERT INTO ${quote(table)} (${names}) VALUES (${marks}) ON CONFLICT(uid) DO UPDATE SET ${cols.filter((c) => c !== "uid").map((c) => `${quote(c)} = excluded.${quote(c)}`).join(", ")} WHERE excluded.updated_at > ${quote(table)}.updated_at`
        : `INSERT INTO ${quote(table)} (${names}) VALUES (${marks})`;
      const stmt = db.prepare(sql);
      const dirty = shared ? cols.indexOf("dirty") : -1;
      for (const row of rows) {
        const values = [...row, ...extra];
        if (dirty >= 0) values[dirty] = 1;
        stmt.run(...values);
      }
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw new Error(`読み込めませんでした（${e instanceof Error ? e.message : "エラー"}）。データは変わっていません`);
  }
  return { tables: plan.length, rows: total };
}

export function backupRoutes(db: Db, now: () => number = Date.now, afterImport?: () => void) {
  const app = new Hono();
  app.get("/", (c) => c.json(exportAll(db, now)));
  app.post("/import", async (c) => {
    const data = await c.req.json().catch(() => null);
    try {
      const r = importAll(db, data);
      afterImport?.();
      return c.json(r);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "error" }, 400);
    }
  });
  return app;
}
