// 解析エンジン（ADR-0002、ADR-0015）。依頼票の構造を、リポジトリのコードから決定的に組み立てる。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildPackets } from "../dist/engine/build.js";
import { makeRepo } from "./helpers.mjs";

const commit = (repo) => {
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "c"]);
};
const build = (repo, symbols, range = "HEAD") => buildPackets(repo, [{ id: "R1", group: "R1", viewpoint: "q", symbols }], range)[0];
const brief = (p) => p.steps.map((s) => `${s.order} ${s.symbol} ${s.change} ${s.changedLines.join(",")}`);

/** 型・クラス・関数・未解決の呼び出しを含む、小さなプロジェクト。 */
function project() {
  const repo = makeRepo("shop", { commit: true });
  writeFileSync(join(repo, "src", "order.ts"), [
    "export type OrderStatus = \"pending\" | \"shipped\" | \"cancelled\";",
    "",
    "export interface Order {",
    "  id: string;",
    "  status: OrderStatus;",
    "}",
    "",
    "/** 注文の保存先 */",
    "export class OrderRepo {",
    "  private readonly rows = new Map<string, Order>();",
    "  constructor(seed: Order[] = []) {",
    "    for (const o of seed) this.rows.set(o.id, o);",
    "  }",
    "  find(id: string): Order | undefined {",
    "    return this.rows.get(id);",
    "  }",
    "  save(order: Order): void {",
    "    this.rows.set(order.id, order);",
    "  }",
    "}",
    "",
  ].join("\n"));
  writeFileSync(join(repo, "src", "cancel.ts"), [
    "import { type Order, OrderRepo } from \"./order.js\";",
    "",
    "declare const events: any;",
    "",
    "export function canCancel(order: Order): boolean {",
    "  return order.status === \"pending\";",
    "}",
    "",
    "export function cancelOrder(repo: OrderRepo, id: string): boolean {",
    "  const order = repo.find(id);",
    "  if (!order || !canCancel(order)) return false;",
    "  repo.save({ ...order, status: \"cancelled\" });",
    "  events.emit(\"order.cancelled\", id);",
    "  return true;",
    "}",
    "",
    "export function setup(): OrderRepo {",
    "  return new OrderRepo();",
    "}",
    "",
  ].join("\n"));
  commit(repo);
  return repo;
}

test("指定したシンボルと、それが直接使うシンボルを、定義が先になる順に並べる", () => {
  const repo = project();
  const p = build(repo, ["src/cancel.ts#cancelOrder"]);
  assert.deepEqual(p.steps.map((s) => s.symbol), [
    "src/cancel.ts#canCancel",
    "src/order.ts#OrderRepo.find",
    "src/order.ts#OrderRepo.save",
    "src/cancel.ts#cancelOrder",
  ]);
  const last = p.steps.at(-1);
  assert.equal(last.file, "src/cancel.ts");
  assert.equal(last.startLine, 9);
  assert.match(last.code, /^export function cancelOrder\(repo: OrderRepo, id: string\): boolean \{/);
  assert.equal(p.kind, "optional", "信頼境界ルールがないので、必須にはしない");
  assert.equal(p.fixture, false);
  assert.deepEqual(p.evidence, []);
  assert.deepEqual(p.requestedSymbols, ["src/cancel.ts#cancelOrder"]);
});

test("型として参照したクラスは並べず、newはコンストラクターを並べる", () => {
  const repo = project();
  const p = build(repo, ["src/cancel.ts#setup"]);
  assert.deepEqual(p.steps.map((s) => s.symbol), ["src/order.ts#OrderRepo.constructor", "src/cancel.ts#setup"]);
});

test("宣言までたどれない呼び出しは、推測でつながず未解決として示す", () => {
  const repo = project();
  const p = build(repo, ["src/cancel.ts#cancelOrder"]);
  assert.deepEqual(p.unresolved, ["src/cancel.ts:13 events.emit"]);
});

test("範囲の基点からの変更を、行と種類で示す", () => {
  const repo = project();
  assert.deepEqual(brief(build(repo, ["src/cancel.ts#canCancel"])), ["1 src/order.ts#Order unchanged ", "2 src/cancel.ts#canCancel unchanged "]);
  writeFileSync(join(repo, "src", "cancel.ts"), execFileSync("git", ["-C", repo, "show", "HEAD:src/cancel.ts"], { encoding: "utf8" })
    .replace("  return order.status === \"pending\";", "  // 発送前だけ\n  return order.status === \"pending\";")
    .concat("export function refund(id: string): string {\n  return id;\n}\n"));
  const changed = build(repo, ["src/cancel.ts#canCancel", "src/cancel.ts#refund"]);
  assert.deepEqual(brief(changed), ["1 src/order.ts#Order unchanged ", "2 src/cancel.ts#canCancel modified 2", "3 src/cancel.ts#refund added 1,2,3"]);
  assert.equal(changed.budget.changedLines, 4);
  // 範囲の基点を指定すると、そこからの変更になる。
  commit(repo);
  assert.deepEqual(brief(build(repo, ["src/cancel.ts#refund"], "HEAD~1..HEAD")), ["1 src/cancel.ts#refund added 1,2,3"]);
  assert.deepEqual(brief(build(repo, ["src/cancel.ts#refund"], "HEAD")), ["1 src/cancel.ts#refund unchanged "]);
});

test("コミットのないリポジトリでは、すべての行を追加として示す", () => {
  const repo = makeRepo("fresh");
  const p = build(repo, ["src/app.ts#hello"]);
  assert.deepEqual(brief(p), ["1 src/app.ts#greet added 1,2,3", "2 src/app.ts#hello added 1,2,3"]);
});

test("見つからないシンボル、シンボルの指定がない依頼、読めない範囲は、依頼票を作らずに拒否する", () => {
  const repo = project();
  assert.throws(() => build(repo, ["src/cancel.ts#nope", "src/none.ts#x"]), /src\/cancel\.ts#nope: 見つからないシンボル\nsrc\/none\.ts#x: 見つからないシンボル/);
  assert.throws(() => build(repo, []), /R1: 対象のシンボルがない/);
  assert.throws(() => build(repo, ["src/cancel.ts#canCancel"], "nosuch..HEAD"), /nosuch: コミットとして読めない/);
});

test("tsconfig.jsonのないリポジトリは、解析できないとして拒否する", () => {
  const repo = makeRepo("no-config");
  execFileSync("rm", [join(repo, "tsconfig.json")]);
  assert.throws(() => build(repo, ["src/app.ts#hello"]), /tsconfig\.json がない/);
});

test("同じ入力からは、同じ依頼票を作る", () => {
  const repo = project();
  const a = build(repo, ["src/cancel.ts#cancelOrder", "src/order.ts#OrderRepo.save"]);
  const b = build(repo, ["src/cancel.ts#cancelOrder", "src/order.ts#OrderRepo.save"]);
  assert.deepEqual(a, b);
});

test("並べるシンボルの数に上限はなく、直接の依存はすべて並べる", () => {
  const repo = makeRepo("many", { commit: true });
  const fns = Array.from({ length: 15 }, (_, i) => `export function f${i}(): number {\n  return ${i};\n}\n`);
  writeFileSync(join(repo, "src", "many.ts"), `${fns.join("\n")}\nexport function all(): number {\n  return ${fns.map((_, i) => `f${i}()`).join(" + ")};\n}\n`);
  const p = build(repo, ["src/many.ts#all"]);
  assert.equal(p.steps.length, 16);
  assert.equal(p.steps.at(-1).symbol, "src/many.ts#all");
  assert.deepEqual(p.unresolved, []);
});

test("行数の上限を超える依頼は、対象のシンボルが2つ以上なら断り、1つなら受け付ける", () => {
  const repo = project();
  const lines = (p) => p.steps.reduce((n, s) => n + s.code.split("\n").length, 0);
  const both = build(repo, ["src/cancel.ts#cancelOrder", "src/cancel.ts#setup"]);
  const total = lines(both);
  const opts = (maxLines) => buildPackets(repo, [{ id: "R7", group: "R7", viewpoint: "q", symbols: ["src/cancel.ts#cancelOrder", "src/cancel.ts#setup"] }], "HEAD", { maxLines });
  assert.equal(opts(total).length, 1, "ちょうど上限なら受け付ける");
  assert.throws(() => opts(total - 1), new RegExp(`R7: 依頼票が${total}行で、上限の${total - 1}行を超える。対象のシンボルを分けて`));
  const single = buildPackets(repo, [{ id: "R8", group: "R8", viewpoint: "q", symbols: ["src/cancel.ts#cancelOrder"] }], "HEAD", { maxLines: 1 });
  assert.equal(single[0].steps.at(-1).symbol, "src/cancel.ts#cancelOrder", "1つのシンボルは、それ以上小さくできないので受け付ける");
});

test("並べたシンボルどうしの使う関係を、種類とともに依頼票に残す（ADR-0020）", () => {
  const repo = project();
  const p = build(repo, ["src/cancel.ts#cancelOrder", "src/cancel.ts#setup"]);
  assert.deepEqual(p.edges.map((e) => `${e.from} ${e.kind} ${e.to}`), [
    "src/cancel.ts#cancelOrder call src/cancel.ts#canCancel",
    "src/cancel.ts#cancelOrder call src/order.ts#OrderRepo.find",
    "src/cancel.ts#cancelOrder call src/order.ts#OrderRepo.save",
    "src/cancel.ts#setup new src/order.ts#OrderRepo.constructor",
  ]);
  // 依存として並べたものどうしの関係も残す。ただし、それをたどって新しいシンボルを並べはしない。
  const q = build(repo, ["src/cancel.ts#canCancel"]);
  assert.deepEqual(q.edges.filter((e) => e.from === "src/cancel.ts#canCancel"), [{ from: "src/cancel.ts#canCancel", to: "src/order.ts#Order", kind: "type" }]);
  writeFileSync(join(repo, "src", "chain.ts"), "export function c(): number {\n  return 1;\n}\nexport function b(): number {\n  return c();\n}\nexport function a(): number {\n  return b() + c();\n}\n");
  const r = build(repo, ["src/chain.ts#a"]);
  assert.deepEqual(r.steps.map((s) => s.symbol), ["src/chain.ts#c", "src/chain.ts#b", "src/chain.ts#a"]);
  assert.deepEqual(r.edges.map((e) => `${e.from} ${e.to}`), ["src/chain.ts#b src/chain.ts#c", "src/chain.ts#a src/chain.ts#c", "src/chain.ts#a src/chain.ts#b"]);
  for (const x of [p, q, r]) {
    for (const e of x.edges) {
      assert.ok(x.steps.some((s) => s.symbol === e.to), "使われる側は依頼票のシンボル");
      assert.ok([...x.steps, ...x.callers].some((s) => s.symbol === e.from), "使う側は依頼票のシンボルか呼び出し元");
    }
  }
});

test("指定したシンボルと変わったシンボルの呼び出し元を、1段だけ探す（ADR-0021）", () => {
  const repo = project();
  const q = build(repo, ["src/cancel.ts#canCancel"]);
  assert.deepEqual(q.callers.map((c) => `${c.symbol} ${c.startLine}`), ["src/cancel.ts#cancelOrder 9"]);
  assert.match(q.callers[0].code, /^export function cancelOrder/);
  assert.deepEqual(q.edges.filter((e) => e.from === "src/cancel.ts#cancelOrder"), [{ from: "src/cancel.ts#cancelOrder", to: "src/cancel.ts#canCancel", kind: "call" }]);
  // newで使えばコンストラクターの呼び出し元。クラスを含む宣言（OrderRepo自身）は数えない。
  assert.deepEqual(build(repo, ["src/order.ts#OrderRepo.constructor"]).callers.map((c) => c.symbol), ["src/cancel.ts#setup"]);
  // 呼び出し元の呼び出し元はたどらない。並べたシンボル（stepsに入ったもの）は呼び出し元にしない。
  writeFileSync(join(repo, "src", "chain.ts"), "export function c(): number {\n  return 1;\n}\nexport function b(): number {\n  return c();\n}\nexport function a(): number {\n  return b();\n}\n");
  assert.deepEqual(build(repo, ["src/chain.ts#c"]).callers.map((c) => c.symbol), ["src/chain.ts#b"]);
  assert.deepEqual(build(repo, ["src/chain.ts#b"]).callers.map((c) => c.symbol), ["src/chain.ts#a"]);
  // 依存として並べたものでも、変わっていれば呼び出し元を探す。変わっていなければ探さない。
  commit(repo);
  writeFileSync(join(repo, "src", "chain.ts"), "export function c(): number {\n  return 2;\n}\nexport function b(): number {\n  return c();\n}\nexport function a(): number {\n  return b();\n}\nexport function d(): number {\n  return c();\n}\n");
  assert.deepEqual(build(repo, ["src/chain.ts#b"]).callers.map((c) => c.symbol), ["src/chain.ts#a", "src/chain.ts#d"]);
  assert.deepEqual(build(repo, ["src/chain.ts#a"]).callers, []);
});
