// SQLのテーブル解析（ADR-0026）
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tablesOf } from "../dist/engine/sql.js";
import { buildPackets } from "../dist/engine/build.js";
import { makeRepo } from "./helpers.mjs";

const t = (sql) => tablesOf(sql).map((u) => `${u.access}:${u.table}`);

test("読む・書く・スキーマのテーブルを取り出す", () => {
  assert.deepEqual(t("SELECT * FROM items, orders o JOIN users u ON u.id = o.uid WHERE x = 'from fake'"), ["read:items", "read:orders", "read:users"]);
  assert.deepEqual(t("INSERT OR REPLACE INTO orders(id) VALUES (1)"), ["write:orders"]);
  assert.deepEqual(t("UPDATE orders SET a = 1"), ["write:orders"]);
  assert.deepEqual(t("INSERT INTO t(a) VALUES (1) ON CONFLICT(a) DO UPDATE SET a = 2"), ["write:t"]);
  assert.deepEqual(t('DELETE FROM "my table" -- from other\n'), ["write:my table"]);
  assert.deepEqual(t("CREATE TABLE IF NOT EXISTS notes (id INTEGER)"), ["schema:notes"]);
  assert.deepEqual(t("WITH a AS (SELECT * FROM base) SELECT * FROM a"), ["read:base"]);
  assert.deepEqual(t("SELECT * FROM (SELECT * FROM inner_t) x"), ["read:inner_t"]);
});

test("依頼票のtablesに入り、動的なSQLは未解決になる", () => {
  const repo = makeRepo("sql", { commit: true });
  writeFileSync(join(repo, "src", "db.ts"), [
    "declare const db: { prepare(s: string): { run(): void }; exec(s: string): void };",
    "export function save(table: string) {",
    "  db.prepare(\"INSERT INTO orders(id) VALUES (1)\").run();",
    "  db.prepare(`DELETE FROM ${table}`).run();",
    "  /x/.exec(\"select\");",
    "}",
    "",
  ].join("\n"));
  const p = buildPackets(repo, [{ id: "R1", group: "R1", viewpoint: "q", symbols: ["src/db.ts#save"] }], "HEAD")[0];
  assert.deepEqual(p.tables, [{ symbol: "src/db.ts#save", table: "orders", access: "write", columns: ["id"] }]);
  assert.equal(p.unresolved.filter((u) => u.includes("動的なSQL")).length, 1);
  const none = buildPackets(repo, [{ id: "R1", group: "R1", viewpoint: "q", symbols: ["src/app.ts#hello"] }], "HEAD")[0];
  assert.deepEqual(none.tables, []);
});

test("並べていない宣言の中のSQLを、呼び出しを2段までたどって出す（ADR-0030）", () => {
  const repo = makeRepo("sqlvia", { commit: true });
  writeFileSync(join(repo, "src", "db.ts"), [
    "declare const db: { prepare(s: string): { run(): void } };",
    "export function insertRow() { db.prepare(\"INSERT INTO orders(id) VALUES (1)\").run(); }",
    "export function deep() { insertRow(); }",
    "export function deeper() { deep(); }",
    "export function deepest() { deeper(); }",
    "",
  ].join("\n"));
  writeFileSync(join(repo, "src", "api.ts"), [
    "import { deep, deepest } from \"./db.ts\";",
    "export function post() { deep(); }",
    "export function far() { deepest(); }",
    "",
  ].join("\n"));
  const build = (s) => buildPackets(repo, [{ id: "R1", group: "R1", viewpoint: "q", symbols: [s] }], "HEAD")[0];
  // post → deep（並べる）→ insertRow。deepが自分の分を持つので、postには出ない。
  assert.deepEqual(build("src/api.ts#post").tables, [{ symbol: "src/db.ts#deep", table: "orders", access: "write", columns: ["id"], via: ["src/db.ts#insertRow"] }]);
  // far → deepest（並べる）→ deeper → deep → insertRow。2段でdeepまで、insertRowは3段目なので出ない。
  assert.deepEqual(build("src/api.ts#far").tables, []);
});

// --- 列（ADR-0031） ---

const c = (sql) => tablesOf(sql).map((u) => `${u.access}:${u.table}(${(u.columns ?? ["-"]).join(",")})`);

test("書く列: INSERTの列の並び、UPDATEのSET、ON CONFLICTのDO UPDATE。列の並びがなければ全列", () => {
  assert.deepEqual(c("INSERT INTO notes(title, body) VALUES (?, ?)"), ["write:notes(body,title)"]);
  assert.deepEqual(c("INSERT INTO notes VALUES (?, ?)"), ["write:notes(*)"]);
  assert.deepEqual(c("UPDATE orders SET status = ?, paid = paid + 1 WHERE id = :id"), ["write:orders(paid,status)"]);
  assert.deepEqual(c("INSERT INTO t(a) VALUES (1) ON CONFLICT(a) DO UPDATE SET b = excluded.b, c = 2"), ["write:t(a,b,c)"]);
  assert.deepEqual(c("UPDATE t SET (a, b) = (1, 2)"), ["write:t(*)"]);
  assert.deepEqual(c("DELETE FROM orders WHERE id = 1"), ["write:orders(*)"]);
});

test("読む列: 1つのテーブルなら列、別名つきは結び付け、決められないときは全列", () => {
  assert.deepEqual(c("SELECT id, title FROM notes WHERE done = 0 ORDER BY created_at DESC LIMIT 10"), ["read:notes(created_at,done,id,title)"]);
  assert.deepEqual(c("SELECT * FROM notes"), ["read:notes(*)"]);
  assert.deepEqual(c("SELECT count(*) FROM notes"), ["read:notes(-)"]);
  assert.deepEqual(c("SELECT n.id, u.name AS who FROM notes n JOIN users u ON u.id = n.uid WHERE n.done = ?"), ["read:notes(done,id,uid)", "read:users(id,name)"]);
  assert.deepEqual(c("SELECT o.* FROM orders o"), ["read:orders(*)"]);
  assert.deepEqual(c("SELECT id FROM a JOIN b ON a.x = b.x"), ["read:a(*,x)", "read:b(*,x)"], "付いていない列はどちらのものか決められない");
  assert.deepEqual(c("WITH a AS (SELECT id FROM base) SELECT id FROM a"), ["read:base(*)"], "CTEがあれば決められない");
});

test("複数の文は文ごとに読み、スキーマには列を付けない", () => {
  assert.deepEqual(c("CREATE TABLE notes (id INTEGER, title TEXT); INSERT INTO notes(title) VALUES ('x'); SELECT id FROM notes"), ["schema:notes(-)", "write:notes(title)", "read:notes(id)"]);
});

test("依頼票のtablesに列が入り、同じテーブルの列は合わさる", () => {
  const repo = makeRepo("sqlcols", { commit: true });
  writeFileSync(join(repo, "src", "db.ts"), [
    "declare const db: { prepare(s: string): { run(): void } };",
    "export function save() {",
    "  db.prepare(\"UPDATE orders SET status = 1\").run();",
    "  db.prepare(\"UPDATE orders SET paid = 1, status = 2\").run();",
    "}",
    "",
  ].join("\n"));
  const p = buildPackets(repo, [{ id: "R1", group: "R1", viewpoint: "q", symbols: ["src/db.ts#save"] }], "HEAD")[0];
  assert.deepEqual(p.tables, [{ symbol: "src/db.ts#save", table: "orders", access: "write", columns: ["paid", "status"] }]);
});
