// ブラウザで開く経路（ADR-0012）と、マシン全体の画面のサーバー（ADR-0013）。
import { test } from "node:test";
import { makeRepo, SYMBOL } from "./helpers.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { AppRegistry } from "../dist/server/apps.js";
import { createServer } from "../dist/server/create-server.js";
import { Targets, TargetError } from "../dist/server/target.js";
import { appOrigin, startUiServer } from "../dist/server/ui-server.js";


/** 登録簿・画面のサーバー・ブラウザの経路のMCPサーバーを、一時的な場所で用意する。 */
async function setup() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "inloop-home-")));
  const registry = new AppRegistry(home);
  const repo = makeRepo("appa");
  registry.register(repo);
  const ui = await startUiServer({ port: 0, registry });
  const server = createServer(new Targets({ repo }), {
    browserBase: async (r) => {
      const name = r && registry.nameOf(r);
      if (!name) throw new TargetError(`${r}: inloop init で登録されていない`);
      return appOrigin(name, ui.port);
    },
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(ct);
  return { home, registry, repo, ui, client, close: async () => { await client.close(); await ui.close(); } };
}

const textOf = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

/** fetchはHostやOriginを変えられないので、node:httpで送る。 */
function http(port, path, { method = "GET", host = `appa.inloop.localhost:${port}`, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { host, ...headers } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const call = (port, name, args, { origin = `http://appa.inloop.localhost:${port}`, type = "application/json", host } = {}) =>
  http(port, "/api/call", {
    method: "POST",
    host,
    headers: { "content-type": type, ...(origin ? { origin } : {}) },
    body: JSON.stringify({ name, arguments: args }),
  });

test("request_reviewは、アプリ名の固定のURLを返す", async () => {
  const { ui, client, close } = await setup();
  try {
    const r = await client.callTool({ name: "request_review", arguments: { reviews: [{ viewpoint: "q1", symbols: [SYMBOL] }, { viewpoint: "q2", symbols: [SYMBOL] }] } });
    const url = `http://appa.inloop.localhost:${ui.port}/r/R1`;
    assert.deepEqual(r.structuredContent, { ids: ["R1", "R2"], url });
    assert.equal(textOf(r), `R1 R2 pending ${url}`);
  } finally {
    await close();
  }
});

test("登録していないリポジトリへの依頼は、記録せずに拒否する", async () => {
  const { home, ui } = await setup();
  const other = makeRepo("other");
  const registry = new AppRegistry(home);
  const server = createServer(new Targets({ repo: other }), {
    browserBase: async (r) => {
      const name = r && registry.nameOf(r);
      if (!name) throw new TargetError(`${r}: inloop init で登録されていない`);
      return appOrigin(name, ui.port);
    },
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(ct);
  try {
    const r = await client.callTool({ name: "request_review", arguments: { reviews: [{ viewpoint: "q", symbols: [SYMBOL] }] } });
    assert.equal(r.isError, true);
    assert.equal(textOf(r), `${other}: inloop init で登録されていない`);
    assert.ok(!existsSync(join(other, ".inloop", "reviews.jsonl")));
  } finally {
    await client.close();
    await ui.close();
  }
});

test("画面のサーバーは、登録したアプリのHostと、同じ画面からの書き込みだけを受け付ける", async () => {
  const { ui, client, close } = await setup();
  const port = ui.port;
  try {
    await client.callTool({ name: "request_review", arguments: { reviews: [{ viewpoint: "q1", symbols: [SYMBOL] }] } });
    const page = await http(port, "/r/R1");
    assert.equal(page.status, 200);
    assert.match(page.headers["content-type"], /^text\/html/);
    assert.equal(page.headers["access-control-allow-origin"], undefined, "別のサイトに読ませない");
    assert.equal((await http(port, "/ui/review.html")).status, 200);

    assert.equal((await http(port, "/r/R1", { host: `127.0.0.1:${port}` })).status, 403, "名前でないHost");
    assert.equal((await http(port, "/r/R1", { host: `evil.example:${port}` })).status, 403, "別の名前（DNS rebinding）");
    assert.equal((await http(port, "/r/R1", { host: `appa.inloop.localhost:${port + 1}` })).status, 403, "別のポート");
    assert.equal((await http(port, "/r/R1", { host: `nobody.inloop.localhost:${port}` })).status, 404, "登録していないアプリ");

    const got = await call(port, "inloop_get_request", { id: "R1" });
    assert.equal(got.status, 200);
    assert.equal(JSON.parse(got.body).structuredContent.packet.id, "R1");
    assert.equal((await call(port, "inloop_get_request", { id: "R1" }, { origin: null })).status, 403, "Originのない書き込み");
    assert.equal((await call(port, "inloop_get_request", { id: "R1" }, { origin: "https://evil.example" })).status, 403, "別のサイトからの書き込み");
    assert.equal((await call(port, "inloop_get_request", { id: "R1" }, { origin: `http://other.inloop.localhost:${port}` })).status, 403, "別のアプリの画面からの書き込み");
    assert.equal((await call(port, "inloop_get_request", { id: "R1" }, { type: "text/plain" })).status, 415, "フォーム送信の形");
    assert.equal((await call(port, "request_review", { reviews: [{ viewpoint: "x" }] })).status, 404, "AIのツールは呼べない");
    assert.equal((await call(port, "get_review_result", { ids: ["R1"] })).status, 404);
    assert.equal((await call(port, "toString", {})).status, 404);
    assert.equal(JSON.parse((await call(port, "inloop_get_request", {})).body).isError, true, "引数を確かめる");

    const health = await http(port, "/_inloop/health", { host: `127.0.0.1:${port}` });
    assert.equal(JSON.parse(health.body).pid, process.pid);
    assert.equal((await http(port, "/_inloop/health")).status, 403, "動作確認は127.0.0.1の宛先だけ");
  } finally {
    await close();
  }
});

test("画面のサーバーは、MCPサーバーが書いた記録をその都度読み、回答を記録する", async () => {
  const { ui, client, close } = await setup();
  const port = ui.port;
  try {
    await client.callTool({ name: "request_review", arguments: { reviews: [{ viewpoint: "q1", symbols: [SYMBOL] }, { viewpoint: "q2", symbols: [SYMBOL] }] } });
    const timedOut = await client.callTool({ name: "get_review_result", arguments: { ids: ["R1", "R2"], wait: 1 } });
    assert.equal(textOf(timedOut), "R1 pending\nR2 pending");

    const waiting = client.callTool({ name: "get_review_result", arguments: { ids: ["R1", "R2"], wait: 30 } });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const submitted = await call(port, "inloop_submit", { from: "R1", answers: [{ id: "R1", verdict: "hold" }, { id: "R2", verdict: "ask", comment: "なぜ?" }] });
    assert.match(JSON.parse(submitted.body).structuredContent.message, /^\[inloop\] レビュー回答/);
    const started = Date.now();
    assert.equal(textOf(await waiting), 'R1 hold\nR2 ask "なぜ?"');
    assert.ok(Date.now() - started < 5000, "回答が記録されたらすぐ返る");

    // 保留・質問の回答を受け取った後に待つと、人が未回答に戻して答え直すまで待つ。
    assert.equal(textOf(await client.callTool({ name: "get_review_result", arguments: { ids: ["R2"], wait: 1 } })), "no change");
    const again = client.callTool({ name: "get_review_result", arguments: { ids: ["R2"], wait: 30 } });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await call(port, "inloop_reopen", { from: "R1", ids: ["R2"] });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await call(port, "inloop_submit", { from: "R1", answers: [{ id: "R2", verdict: "ok" }] });
    assert.equal(textOf(await again), "R2 ok");

    assert.equal(textOf(await client.callTool({ name: "get_review_result", arguments: { ids: ["R9"] } })), "none");
  } finally {
    await close();
  }
});

test("登録簿は名前の重なりを拒否し、同じリポジトリの登録し直しで古い名前を消す", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "inloop-home-")));
  const registry = new AppRegistry(home);
  const a = makeRepo("My App");
  const b = makeRepo("my-app");
  assert.deepEqual(registry.register(a), { name: "my-app", repo: a });
  assert.throws(() => registry.register(b), /アプリ名「my-app」は .* が使っている/);
  assert.equal(registry.register(b, "other").name, "other");
  assert.throws(() => registry.register(a, "Bad_Name"), /使えない/);
  registry.register(a, "renamed");
  assert.deepEqual(registry.list(), { other: b, renamed: a });
  assert.equal(registry.nameOf(a), "renamed");
  assert.throws(() => registry.register(join(home)), /gitの作業ツリーではない/);
});

test("ブラウザで開く経路でも、AIから見えるツール定義は短い", async () => {
  const { client, close } = await setup();
  try {
    const { tools } = await client.listTools();
    const modelTools = tools.filter((t) => !t._meta?.ui?.visibility || t._meta.ui.visibility.includes("model"));
    assert.deepEqual(modelTools.map((t) => t.name).sort(), ["answer_review", "get_review_result", "request_review"]);
    const size = JSON.stringify(modelTools.map((t) => ({ n: t.name, d: t.description, s: t.inputSchema }))).length;
    // 会話から承認・保留を記録するツール（ADR-0017）を足して、上限を1500から2000にした。
    assert.ok(size < 2000, `model-visible tool definitions are ${size} chars`);
  } finally {
    await close();
  }
});
