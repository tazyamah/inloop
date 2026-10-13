// ユースケースの対応（ADR-0046）
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPackets } from "../dist/engine/build.js";
import { TsProject } from "../dist/engine/project.js";
import { usecaseMap } from "../dist/engine/usecases.js";
import { parseFullConfig } from "../dist/engine/rules.js";

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", "inloop");
const SPEC = { routes: ["server/app.ts", "server/routes/*.ts"], tests: ["server/**/*.test.ts"] };

/** ファイルの内容を渡して、commit済みの小さなリポジトリを作る。 */
function repoOf(files, usecases = SPEC) {
  // usecasesにnullを渡すと、inloop.jsonに書かない。
  const repo = join(realpathSync(mkdtempSync(join(tmpdir(), "inloop-uc-"))), "app");
  const all = {
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, target: "es2022", module: "nodenext", allowImportingTsExtensions: true, noEmit: true }, include: ["server"] }),
    "inloop.json": JSON.stringify({ format: 1, boundaries: [], ...(usecases ? { usecases } : {}) }),
    ...files,
  };
  for (const [f, s] of Object.entries(all)) {
    mkdirSync(dirname(join(repo, f)), { recursive: true });
    writeFileSync(join(repo, f), s);
  }
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init"]);
  return repo;
}

const mapOf = (repo, spec = SPEC) => {
  const project = new TsProject(repo);
  try { return usecaseMap(project, spec); } finally { project.close(); }
};

const HONO = 'declare class Hono { get(p: string, ...h: unknown[]): void; post(p: string, ...h: unknown[]): void; put(p: string, ...h: unknown[]): void; delete(p: string, ...h: unknown[]): void; route(p: string, a: unknown): void; request(p: string, o?: unknown): Promise<unknown> }\n';
const DB = "declare const db: { prepare(s: string): { all(...a: unknown[]): unknown[]; run(...a: unknown[]): unknown } };\n";

const APP = HONO + DB + `
export function itemsRoutes() {
  const app = new Hono();
  app.get("/", () => db.prepare("SELECT id, name FROM items").all());
  app.get("/new", () => "form");
  app.get("/:id", () => db.prepare("SELECT name FROM items WHERE id = ?").all(1));
  app.post("/", () => save("x"));
  app.delete("/:id", () => db.prepare("DELETE FROM items WHERE id = ?").run(1));
  return app;
}

function save(name: string) {
  return audit(name);
}

function audit(name: string) {
  db.prepare("INSERT INTO items (name) VALUES (?)").run(name);
  db.prepare("INSERT INTO audit_log (what) VALUES (?)").run(name);
}

export function createApp() {
  const app = new Hono();
  app.get("/health", () => "ok");
  app.route("/api/items", itemsRoutes());
  return app;
}
`;

const TEST = HONO + `
declare const test: (n: string, f: () => void) => void;
declare const createApp: () => Hono;
const json = (method: string, body?: unknown) => ({ method, body });

test("一覧と新規", async () => {
  const app = createApp();
  await app.request("/api/items");
  await app.request("/api/items/new");
  await app.request("/api/items", json("POST", { name: "a" }));
});

test("1件の取得と削除", async () => {
  const app = createApp();
  const id = 3;
  await app.request(\`/api/items/\${id}\`);
  await app.request("/api/items/999", { method: "DELETE" });
});
`;

test("入口を、マウント先の接頭辞つきのメソッドとパスで見つける", () => {
  const { usecases, findings } = mapOf(repoOf({ "server/app.ts": APP, "server/app.test.ts": TEST }));
  assert.deepEqual(findings, []);
  assert.deepEqual(usecases.map((u) => u.id), ["GET /api/items", "GET /api/items/new", "GET /api/items/:id", "POST /api/items", "DELETE /api/items/:id", "GET /health"]);
  assert.equal(usecases[0].symbol, "server/app.ts#itemsRoutes");
});

test("入口のSQLの表と列を、直接と呼び出しの先（経由つき）から結び付ける", () => {
  const { usecases } = mapOf(repoOf({ "server/app.ts": APP, "server/app.test.ts": TEST }));
  const by = Object.fromEntries(usecases.map((u) => [u.id, u]));
  assert.deepEqual(by["GET /api/items"].tables, [{ table: "items", access: "read", columns: ["id", "name"] }]);
  assert.deepEqual(by["DELETE /api/items/:id"].tables.map((t) => `${t.access} ${t.table}`), ["write items"]);
  // saveの2段先（audit）のSQLも、経由つきで結び付く。
  const post = by["POST /api/items"].tables;
  assert.deepEqual(post.map((t) => `${t.access} ${t.table} ${(t.via ?? []).map((v) => v.split("#")[1]).join(">")}`).sort(), ["write audit_log save>audit", "write items save>audit"]);
  assert.deepEqual(by["GET /health"].tables, []);
});

test("テストは、リテラルのパス・メソッドが同じ入口に結び付く。リテラルが多く一致する入口を優先し、パスの変数は:idとだけ対応する", () => {
  const { usecases, unlinked } = mapOf(repoOf({ "server/app.ts": APP, "server/app.test.ts": TEST }));
  const by = Object.fromEntries(usecases.map((u) => [u.id, u.tests.map((t) => `${t.name}:${t.line}`)]));
  assert.deepEqual(by["GET /api/items"], ["一覧と新規:9"]);
  assert.deepEqual(by["GET /api/items/new"], ["一覧と新規:10"]);
  assert.deepEqual(by["POST /api/items"], ["一覧と新規:11"]);
  assert.deepEqual(by["GET /api/items/:id"], ["1件の取得と削除:17"]);
  assert.deepEqual(by["DELETE /api/items/:id"], ["1件の取得と削除:18"]);
  assert.deepEqual(by["GET /health"], []);
  assert.deepEqual(unlinked, []);
});

test("どの入口にも当たらない要求は、結び付けずに示す", () => {
  const t = TEST.replace('"/api/items/new"', '"/api/nothing"');
  const { usecases, unlinked } = mapOf(repoOf({ "server/app.ts": APP, "server/app.test.ts": t }));
  assert.equal(usecases.find((u) => u.id === "GET /api/items/new").tests.length, 0);
  assert.equal(unlinked.length, 1);
  assert.match(unlinked[0], /GET \/api\/nothing\tserver\/app\.test\.ts:10/);
});

test("命名規則に反する書き方を、違反として示す", () => {
  const bad = HONO + DB + `
declare const path: string;
export function badRoutes() {
  const router = new Hono();
  router.get("/x", () => 1);
  const app = router;
  app.get(path, () => 1);
  app.get("/dup", () => 1);
  app.get("/dup", () => 2);
  app.route("/m", badRoutes());
  return app;
}
`;
  const badTest = HONO + `
declare const test: (n: string, f: () => void) => void;
declare const app: Hono;
declare const url: string;
declare const m: string;
test("a", async () => {
  await app.request(url);
  await app.request("/dup", { method: m });
  await app.request("/dup");
});
`;
  const { findings } = mapOf(repoOf({ "server/app.ts": bad, "server/app.test.ts": badTest }));
  assert.deepEqual(findings.map((f) => `${f.file}:${f.line} ${f.rule}`), [
    "server/app.test.ts:8 uc-test-request",
    "server/app.test.ts:9 uc-test-request",
    "server/app.ts:6 uc-app-name",
    "server/app.ts:9 uc-route-literal",
    "server/app.ts:11 uc-route-duplicate",
  ]);
});

test("依頼票に、並んだシンボルにつながる入口だけを、データとテストつきで載せる", () => {
  const repo = repoOf({ "server/app.ts": APP, "server/app.test.ts": TEST });
  // itemsRoutesを対象にすると、その入口が載る。createAppの入口（/health）は載らない。
  const [p] = buildPackets(repo, [{ id: "R1", group: "R1", viewpoint: "q", symbols: ["server/app.ts#itemsRoutes"] }], "HEAD");
  assert.deepEqual(p.usecases.map((u) => u.id), ["GET /api/items", "GET /api/items/new", "GET /api/items/:id", "POST /api/items", "DELETE /api/items/:id"]);
  assert.ok(p.usecases.every((u) => p.steps.some((s) => s.symbol === u.symbol)));
  // saveだけを対象にすると、saveを呼ぶ入口（POST）が、saveの箱へ結び付く。
  const [q] = buildPackets(repo, [{ id: "R1", group: "R1", viewpoint: "q", symbols: ["server/app.ts#save"] }], "HEAD");
  assert.deepEqual(q.usecases.map((u) => [u.id, u.symbol]), [["POST /api/items", "server/app.ts#save"]]);
});

test("usecasesを書かないアプリには、何も付かず、検査も働かない", () => {
  const repo = repoOf({ "server/app.ts": APP.replace("const app = new Hono();\n  app.get(\"/health\"", "const router = new Hono();\n  const app = router;\n  app.get(\"/health\""), "server/app.test.ts": TEST }, null);
  const [p] = buildPackets(repo, [{ id: "R1", group: "R1", viewpoint: "q", symbols: ["server/app.ts#itemsRoutes"] }], "HEAD");
  assert.equal(p.usecases, undefined);
  const r = spawnSync(process.execPath, [BIN, "lint", "--repo", repo], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout);
});

test("inloop lintとinloop usecasesが、違反で終了コード1になる", () => {
  const repo = repoOf({ "server/app.ts": APP.replace("app.route(\"/api/items\", itemsRoutes());", "app.get(\"/api/\" + \"items\", () => 1);"), "server/app.test.ts": TEST });
  const lint = spawnSync(process.execPath, [BIN, "lint", "--repo", repo], { encoding: "utf8" });
  assert.equal(lint.status, 1);
  assert.match(lint.stdout, /uc-route-literal\tserver\/app\.ts:\d+\t.*\t→ 入口の登録は/);
  const list = spawnSync(process.execPath, [BIN, "usecases", "--repo", repo], { encoding: "utf8" });
  assert.equal(list.status, 1);
});

test("inloop usecasesは、入口ごとのデータとテストを出し、テストのない入口も示す", () => {
  const repo = repoOf({ "server/app.ts": APP, "server/app.test.ts": TEST });
  const r = spawnSync(process.execPath, [BIN, "usecases", "--repo", repo], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /DELETE \/api\/items\/:id\tserver\/app\.ts:\d+\n  データ\t書く items\(\*\)\n  テスト\t1件の取得と削除/);
  assert.match(r.stdout, /GET \/health[^\n]*\n  データ\t（読み取れるSQLなし）\n  テスト\t（なし）/);
  assert.match(r.stdout, /ユースケース 6件、テストなし 1件、命名規則の違反 0件/);
});

test("標準のサーバー向けの雛形とscaffoldの生成物は、命名規則に従い、入口にデータとテストが結び付く", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "inloop-home-")));
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "inloop-uc-app-")));
  const env = { ...process.env, INLOOP_HOME: home };
  const run = (cwd, ...a) => spawnSync(process.execPath, [BIN, ...a], { encoding: "utf8", cwd, env });
  assert.equal(run(parent, "new", "app").status, 0);
  const dir = join(parent, "app");
  assert.equal(run(dir, "generate", "scaffold", "task", "title:text", "done:bool", "due:date:optional").status, 0);
  spawnSync("git", ["-C", dir, "add", "-A"]);
  spawnSync("git", ["-C", dir, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "init"]);
  const r = run(dir, "usecases");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /ユースケース 8件、テストなし 1件、命名規則の違反 0件/);
  assert.match(r.stdout, /POST \/api\/tasks\tserver\/routes\/tasks\.ts:\d+\n  データ\t書く tasks\(done, due, title\)\n  テスト\ttasksを作って/);
  assert.equal(run(dir, "lint").status, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "inloop.json"), "utf8")).usecases, SPEC);
});

test("inloop.jsonのusecasesは、形が違えば拒否する", () => {
  assert.throws(() => parseFullConfig(JSON.stringify({ format: 1, boundaries: [], usecases: { routes: ["a"] } }), "x"), /形が不正/);
  assert.throws(() => parseFullConfig(JSON.stringify({ format: 1, boundaries: [], usecases: { routes: ["a"], tests: ["b"], other: 1 } }), "x"), /形が不正/);
  assert.deepEqual(parseFullConfig(JSON.stringify({ format: 1, boundaries: [], usecases: { routes: ["a"], tests: ["b"] } }), "x").usecases, { routes: ["a"], tests: ["b"] });
});
