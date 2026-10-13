import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { backupRoutes, exportAll, importAll } from "./backup.ts";

function db() {
  const d = new DatabaseSync(":memory:");
  d.exec("CREATE TABLE plain (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
  d.exec("CREATE TABLE shared (uid TEXT PRIMARY KEY, body TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, dirty INTEGER NOT NULL DEFAULT 0)");
  d.exec("CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  d.exec("INSERT INTO sync_state VALUES ('identity', '秘密鍵')");
  return d;
}

test("書き出しは、共有の鍵（sync_state）を含まず、読み込みで元に戻る", () => {
  const a = db();
  a.exec("INSERT INTO plain VALUES (1, 'りんご'), (2, 'みかん')");
  a.exec("INSERT INTO shared VALUES ('u1', '牛乳', 0, 1, 1, 0)");
  const backup = exportAll(a, () => 42);
  assert.deepEqual(Object.keys(backup.tables).sort(), ["plain", "shared"]);
  assert.equal(JSON.stringify(backup).includes("秘密鍵"), false);
  assert.equal(backup.exportedAt, 42);

  const b = db();
  assert.deepEqual(importAll(b, JSON.parse(JSON.stringify(backup))), { tables: 2, rows: 3 });
  assert.deepEqual(b.prepare("SELECT name FROM plain ORDER BY id").all().map((r) => r.name), ["りんご", "みかん"]);
  // 共有する表に読み込んだ行は、中継に未送信（dirty = 1）になる。
  assert.equal((b.prepare("SELECT dirty FROM shared WHERE uid = 'u1'").get() as { dirty: number }).dirty, 1);
});

test("共有する表は新しいほうを残し、それ以外の表は入れ替える", () => {
  const a = db();
  a.exec("INSERT INTO shared VALUES ('u1', '古い', 0, 1, 10, 0), ('u2', 'あとの', 0, 1, 50, 0)");
  a.exec("INSERT INTO plain VALUES (9, '消える')");
  const b = db();
  b.exec("INSERT INTO shared VALUES ('u1', '新しい', 0, 1, 20, 0)");
  b.exec("INSERT INTO plain VALUES (3, '入れ替わる')");
  const backup = exportAll(a);
  importAll(b, backup);
  const rows = b.prepare("SELECT uid, body FROM shared ORDER BY uid").all().map((r) => [r.uid, r.body]);
  assert.deepEqual(rows, [["u1", "新しい"], ["u2", "あとの"]]); // u1は手元が新しい
  assert.deepEqual(b.prepare("SELECT name FROM plain").all().map((r) => r.name), ["消える"]);
});

test("形の合わないファイルは、何も変えずに断る（途中で失敗しても元に戻る）", () => {
  const d = db();
  d.exec("INSERT INTO plain VALUES (1, '元のまま')");
  const bad: unknown[] = [
    null, "x", { format: 2, tables: {} }, { format: 1 },
    { format: 1, tables: { nothing: { columns: ["a"], rows: [] } } },
    { format: 1, tables: { plain: { columns: ["id", "zzz"], rows: [] } } },
    { format: 1, tables: { plain: { columns: ["id", "id"], rows: [] } } },
    { format: 1, tables: { plain: { columns: ["id", "name"], rows: [[1]] } } },
    { format: 1, tables: { plain: { columns: ["id", "name"], rows: [[1, { x: 1 }]] } } },
    { format: 1, tables: { sync_state: { columns: ["key", "value"], rows: [["identity", "偽"]] } } },
    { format: 1, tables: { 'plain"; DROP TABLE plain; --': { columns: [], rows: [] } } },
    // 制約に反する行（name が null）は、途中で失敗して、全部元に戻る。
    { format: 1, tables: { plain: { columns: ["id", "name"], rows: [[5, "入る"], [6, null]] } } },
  ];
  for (const b of bad) assert.throws(() => importAll(d, b));
  assert.deepEqual(d.prepare("SELECT id, name FROM plain").all().map((r) => [r.id, r.name]), [[1, "元のまま"]]);
  assert.equal((d.prepare("SELECT value FROM sync_state").get() as { value: string }).value, "秘密鍵");
});

test("APIで書き出して、読み込める", async () => {
  const a = db();
  a.exec("INSERT INTO plain VALUES (1, 'a')");
  const app = backupRoutes(a);
  const backup = await (await app.request("/")).json();
  let touched = 0;
  const b = db();
  const app2 = backupRoutes(b, Date.now, () => touched++);
  const ok = await app2.request("/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(backup) });
  assert.equal(ok.status, 200);
  assert.equal(touched, 1);
  const ng = await app2.request("/import", { method: "POST", body: "壊れた" });
  assert.equal(ng.status, 400);
  assert.equal(touched, 1);
});
