// 証拠（ADR-0024）。inloopが実行した検査の結果が、依頼票のevidenceに決定的に入る。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPackets } from "../dist/engine/build.js";
import { parseFullConfig } from "../dist/engine/rules.js";
import { makeRepo, SYMBOL } from "./helpers.mjs";

const CLI = fileURLToPath(new URL("../bin/inloop", import.meta.url));
const NODE = process.execPath;
const config = (evidence) => JSON.stringify({ format: 1, boundaries: [], evidence });
const spec = (id, code, extra = {}) => ({ id, kind: "test", name: `検査${id}`, command: [NODE, "-e", code], ...extra });
const evidenceOf = (repo) => buildPackets(repo, [{ id: "R1", group: "R1", viewpoint: "q", symbols: [SYMBOL] }], "HEAD")[0].evidence;
const run = (repo, ...args) => spawnSync(NODE, [CLI, "evidence", "run", "--repo", repo, ...args], { encoding: "utf8" });

test("設定がなければ証拠は空。設定すると、実行前はmissing（未実行）", () => {
  const repo = makeRepo("ev", { commit: true });
  assert.deepEqual(evidenceOf(repo), []);
  writeFileSync(join(repo, "inloop.json"), config([spec("unit", "process.exit(0)")]));
  assert.deepEqual(evidenceOf(repo), [{ kind: "test", name: "検査unit（未実行）", status: "missing" }]);
});

test("inloop evidence runの結果が、pass・failとして入る。failなら終了コード1", () => {
  const repo = makeRepo("ev", { commit: true });
  writeFileSync(join(repo, "inloop.json"), config([spec("ok", "process.exit(0)"), spec("ng", "process.exit(3)", { kind: "static" })]));
  const r = run(repo);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^pass\tok\t/m);
  assert.match(r.stdout, /^fail\tng\t/m);
  assert.deepEqual(evidenceOf(repo), [
    { kind: "test", name: "検査ok", status: "pass" },
    { kind: "static", name: "検査ng", status: "fail" },
  ]);
  assert.equal(JSON.parse(readFileSync(join(repo, ".inloop", "evidence.json"), "utf8")).results.find((x) => x.id === "ng").exitCode, 3);
  // 指定したidだけ動かし、ほかの結果は残す。
  assert.equal(run(repo, "ok").status, 0);
  assert.equal(evidenceOf(repo)[1].status, "fail");
});

test("コードや設定のコマンドが変わると、前の結果は使わずmissingにする", () => {
  const repo = makeRepo("ev", { commit: true });
  writeFileSync(join(repo, "inloop.json"), config([spec("unit", "process.exit(0)")]));
  assert.equal(run(repo).status, 0);
  assert.equal(evidenceOf(repo)[0].status, "pass");
  writeFileSync(join(repo, "src", "app.ts"), readFileSync(join(repo, "src", "app.ts"), "utf8") + "// edit\n");
  assert.deepEqual(evidenceOf(repo), [{ kind: "test", name: "検査unit（結果が今のコードのものではない）", status: "missing" }]);
  assert.equal(run(repo).status, 0);
  assert.equal(evidenceOf(repo)[0].status, "pass");
  // 追跡していない新しいファイルでも、コマンドの変更でも古くなる。
  writeFileSync(join(repo, "src", "new.ts"), "export const a = 1;\n");
  assert.equal(evidenceOf(repo)[0].status, "missing");
  assert.equal(run(repo).status, 0);
  writeFileSync(join(repo, "inloop.json"), config([spec("unit", "process.exit(1)")]));
  assert.equal(evidenceOf(repo)[0].status, "missing");
});

test("起動できないコマンドはfail。壊れた結果ファイルはmissing", () => {
  const repo = makeRepo("ev", { commit: true });
  writeFileSync(join(repo, "inloop.json"), config([{ id: "x", kind: "test", name: "x", command: ["inloop-no-such-command"] }]));
  assert.equal(run(repo).status, 1);
  assert.equal(evidenceOf(repo)[0].status, "fail");
  writeFileSync(join(repo, ".inloop", "evidence.json"), "{");
  assert.equal(evidenceOf(repo)[0].status, "missing");
});

test("inloop.jsonのevidenceは、形が不正・id重複・知らない項目を拒否する", () => {
  const ok = { id: "a", kind: "test", name: "n", command: ["x"] };
  assert.equal(parseFullConfig(config([ok]), "t").evidence.length, 1);
  for (const bad of [[{ ...ok, command: [] }], [{ ...ok, kind: "lint" }], [ok, ok], [{ ...ok, shell: true }], [{ ...ok, id: "A" }]]) {
    assert.throws(() => parseFullConfig(config(bad), "t"));
  }
  // evidenceのないリポジトリでは、実行を拒否する。
  assert.equal(run(makeRepo("none", { commit: true })).status, 1);
});

test("testsを持つ検査は、そのテストが呼び出すシンボルの依頼票にだけ結果が入る（ADR-0025）", () => {
  const repo = makeRepo("ev", { commit: true });
  writeFileSync(join(repo, "src", "app.test.ts"), "import { hello } from \"./app.js\";\n\nfunction check() {\n  hello();\n}\ncheck();\nhello();\n");
  writeFileSync(join(repo, "inloop.json"), config([spec("unit", "process.exit(0)", { tests: ["src/*.test.ts"] })]));
  assert.equal(run(repo).status, 0);
  const of = (symbols) => buildPackets(repo, [{ id: "R1", group: "R1", viewpoint: "q", symbols }], "HEAD")[0].evidence;
  // helloはテストが呼ぶ。greetはhelloを通してだけ使われ、テストは直接呼ばない。
  assert.deepEqual(of([SYMBOL]), [{ kind: "test", name: "検査unit", status: "pass" }]);
  assert.deepEqual(of(["src/app.ts#greet"]), [{ kind: "test", name: "検査unit（対象のシンボルを参照するテストがない）", status: "missing" }]);
  assert.deepEqual(of([SYMBOL, "src/app.ts#greet"]), [{ kind: "test", name: "検査unit（対象2件のうち1件を参照）", status: "pass" }]);
});
