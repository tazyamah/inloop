// inloop generate scaffold（ADR-0038）
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineResource, parseFields, pluralOf } from "../dist/scaffold.js";
import { buildPackets } from "../dist/engine/build.js";

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", "inloop");

test("複数形と列の定義を読む", () => {
  assert.deepEqual(["task", "category", "box", "day", "blog_post"].map(pluralOf), ["tasks", "categories", "boxes", "days", "blog_posts"]);
  assert.deepEqual(parseFields(["title:text", "due:date:optional", "n:int?"]), [
    { name: "title", type: "text", optional: false },
    { name: "due", type: "date", optional: true },
    { name: "n", type: "int", optional: true },
  ]);
  assert.throws(() => parseFields([]), /列を1つ以上/);
  assert.throws(() => parseFields(["title"]), /読めない/);
  assert.throws(() => parseFields(["title:string"]), /型「string」は使えない/);
  assert.throws(() => parseFields(["id:int"]), /自動で付く列/);
  assert.throws(() => parseFields(["order:int"]), /予約語/);
  assert.throws(() => parseFields(["a:text", "a:int"]), /重なっている/);
  assert.throws(() => parseFields(["Title:text"]), /使えない/);
  assert.throws(() => defineResource("Task", ["a:text"]), /使えない/);
  assert.throws(() => defineResource("note", ["a:text"]), /最初からあるメモ/);
  assert.equal(defineResource("task", ["a:text"], { label: "タスク" }).label, "タスク");
});

function newApp() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "inloop-home-")));
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "inloop-scaffold-")));
  const env = { ...process.env, INLOOP_HOME: home };
  const run = (cwd, ...a) => spawnSync(process.execPath, [BIN, ...a], { encoding: "utf8", cwd, env });
  const r = run(parent, "new", "app");
  assert.equal(r.status, 0, r.stderr);
  return { dir: join(parent, "app"), run };
}

test("generate scaffoldは、表・API・テスト・画面を作り、既存のファイルに目印の位置で足す", () => {
  const { dir, run } = newApp();
  const r = run(dir, "generate", "scaffold", "task", "title:text", "done:bool", "due:date:optional", "--label", "タスク");
  assert.equal(r.status, 0, r.stderr);
  for (const f of ["server/routes/tasks.ts", "server/tasks.test.ts", "web/src/pages/Tasks.tsx"]) assert.ok(existsSync(join(dir, f)), f);
  const read = (f) => readFileSync(join(dir, f), "utf8");
  assert.match(read("server/db.ts"), /CREATE TABLE IF NOT EXISTS tasks \(\n\s+id INTEGER PRIMARY KEY AUTOINCREMENT,\n\s+title TEXT NOT NULL,\n\s+done INTEGER NOT NULL,\n\s+due TEXT,/);
  assert.match(read("server/app.ts"), /import \{ tasksRoutes \} from "\.\/routes\/tasks\.ts";/);
  assert.match(read("server/app.ts"), /app\.route\("\/api\/tasks", tasksRoutes\(db\)\);/);
  assert.match(read("web/src/App.tsx"), /\{ path: "tasks", label: "タスク", Page: Tasks \},/);
  assert.ok(JSON.parse(read("inloop.json")).layers.find((l) => l.id === "http").files.includes("server/routes/*.ts"));

  // 2つ目の資源は、同じ目印の前に足される。重なる名前は断り、何も書き換えない。
  assert.equal(run(dir, "generate", "scaffold", "category", "name:text").status, 0);
  assert.match(read("server/app.ts"), /tasksRoutes\(db\)\);\n\s+app\.route\("\/api\/categories"/);
  const before = read("server/app.ts");
  const again = run(dir, "generate", "scaffold", "task", "title:text");
  assert.equal(again.status, 1);
  assert.match(again.stderr, /すでにある/);
  assert.equal(read("server/app.ts"), before);
  assert.match(run(dir, "generate", "scaffold", "x").stderr, /列を1つ以上/);
  assert.match(run(dir, "generate", "model", "x", "a:text").stderr, /知らない生成の種類/);
});

test("目印のないアプリには、何も書かずに断る", () => {
  const { dir, run } = newApp();
  spawnSync("sh", ["-c", "sed -i.bak 's/inloop:routes/x/' server/app.ts"], { cwd: dir });
  const r = run(dir, "generate", "scaffold", "task", "title:text");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /server\/app\.ts に目印「\/\/ inloop:routes」がない/);
  assert.ok(!existsSync(join(dir, "server/routes/tasks.ts")));
});

test("生成したAPIの表と列を、依頼票が読み取れる（動的なSQLにならない）", () => {
  const { dir, run } = newApp();
  assert.equal(run(dir, "generate", "scaffold", "task", "title:text", "done:bool", "due:date:optional").status, 0);
  spawnSync("git", ["-C", dir, "add", "-A"]);
  spawnSync("git", ["-C", dir, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "init"]);
  const p = buildPackets(dir, [{ id: "R1", group: "R1", viewpoint: "q", symbols: ["server/routes/tasks.ts#tasksRoutes"] }], "HEAD")[0];
  const w = p.tables.find((t) => t.access === "write" && t.table === "tasks");
  assert.ok(w && ["done", "due", "title"].every((c) => w.columns.includes(c)));
  assert.deepEqual(p.unresolved.filter((u) => u.includes("動的なSQL")), []);
});

// 生成したアプリが、実際に型検査・テスト・ビルドを通る。依存のインストールが要るので、INLOOP_APP_E2E=1のときだけ動かす。
test("生成したアプリの npm test と npm run build が通る", { skip: process.env.INLOOP_APP_E2E !== "1", timeout: 600000 }, () => {
  const { dir, run } = newApp();
  assert.equal(run(dir, "generate", "scaffold", "task", "title:text", "done:bool", "due:date:optional", "estimate:real:optional", "count:int").status, 0);
  const sh = (cmd) => spawnSync("sh", ["-c", cmd], { cwd: dir, encoding: "utf8" });
  assert.equal(sh("npm install").status, 0);
  const t = sh("npm test");
  assert.equal(t.status, 0, t.stdout + t.stderr);
  const b = sh("npm run build");
  assert.equal(b.status, 0, b.stdout + b.stderr);
});
