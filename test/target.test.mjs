// 対象のリポジトリを依頼ごとに決め、記録をリポジトリごとに置く（ADR-0010）。
import { test } from "node:test";
import { makeRepo, SYMBOL } from "./helpers.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../dist/server/create-server.js";
import { Targets } from "../dist/server/target.js";


/** rootsを渡すと、クライアントがその作業フォルダを知らせる。 */
async function connect(options = {}, roots) {
  const server = createServer(new Targets(options));
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "test", version: "0" }, roots ? { capabilities: { roots: { listChanged: true } } } : {});
  if (roots) client.setRequestHandler("roots/list", async () => ({ roots: roots.map((r) => ({ uri: pathToFileURL(r).href })) }));
  await client.connect(ct);
  return client;
}

const textOf = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const ask = (client, repo, viewpoint = "q") =>
  client.callTool({ name: "request_review", arguments: { reviews: [{ viewpoint, symbols: [SYMBOL] }], ...(repo === undefined ? {} : { repo }) } });
const lines = (repo) => readFileSync(join(repo, ".inloop", "reviews.jsonl"), "utf8").trimEnd().split("\n");

test("2つのリポジトリへの依頼は、それぞれの.inloop/に記録され、IDが独立する", async () => {
  const a = makeRepo();
  const b = makeRepo();
  const client = await connect();
  assert.equal(textOf(await ask(client, a)), "R1 pending");
  assert.equal(textOf(await ask(client, b)), "R1 pending");
  assert.equal(textOf(await ask(client, a)), "R2 pending");
  assert.equal(lines(a).length, 2);
  assert.equal(lines(b).length, 1);
  assert.equal(readFileSync(join(a, ".inloop", ".gitignore"), "utf8"), "*\n", "記録をcommitしない");
  assert.ok(!readFileSync(join(a, ".inloop", "reviews.jsonl"), "utf8").includes(a), "記録に対象のパスを書かない（ADR-0014）");
  // 回答の取得も対象ごと
  await client.callTool({ name: "inloop_submit", arguments: { from: "R1", repo: b, answers: [{ id: "R1", verdict: "ok" }] } });
  assert.equal(textOf(await client.callTool({ name: "get_review_result", arguments: { ids: ["R1"], repo: b } })), "R1 ok");
  assert.equal(textOf(await client.callTool({ name: "get_review_result", arguments: { ids: ["R1"], repo: a } })), "none");
});

test("作業ツリーの中の下位のパスは最上位に正規化し、UIには_metaで対象を渡す", async () => {
  const a = makeRepo();
  mkdirSync(join(a, "src", "db"), { recursive: true });
  const client = await connect();
  const r = await ask(client, join(a, "src", "db"));
  assert.equal(textOf(r), "R1 pending");
  assert.ok(existsSync(join(a, ".inloop", "reviews.jsonl")));
  assert.ok(!existsSync(join(a, "src", "db", ".inloop")));
  assert.equal(r._meta["inloop/repo"], a);
  assert.deepEqual(r.structuredContent, { ids: ["R1"] }, "AIに渡るstructuredContentには対象を入れない");
  const got = await client.callTool({ name: "inloop_get_request", arguments: { id: "R1", repo: a } });
  assert.equal(got.structuredContent.packet.id, "R1");
});

test("対象を決められない依頼、gitの作業ツリーの外、相対パスは拒否し、何も記録しない", async () => {
  const notGit = realpathSync(mkdtempSync(join(tmpdir(), "inloop-plain-")));
  const client = await connect();
  for (const [repo, expected] of [
    [undefined, "repo がない"],
    [notGit, `${notGit}: gitの作業ツリーではない`],
    ["relative/path", "relative/path: 絶対パスではない"],
    [join(notGit, "missing"), `${join(notGit, "missing")}: 存在しない`],
  ]) {
    const r = await ask(client, repo);
    assert.equal(r.isError, true);
    assert.equal(textOf(r), expected);
  }
  assert.ok(!existsSync(join(notGit, ".inloop")));
  const ui = await client.callTool({ name: "inloop_get_request", arguments: { id: "R1" } });
  assert.equal(ui.isError, true, "UIも対象なしでは拒否する");
});

test("--repoで固定した対象と違うrepoは拒否し、省略すれば固定した対象を使う", async () => {
  const a = makeRepo();
  const b = makeRepo();
  const client = await connect({ repo: a });
  assert.equal(textOf(await ask(client, undefined)), "R1 pending");
  assert.equal(textOf(await ask(client, a)), "R2 pending");
  const r = await ask(client, b);
  assert.equal(r.isError, true);
  assert.equal(textOf(r), `${b}: --repo と違う対象`);
  assert.ok(!existsSync(join(b, ".inloop")));
});

test("--allowの外の対象は拒否する", async () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "inloop-allow-")));
  const inside = makeRepo(undefined, { dir: join(parent, "app") });
  const outside = makeRepo();
  const client = await connect({ allow: [parent] });
  assert.equal(textOf(await ask(client, inside)), "R1 pending");
  const r = await ask(client, outside);
  assert.equal(textOf(r), `${outside}: --allow の外`);
});

test("クライアントの作業フォルダ（roots）が1つなら、repoを省略できる。外の対象は拒否する", async () => {
  const a = makeRepo();
  const b = makeRepo();
  const client = await connect({}, [a]);
  assert.equal(textOf(await ask(client, undefined)), "R1 pending");
  assert.equal(lines(a).length, 1);
  assert.equal(textOf(await ask(client, b)), `${b}: 作業フォルダの外`);
  // UIも対象を省略できる
  const got = await client.callTool({ name: "inloop_get_request", arguments: { id: "R1" } });
  assert.equal(got.structuredContent.packet.id, "R1");

  const two = await connect({}, [a, b]);
  assert.equal(textOf(await ask(two, undefined)), "repo がない（作業フォルダが複数ある）");
  assert.equal(textOf(await ask(two, b)), "R1 pending");
});

test("記録先を固定した場合（--state-dir）は、対象が決まらなくてもそこに記録する", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "inloop-state-")));
  const a = makeRepo();
  const client = await connect({ stateFile: join(dir, "reviews.jsonl") });
  assert.equal(textOf(await ask(client, undefined)), "R1 pending");
  assert.equal(textOf(await ask(client, a)), "R2 pending");
  assert.equal(readFileSync(join(dir, "reviews.jsonl"), "utf8").trimEnd().split("\n").length, 2);
  assert.ok(!existsSync(join(a, ".inloop")));
});

test("依頼票は対象のリポジトリのコードから作り、再依頼では今のコードで作り直す", async () => {
  const a = makeRepo();
  const client = await connect();
  await ask(client, a);
  const first = await client.callTool({ name: "inloop_get_request", arguments: { id: "R1", repo: a } });
  const steps = first.structuredContent.packet.steps;
  assert.deepEqual(steps.map((s) => s.symbol), ["src/app.ts#greet", "src/app.ts#hello"]);
  assert.equal(first.structuredContent.packet.fixture, false);
  writeFileSync(join(a, "src", "app.ts"), readFileSync(join(a, "src", "app.ts"), "utf8").replace("`hello ${name}`", "`hi ${name}`"));
  const again = await client.callTool({ name: "request_review", arguments: { reviews: [{ follows: "R1" }], repo: a } });
  assert.equal(textOf(again), "R1-1 pending");
  const second = await client.callTool({ name: "inloop_get_request", arguments: { id: "R1-1", repo: a } });
  assert.match(second.structuredContent.packet.steps[0].code, /hi \$\{name\}/);
  assert.deepEqual(second.structuredContent.packet.requestedSymbols, [SYMBOL]);
  // 見つからないシンボルの依頼は、記録しない。
  const bad = await client.callTool({ name: "request_review", arguments: { reviews: [{ viewpoint: "q", symbols: ["src/app.ts#nope"] }], repo: a } });
  assert.equal(textOf(bad), "src/app.ts#nope: 見つからないシンボル");
  assert.equal(lines(a).length, 2);
});
