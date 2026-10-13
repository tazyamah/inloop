// 信頼境界ルールと必須の依頼（ADR-0001、ADR-0022）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { evaluate, loadRules } from "../dist/engine/boundaries.js";
import { buildPackets } from "../dist/engine/build.js";
import { TsProject } from "../dist/engine/project.js";
import { globToRegExp, parseConfig, parseFullConfig } from "../dist/engine/rules.js";
import { checkRequired } from "../dist/server/check.js";
import { createServer } from "../dist/server/create-server.js";
import { ReviewStore } from "../dist/server/store.js";
import { Targets } from "../dist/server/target.js";
import { makeRepo, SYMBOL } from "./helpers.mjs";

process.env.INLOOP_HOME = mkdtempSync(join(tmpdir(), "inloop-home-"));
const CLI = fileURLToPath(new URL("../bin/inloop", import.meta.url));

const commit = (repo) => {
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "c"]);
};
const write = (repo, file, lines) => {
  mkdirSync(join(repo, file, ".."), { recursive: true });
  writeFileSync(join(repo, file), Array.isArray(lines) ? `${lines.join("\n")}\n` : lines);
};
const config = (boundaries) => JSON.stringify({ format: 1, boundaries }, null, 2);
const hitsOf = (repo, range = "HEAD") => {
  const project = new TsProject(repo);
  try {
    return evaluate(project, repo, range, loadRules(repo, range)).map((h) => `${h.symbol} ${h.rules.join(",")}`);
  } finally {
    project.close();
  }
};

const RULES = [
  { id: "exec", question: "外部コマンドの引数は安全か", match: [{ import: "node:child_process" }] },
  { id: "fsw", question: "書き込む場所は決まっているか", match: [{ import: "fs", names: ["writeFileSync"] }] },
  { id: "env", question: "秘密情報を漏らしていないか", match: [{ global: "process.env" }] },
  { id: "net", question: "送り先は決まっているか", match: [{ global: "fetch" }] },
  { id: "db", question: "書く値は検証済みか", match: [{ symbols: ["src/db.ts#Db"] }] },
  { id: "auth", question: "認証を迂回できないか", match: [{ files: ["src/auth/**"] }] },
  { id: "assets", question: "設定の値は妥当か", match: [{ files: ["config/*.yml"] }] },
];

/** ルールを入れたリポジトリ。基点にはルールと、型Dbだけがある。 */
function ruled(rules = RULES) {
  const repo = makeRepo("ruled");
  write(repo, "inloop.json", config(rules));
  write(repo, "src/db.ts", ["export type Db = { run(sql: string): void };"]);
  commit(repo);
  return repo;
}

test("inloop.jsonは形の全体を確かめ、知らない項目や組み込みのidを拒否する", () => {
  const ok = { id: "a", question: "q", match: [{ import: "m" }] };
  assert.deepEqual(parseConfig(config([ok]), "inloop.json").map((r) => r.id), ["a"]);
  const cases = [
    ["{", /JSONとして読めない/],
    [JSON.stringify({ format: 2, boundaries: [] }), /形が不正（format）/],
    [JSON.stringify({ format: 1, boundaries: [], inloop: "1" }), /形が不正/],
    [config([{ ...ok, extra: 1 }]), /形が不正（boundaries.0/],
    [config([{ ...ok, match: [{ import: "m", global: "x" }] }]), /形が不正（boundaries.0.match.0/],
    [config([{ ...ok, match: [{ improt: "m" }] }]), /形が不正（boundaries.0.match.0/],
    [config([{ ...ok, match: [] }]), /形が不正/],
    [config([{ ...ok, question: " " }]), /形が不正/],
    [config([{ ...ok, id: "Upper" }]), /形が不正/],
    [config([ok, ok]), /idが重なっている a/],
    [config([{ ...ok, id: "inloop-config" }]), /組み込みのルール/],
  ];
  for (const [text, re] of cases) assert.throws(() => parseConfig(text, "inloop.json"), re, text);
});

test("globの*は/を含まず、**は任意の深さに当たる", () => {
  assert.ok(globToRegExp("src/**/*.ts").test("src/a.ts"));
  assert.ok(globToRegExp("src/**/*.ts").test("src/x/y/a.ts"));
  assert.ok(!globToRegExp("*.ts").test("src/a.ts"));
  assert.ok(globToRegExp("src/db.ts#*").test("src/db.ts#Db.run"));
  assert.ok(!globToRegExp("src/a.ts").test("src/aXts"));
});

test("import・標準の名前・ファイル・シンボルの当て方で、変わった宣言と最上位の文に当てる", () => {
  const repo = ruled();
  write(repo, "src/run.ts", [
    "import { execFileSync as run } from \"node:child_process\";",
    "import * as fs from \"node:fs\";",
    "import type { Db } from \"./db.js\";",
    "export function a() { return run(\"ls\"); }",
    "export function b() { fs.writeFileSync(\"x\", \"y\"); }",
    "export function c() { return fs.readFileSync(\"x\"); }",
    "export function d() { return process[\"env\"].HOME; }",
    "export function e(fetch: (u: string) => void) { fetch(\"u\"); }",
    "export function f() { return fetch(\"https://example.com\"); }",
    "export function g(db: Db) { return db; }",
    "export async function h() { return import(\"node:child_process\"); }",
    "export function plain(o: { fetch: number; process: number }) { return o.fetch + o.process; }",
    "console.log(process.env.X);",
  ]);
  write(repo, "src/auth/login.ts", ["export function login() { return true; }"]);
  write(repo, "config/app.yml", ["key: 1"]);
  assert.deepEqual(hitsOf(repo), [
    "config/app.yml assets",
    "src/auth/login.ts auth",
    "src/run.ts#a exec",
    "src/run.ts#b fsw",
    "src/run.ts#d env",
    "src/run.ts#f net",
    "src/run.ts#g db",
    "src/run.ts#h exec",
    "src/run.ts env",
  ]);
});

test("変わっていない宣言と、ルールに当たらない変更には当てない", () => {
  const repo = ruled();
  write(repo, "src/env.ts", ["export function key() { return process.env.KEY; }", "export function other() { return 1; }"]);
  commit(repo);
  assert.deepEqual(hitsOf(repo), []);
  write(repo, "src/env.ts", ["export function key() { return process.env.KEY; }", "export function other() { return 2; }"]);
  assert.deepEqual(hitsOf(repo), [], "変わったのはルールに当たらない宣言だけ");
  write(repo, "src/env.ts", ["export function key() { return process.env.KEY2; }", "export function other() { return 2; }"]);
  assert.deepEqual(hitsOf(repo), ["src/env.ts#key env"]);
});

test("クラスのメソッドを変えたら、クラスではなくメソッドに当てる", () => {
  const repo = ruled();
  write(repo, "src/svc.ts", ["export class Svc {", "  key() { return 1; }", "}"]);
  commit(repo);
  write(repo, "src/svc.ts", ["export class Svc {", "  key() { return process.env.KEY; }", "}"]);
  assert.deepEqual(hitsOf(repo), ["src/svc.ts#Svc.key env"]);
});

test("消したファイルは、filesに当たれば単位にし、依頼票には基点の中身を示す", () => {
  const repo = ruled();
  write(repo, "config/app.yml", ["key: 1"]);
  commit(repo);
  rmSync(join(repo, "config/app.yml"));
  assert.deepEqual(hitsOf(repo), ["config/app.yml assets"]);
  const [p] = buildPackets(repo, [{ id: "R1", group: "R1", viewpoint: "q", symbols: ["config/app.yml"] }], "HEAD");
  assert.deepEqual(p.steps.map((s) => [s.symbol, s.code]), [["HEAD:config/app.yml", "key: 1"]]);
});

test("inloop.jsonを変えると組み込みのルールが当たり、基点で消したルールもその範囲では働く", () => {
  const repo = ruled();
  // AIがルールexecを消して、外部コマンドを使う関数を足した。
  write(repo, "inloop.json", config(RULES.filter((r) => r.id !== "exec")));
  write(repo, "src/sh.ts", ["import { exec } from \"node:child_process\";", "export function sh() { exec(\"ls\"); }"]);
  assert.deepEqual(hitsOf(repo), ["inloop.json inloop-config", "src/sh.ts#sh exec"]);
  const [p] = buildPackets(repo, [{ id: "R1", group: "R1", viewpoint: "q", symbols: ["inloop.json"] }], "HEAD");
  assert.deepEqual(p.steps.map((s) => s.symbol), ["HEAD:inloop.json", "inloop.json"], "消した行が見えるよう、基点の中身も並べる");
  assert.ok(p.steps[0].code.includes("\"exec\""));
  assert.ok(!p.steps[1].code.includes("\"exec\""));
  // inloop.jsonを消しても当たる。
  rmSync(join(repo, "inloop.json"));
  assert.deepEqual(hitsOf(repo), ["inloop.json inloop-config", "src/sh.ts#sh exec"]);
  // 形が合わないinloop.jsonは、依頼票を作らずに拒否する。
  write(repo, "inloop.json", "{");
  assert.throws(() => hitsOf(repo), /inloop.json: JSONとして読めない/);
});

test("inloop.jsonがなければ、ルールは組み込みのものだけになる", () => {
  const repo = makeRepo("plain", { commit: true });
  write(repo, "src/env.ts", ["export function key() { return process.env.KEY; }"]);
  assert.deepEqual(hitsOf(repo), []);
});

// --- MCPサーバーとの組み合わせ ---

async function connect() {
  const server = createServer(new Targets({}));
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(ct);
  return client;
}
const textOf = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

test("request_reviewで、ルールに当たった単位ごとに必須の依頼が同じまとまりに加わる", async () => {
  const repo = ruled();
  write(repo, "src/env.ts", ["export function key() { return process.env.KEY; }"]);
  const client = await connect();
  const call = (args) => client.callTool({ name: "request_review", arguments: { repo, ...args } });
  const r = await call({ reviews: [{ viewpoint: "q", symbols: [SYMBOL] }] });
  assert.equal(textOf(r), "R1 R2 pending required:R2");
  assert.deepEqual(r.structuredContent, { ids: ["R1", "R2"], required: ["R2"] });
  const got = await client.callTool({ name: "inloop_get_request", arguments: { id: "R2", repo } });
  const p = got.structuredContent.packet;
  assert.equal(p.kind, "required");
  assert.deepEqual(p.triggeredBy, ["env"]);
  assert.equal(p.viewpoint, "秘密情報を漏らしていないか", "観点はAIではなくルールの問い");
  assert.deepEqual(p.requestedSymbols, ["src/env.ts#key"]);
  assert.equal(p.group, "R1");
  assert.deepEqual(p.steps.map((s) => [s.symbol, s.boundaries]), [["src/env.ts#key", ["env"]]]);
  assert.equal((await client.callTool({ name: "inloop_get_request", arguments: { id: "R1", repo } })).structuredContent.packet.kind, "optional");

  // コードが同じなら作り直さない（状態は問わない）。
  assert.equal(textOf(await call({ reviews: [{ viewpoint: "q2", symbols: [SYMBOL] }] })), "R3 pending");
  // コードが変われば、その系列の再依頼になる。
  write(repo, "src/env.ts", ["export function key() { return process.env.KEY2; }"]);
  assert.equal(textOf(await call({ reviews: [] })), "R2-1 pending required:R2-1");
  // 当たる変更がなく、AIの依頼もなければ、何も記録しない。
  const none = await call({ reviews: [] });
  assert.equal(none.isError, true);
  assert.match(textOf(none), /依頼がない/);
  assert.equal(readFileSync(join(repo, ".inloop", "reviews.jsonl"), "utf8").trimEnd().split("\n").length, 4);
});

test("必須の系列への再依頼は、種別・対象・観点を引き継ぎ、AIは変えられない", async () => {
  const repo = ruled();
  write(repo, "src/env.ts", ["export function key() { return process.env.KEY; }"]);
  const client = await connect();
  const call = (args) => client.callTool({ name: "request_review", arguments: { repo, ...args } });
  assert.equal(textOf(await call({ reviews: [] })), "R1 pending required:R1");
  for (const item of [{ follows: "R1", symbols: [SYMBOL] }, { follows: "R1", viewpoint: "もう見なくてよい" }]) {
    const r = await call({ reviews: [item] });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /必須の依頼の(対象|観点)は変えられない/);
  }
  write(repo, "src/env.ts", ["export function key() { return process.env.KEY2; }"]);
  // AIの再依頼とエンジンの再依頼が重ならず、1件だけになる。
  assert.equal(textOf(await call({ reviews: [{ follows: "R1" }] })), "R1-1 pending required:R1-1");
  const p = (await client.callTool({ name: "inloop_get_request", arguments: { id: "R1-1", repo } })).structuredContent.packet;
  assert.equal(p.kind, "required");
  assert.deepEqual(p.triggeredBy, ["env"]);
  assert.ok(p.steps[0].code.includes("KEY2"), "今のコードで作り直す");
  // 会話からは承認できない（ADR-0017）。
  const said = await client.callTool({ name: "answer_review", arguments: { ids: ["R1-1"], verdict: "ok", said: "承認", repo } });
  assert.equal(said.isError, true);
});

test("承認済みの必須の依頼の再依頼は、コードが同じで指摘のなかったシンボルをpriorで畳む（ADR-0029）", async () => {
  const repo = ruled();
  const file = (a) => [`export function one() { return fmt(process.env.${a}); }`, "export function fmt(v: string | undefined) { return String(v); }"];
  write(repo, "src/env.ts", file("A"));
  const client = await connect();
  const call = (args) => client.callTool({ name: "request_review", arguments: { repo, ...args } });
  assert.equal(textOf(await call({ reviews: [] })), "R1 pending required:R1");
  const first = (await client.callTool({ name: "inloop_get_request", arguments: { id: "R1", repo } })).structuredContent.packet;
  assert.equal(first.prior, undefined);
  // 回答の前の再依頼も、同じコードは畳む（ADR-0033）。
  write(repo, "src/env.ts", file("A2"));
  assert.equal(textOf(await call({ reviews: [] })), "R1-1 pending required:R1-1");
  const unanswered = (await client.callTool({ name: "inloop_get_request", arguments: { id: "R1-1", repo } })).structuredContent.packet;
  assert.deepEqual(unanswered.prior, { id: "R1", same: ["src/env.ts#fmt"] });
  // R1-1を承認してから、oneだけ変える（fmtは同じ）。
  await client.callTool({ name: "inloop_submit", arguments: { from: "R1-1", answers: [{ id: "R1-1", verdict: "ok" }], repo } });
  write(repo, "src/env.ts", file("A3"));
  assert.equal(textOf(await call({ reviews: [{ follows: "R1-1" }] })), "R1-2 pending required:R1-2");
  const again = (await client.callTool({ name: "inloop_get_request", arguments: { id: "R1-2", repo } })).structuredContent.packet;
  assert.equal(again.kind, "required");
  assert.deepEqual(again.prior, { id: "R1-1", same: ["src/env.ts#fmt"] });
});

test("必須の依頼は、行数の上限で断らない", async () => {
  const repo = ruled();
  const body = Array.from({ length: 80 }, (_, i) => `  const v${i} = process.env.K${i};`);
  write(repo, "src/big.ts", ["export function big() {", ...body, "}"]);
  writeFileSync(join(process.env.INLOOP_HOME, "config.json"), JSON.stringify({ maxReviewLines: 10 }));
  try {
    const client = await connect();
    const r = await client.callTool({ name: "request_review", arguments: { repo, reviews: [] } });
    assert.equal(textOf(r), "R1 pending required:R1");
  } finally {
    rmSync(join(process.env.INLOOP_HOME, "config.json"));
  }
});

test("inloop checkは、依頼がない・承認されていない・承認後に変わった単位を示して失敗する", async () => {
  const repo = ruled();
  write(repo, "src/env.ts", ["export function key() { return process.env.KEY; }"]);
  const file = join(repo, ".inloop", "reviews.jsonl");
  const brief = () => checkRequired(repo, "HEAD", new ReviewStore({ file })).map((l) => `${l.state} ${l.id ?? "-"} ${l.symbol} ${l.rules}`);
  const cli = () => spawnSync(process.execPath, [CLI, "check", "--repo", repo], { encoding: "utf8", env: { ...process.env } });

  let r = cli();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^missing\t-\tsrc\/env.ts#key\tenv$/m);
  const client = await connect();
  await client.callTool({ name: "request_review", arguments: { repo, reviews: [] } });
  assert.deepEqual(brief(), ["pending R1 src/env.ts#key env"]);
  await client.callTool({ name: "inloop_submit", arguments: { from: "R1", repo, answers: [{ id: "R1", verdict: "ok" }] } });
  assert.deepEqual(brief(), ["ok R1 src/env.ts#key env"]);
  r = cli();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /すべて承認済み（1件）/);
  write(repo, "src/env.ts", ["export function key() { return process.env.KEY2; }"]);
  assert.deepEqual(brief(), ["changed R1 src/env.ts#key env"]);
  assert.equal(cli().status, 1);
  // ルールに当たる変更がなければ成功する。
  const clean = ruled();
  r = spawnSync(process.execPath, [CLI, "check", "--repo", clean], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("雛形とinloop自身のinloop.jsonは、形が合っている", () => {
  for (const file of ["inloop.json", "templates/server/inloop.json", "templates/desktop/inloop.json", "templates/standalone/inloop.json", "templates/sync/inloop.json"]) {
    const rules = parseConfig(readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), "utf8"), file);
    assert.ok(rules.length > 0, file);
  }
});

test("雛形のinloop.jsonには、スキーマ変更に当たるtableのルールがある", () => {
  for (const file of ["templates/server/inloop.json", "templates/desktop/inloop.json", "templates/standalone/inloop.json", "templates/sync/inloop.json"]) {
    const rules = parseConfig(readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), "utf8"), file);
    const rule = rules.find((r) => r.id === "db-schema");
    assert.deepEqual(rule?.match, [{ table: "*", access: ["schema"] }], file);
  }
});

test("レイヤーは依頼票のlayerに入り、最初に当たったものを使う。当たらなければ空", () => {
  const repo = makeRepo("layers");
  write(repo, "src/db.ts", ["export type Db = { run(sql: string): void };"]);
  write(repo, "inloop.json", JSON.stringify({
    format: 1,
    boundaries: [],
    layers: [{ id: "DB", files: ["src/db.ts"] }, { id: "src", files: ["src/**"] }],
  }));
  commit(repo);
  write(repo, "src/other.ts", ["export const x = 1;"]);
  const packets = buildPackets(repo, [
    { id: "R1", group: "R1", viewpoint: "q", symbols: ["src/db.ts#Db"] },
    { id: "R2", group: "R1", viewpoint: "q", symbols: ["src/other.ts#x"] },
  ], "HEAD");
  assert.deepEqual(packets.map((p) => p.steps.map((s) => s.layer)), [["DB"], ["src"]]);
});

test("レイヤーのid重複と、今のinloopより新しいminVersionを拒否する", () => {
  const layer = (id) => ({ id, files: ["a"] });
  const text = (extra) => JSON.stringify({ format: 1, boundaries: [], ...extra });
  assert.throws(() => parseFullConfig(text({ layers: [layer("A"), layer("A")] }), "inloop.json"), /重なっている/);
  assert.throws(() => parseFullConfig(text({ minVersion: "1.0" }), "inloop.json"), /形が不正/);
  assert.equal(parseFullConfig(text({ minVersion: "0.0.1" }), "inloop.json").minVersion, "0.0.1");
  const repo = ruled();
  write(repo, "inloop.json", text({ minVersion: "999.0.0" }));
  assert.throws(() => loadRules(repo, "HEAD"), /999\.0\.0 以上が必要/);
  write(repo, "inloop.json", text({ minVersion: "0.0.0" }));
  // 基点のルールも和に残る（ADR-0022）ので、読めること（拒否されないこと）だけを確かめる。
  assert.equal(loadRules(repo, "HEAD").length, RULES.length);
});
