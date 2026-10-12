// レイヤーの向き（ADR-0027）、テーブルでの信頼境界ルール（ADR-0028）、畳むコードの行数と再依頼の差分（ADR-0029）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate, loadConfig } from "../dist/engine/boundaries.js";
import { buildPackets, reviewLines } from "../dist/engine/build.js";
import { TsProject } from "../dist/engine/project.js";
import { parseFullConfig } from "../dist/engine/rules.js";
import { ReviewStore } from "../dist/server/store.js";
import { makeRepo } from "./helpers.mjs";

process.env.INLOOP_HOME = mkdtempSync(join(tmpdir(), "inloop-home-"));

const commit = (repo) => {
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "c"]);
};
const write = (repo, file, lines) => {
  mkdirSync(join(repo, file, ".."), { recursive: true });
  writeFileSync(join(repo, file), Array.isArray(lines) ? `${lines.join("\n")}\n` : lines);
};
const config = (extra) => JSON.stringify({ format: 1, boundaries: [], ...extra }, null, 2);
const hits = (repo, range = "HEAD") => {
  const project = new TsProject(repo);
  try {
    const c = loadConfig(repo, range);
    return evaluate(project, repo, range, c.rules, c.layerSets);
  } finally {
    project.close();
  }
};
const show = (hs) => hs.map((h) => `${h.symbol} ${h.rules.join(",")}`);

const LAYERS = [
  { id: "db", files: ["src/db.ts"], mayUse: [] },
  { id: "http", files: ["src/http.ts"], mayUse: ["db"] },
  { id: "web", files: ["src/web.ts"], mayUse: [] },
  { id: "free", files: ["src/free.ts"] },
];

function layered() {
  const repo = makeRepo("layered");
  write(repo, "inloop.json", config({ layers: LAYERS }));
  write(repo, "src/db.ts", ["export function load(): number { return 1; }"]);
  write(repo, "src/http.ts", ["import { load } from \"./db.ts\";", "export function handle(): number { return load(); }"]);
  write(repo, "src/web.ts", ["export function view(): number { return 1; }"]);
  write(repo, "src/free.ts", ["export function any(): number { return 1; }"]);
  commit(repo);
  return repo;
}

// --- レイヤーの向き ---

test("mayUseは、定義にないレイヤーを拒否し、組み込みのidをルールに使えない", () => {
  assert.throws(() => parseFullConfig(config({ layers: [{ id: "a", files: ["a"], mayUse: ["b"] }] }), "inloop.json"), /定義にないレイヤー b/);
  const rule = { id: "layer-direction", question: "q", match: [{ global: "x" }] };
  assert.throws(() => parseFullConfig(config({ boundaries: [rule] }), "inloop.json"), /組み込みのルールのid/);
  assert.equal(parseFullConfig(config({ layers: LAYERS }), "inloop.json").layers.length, 4);
});

test("許された向きの使い方は当たらず、許されない向きは必須の依頼になる", () => {
  const repo = layered();
  // http→dbは許されている。変えても当たらない。
  write(repo, "src/http.ts", ["import { load } from \"./db.ts\";", "export function handle(): number { return load() + 1; }"]);
  assert.deepEqual(show(hits(repo)), []);
  // db→httpは、dbのmayUseが空なので違反。
  write(repo, "src/db.ts", ["import { handle } from \"./http.ts\";", "export function load(): number { return handle(); }"]);
  const [h] = hits(repo);
  assert.equal(`${h.symbol} ${h.rules.join(",")}`, "src/db.ts#load layer-direction");
  assert.match(h.question, /レイヤーの向きに反する使い方: db→http/);
});

test("mayUseのないレイヤーとレイヤーのないファイルは検査しない", () => {
  const repo = layered();
  write(repo, "src/free.ts", ["import { view } from \"./web.ts\";", "export function any(): number { return view(); }"]);
  write(repo, "src/loose.ts", ["import { load } from \"./db.ts\";", "export const x = load();"]);
  assert.deepEqual(show(hits(repo)), []);
});

test("基点のmayUseを作業ツリーで緩めても、その範囲では違反として当たる", () => {
  const repo = layered();
  // AIがwebからdbを使えるようにmayUseを緩め、使った。
  const loose = LAYERS.map((l) => (l.id === "web" ? { ...l, mayUse: ["db"] } : l));
  write(repo, "inloop.json", config({ layers: loose }));
  write(repo, "src/web.ts", ["import { load } from \"./db.ts\";", "export function view(): number { return load(); }"]);
  const found = show(hits(repo));
  assert.deepEqual(found, ["inloop.json inloop-config", "src/web.ts#view layer-direction"]);
});

test("最上位の文のレイヤー違反も当たる", () => {
  const repo = layered();
  write(repo, "src/web.ts", ["import { load } from \"./db.ts\";", "console.log(load());", "export function view(): number { return 1; }"]);
  assert.deepEqual(show(hits(repo)), ["src/web.ts layer-direction"]);
});

// --- テーブルでの信頼境界ルール ---

const TABLE_RULE = (extra = {}) => ({ id: "orders-write", question: "ordersへの書き込みは検証済みか", match: [{ table: "Orders", ...extra }] });
function sqlRepo(rules) {
  const repo = makeRepo("tbl");
  write(repo, "inloop.json", config({ boundaries: rules }));
  write(repo, "src/db.ts", [
    "declare const db: { prepare(s: string): { run(): void }; exec(s: string): void };",
    "export function list() { db.prepare(\"SELECT * FROM orders\").all; }",
    "export function save() { db.prepare(\"INSERT INTO orders(id) VALUES (1)\").run(); }",
    "export function other() { db.prepare(\"INSERT INTO notes(id) VALUES (1)\").run(); }",
  ]);
  commit(repo);
  return repo;
}

test("tableの当て方は、テーブル名（大文字小文字を区別しない）と種類で当たる", () => {
  const repo = sqlRepo([TABLE_RULE({ access: ["write"] })]);
  write(repo, "src/db.ts", [
    "declare const db: { prepare(s: string): { run(): void }; exec(s: string): void };",
    "export function list() { db.prepare(\"SELECT * FROM orders WHERE 1\").all; }",
    "export function save() { db.prepare(\"INSERT INTO orders(id) VALUES (2)\").run(); }",
    "export function other() { db.prepare(\"INSERT INTO notes(id) VALUES (2)\").run(); }",
  ]);
  assert.deepEqual(show(hits(repo)), ["src/db.ts#save orders-write"], "読むだけ・別のテーブルには当たらない");
  // accessを省くと、読むSQLにも当たる。
  const any = sqlRepo([TABLE_RULE()]);
  write(any, "src/db.ts", ["declare const db: { prepare(s: string): { run(): void } };", "export function list() { db.prepare(\"SELECT * FROM orders WHERE 1\").all; }"]);
  assert.deepEqual(show(hits(any)), ["src/db.ts#list orders-write"]);
});

test("tableは、SQLを実行する宣言を直接使う宣言にも当たる", () => {
  const repo = sqlRepo([TABLE_RULE({ access: ["write"] })]);
  write(repo, "src/api.ts", ["import { save } from \"./db.ts\";", "export function post() { save(); }"]);
  assert.deepEqual(show(hits(repo)), ["src/api.ts#post orders-write"]);
});

test("動的なSQLを含む単位には、tableの当て方を当て、理由を問いに足す", () => {
  const repo = sqlRepo([TABLE_RULE()]);
  write(repo, "src/dyn.ts", ["declare const db: { prepare(s: string): { run(): void } };", "export function run(t: string) { db.prepare(`DELETE FROM ${t}`).run(); }"]);
  const [h] = hits(repo);
  assert.equal(h.symbol, "src/dyn.ts#run");
  assert.match(h.question, /動的なSQLを含み、触るテーブルを決められない/);
});

test("tableのcolumnsは、その列に触れるSQLだけに当たる（全列と、列を読み取れないスキーマ変更には当てる）", () => {
  const repo = sqlRepo([TABLE_RULE({ columns: ["Status", "paid*"] })]);
  write(repo, "src/db.ts", [
    "declare const db: { prepare(s: string): { run(): void }; exec(s: string): void };",
    "export function a() { db.prepare(\"UPDATE orders SET status = 1\").run(); }",
    "export function b() { db.prepare(\"UPDATE orders SET paid_at = 1\").run(); }",
    "export function c() { db.prepare(\"UPDATE orders SET note = 1\").run(); }",
    "export function d() { db.prepare(\"DELETE FROM orders\").run(); }",
    "export function e() { db.exec(\"ALTER TABLE orders ADD COLUMN x\"); }",
    "export function f() { db.prepare(\"SELECT count(*) FROM orders\").run(); }",
  ]);
  assert.deepEqual(show(hits(repo)), ["src/db.ts#a orders-write", "src/db.ts#b orders-write", "src/db.ts#d orders-write", "src/db.ts#e orders-write"]);
});

test("tableの形が不正なら拒否する", () => {
  const bad = (m) => config({ boundaries: [{ id: "a", question: "q", match: [m] }] });
  assert.throws(() => parseFullConfig(bad({ table: "x", access: ["drop"] }), "inloop.json"), /形が不正/);
  assert.throws(() => parseFullConfig(bad({ table: "x", other: 1 }), "inloop.json"), /形が不正/);
  assert.throws(() => parseFullConfig(bad({ table: "x", columns: [] }), "inloop.json"), /形が不正/);
});

// --- 畳むコードの行数 ---

test("変わっていない依存（畳んで見せるコード）は、行数の上限に数えない", () => {
  const repo = makeRepo("fold", { commit: true });
  write(repo, "src/app.ts", [
    "export function greet(name: string): string {",
    "  const a = name;",
    "  const b = a;",
    "  const c = b;",
    "  return `hello ${c}`;",
    "}",
    "",
    "export function hello(): string {",
    "  return greet(\"world\");",
    "}",
    "",
    "export function bye(): string {",
    "  return greet(\"bye\");",
    "}",
  ]);
  commit(repo);
  write(repo, "src/app.ts", [
    "export function greet(name: string): string {",
    "  const a = name;",
    "  const b = a;",
    "  const c = b;",
    "  return `hello ${c}`;",
    "}",
    "",
    "export function hello(): string {",
    "  return greet(\"world!\");",
    "}",
    "",
    "export function bye(): string {",
    "  return greet(\"bye!\");",
    "}",
  ]);
  const ask = (maxLines) => buildPackets(repo, [{ id: "R1", group: "R1", viewpoint: "q", symbols: ["src/app.ts#hello", "src/app.ts#bye"] }], "HEAD", { maxLines });
  const p = ask(undefined)[0];
  const all = p.steps.reduce((n, s) => n + s.code.split("\n").length, 0);
  assert.equal(all, 12);
  assert.equal(reviewLines(p), 6, "変わっていないgreet（6行）を数えない");
  assert.equal(ask(6).length, 1);
  assert.throws(() => ask(5), /依頼票が6行で、上限の5行を超える/);
});

// --- 再依頼の差分 ---

function followRepo() {
  const repo = makeRepo("follow", { commit: true });
  const store = new ReviewStore({ build: (reviews, range, required) => buildPackets(repo, reviews, range, { required }) });
  return { repo, store };
}
const body = (n, m) => [
  "export function a(): number {", `  return ${n};`, "}", "",
  "export function b(): number {", `  return ${m};`, "}",
];

test("再依頼で、前の依頼と同じコードで指摘の対象でもないシンボルを、priorのsameに入れる", () => {
  const { repo, store } = followRepo();
  write(repo, "src/two.ts", body(1, 2));
  const [first] = store.create([{ viewpoint: "q", symbols: ["src/two.ts#a", "src/two.ts#b"] }], "HEAD");
  assert.equal(first.prior, undefined, "最初の依頼に差分はない");
  store.submit([{ id: first.id, verdict: "fix", ref: "src/two.ts#b#L6", comment: "直す" }], first.id);
  write(repo, "src/two.ts", body(1, 3));
  const [again] = store.create([{ follows: first.id }], "HEAD");
  assert.equal(again.id, "R1-1");
  assert.deepEqual(again.prior, { id: "R1", same: ["src/two.ts#a"] });
});

test("指摘の対象だったシンボルは、コードが同じでも同じ扱いにしない。保留、参照のない指摘、回答なしは全部を見せる", () => {
  for (const [answer, expected] of [
    [{ verdict: "fix", ref: "src/two.ts#a", comment: "c" }, ["src/two.ts#b"]],
    [{ verdict: "fix", comment: "c" }, undefined],
    [{ verdict: "hold" }, undefined],
    [{ verdict: "ok" }, ["src/two.ts#a", "src/two.ts#b"]],
    [undefined, undefined],
  ]) {
    const { repo, store } = followRepo();
    write(repo, "src/two.ts", body(1, 2));
    const [first] = store.create([{ viewpoint: "q", symbols: ["src/two.ts#a", "src/two.ts#b"] }], "HEAD");
    if (answer) store.submit([{ id: first.id, ...answer }], first.id);
    const [again] = store.create([{ follows: first.id }], "HEAD");
    assert.deepEqual(again.prior?.same, expected, JSON.stringify(answer));
  }
});

test("sameのシンボルは行数の上限に数えない。記録の形は、依頼票にないシンボルを拒否する", () => {
  const { repo, store } = followRepo();
  write(repo, "src/two.ts", body(1, 2));
  const [first] = store.create([{ viewpoint: "q", symbols: ["src/two.ts#a", "src/two.ts#b"] }], "HEAD");
  store.submit([{ id: first.id, verdict: "fix", ref: "src/two.ts#b", comment: "c" }], first.id);
  write(repo, "src/two.ts", body(1, 3));
  const [again] = store.create([{ follows: first.id }], "HEAD");
  assert.equal(reviewLines(first), 6);
  assert.equal(reviewLines(again), 3, "前回と同じaの3行を数えない");
  const bad = JSON.stringify({ v: 1, type: "request", at: "t", packet: { ...again, id: "R9", group: "R9", prior: { id: "R1", same: ["nowhere#x"] } } });
  const file = join(mkdtempSync(join(tmpdir(), "inloop-log-")), "reviews.jsonl");
  writeFileSync(file, `${bad}\n`);
  assert.throws(() => new ReviewStore({ file }), /依頼票の形が不正（prior\.same\.0）/);
});

test("tableは、2段先の宣言のSQLにも当たる（ADR-0030）", () => {
  const repo = sqlRepo([TABLE_RULE({ access: ["write"] })]);
  write(repo, "src/svc.ts", ["import { save } from \"./db.ts\";", "export function create() { save(); }"]);
  write(repo, "src/api.ts", ["import { create } from \"./svc.ts\";", "export function post() { create(); }"]);
  assert.deepEqual(show(hits(repo)), ["src/api.ts#post orders-write", "src/svc.ts#create orders-write"]);
});
