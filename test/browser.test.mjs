// ブラウザで開く経路（ADR-0010）のHTTPと、回答を待つget_review_result。
import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { appTools, createServer } from "../dist/server/create-server.js";
import { startBrowserUi } from "../dist/server/browser.js";
import { ReviewStore } from "../dist/server/store.js";
import { Targets } from "../dist/server/target.js";

async function setup() {
  const store = new ReviewStore();
  const targets = new Targets({ store });
  const ui = await startBrowserUi(appTools(targets));
  const server = createServer(targets, { browserUrl: (id, repo) => ui.urlFor(id, repo) });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(ct);
  return { store, ui, client, close: async () => { await client.close(); await ui.close(); } };
}

const textOf = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

/** fetchはHostヘッダーを変えられないので、node:httpで送る。 */
function http(url, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const tokenOf = (url) => new URL(url).searchParams.get("t");
const call = (ui, token, name, args, headers = { "content-type": "application/json" }, key = "-") =>
  http(`http://127.0.0.1:${ui.port}/api/${key}/call?t=${token}`, { method: "POST", headers, body: JSON.stringify({ name, arguments: args }) });

test("ブラウザで開く経路では、request_reviewがIDと画面のURLを返す", async () => {
  const { client, close } = await setup();
  try {
    const r = await client.callTool({ name: "request_review", arguments: { reviews: [{ viewpoint: "q1" }, { viewpoint: "q2" }] } });
    const url = r.structuredContent.url;
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/r\/-\/R1\?t=[\w-]{24}$/);
    assert.deepEqual(r.structuredContent.ids, ["R1", "R2"]);
    assert.equal(textOf(r), `R1 R2 pending ${url}`);
    assert.ok(textOf(r).length < 80, "AIの文脈に入るのは短い参照だけ");
  } finally {
    await close();
  }
});

test("画面とUI専用ツールは鍵とHostヘッダーを確かめ、AIのツールは呼べない", async () => {
  const { ui, client, close } = await setup();
  try {
    const r = await client.callTool({ name: "request_review", arguments: { reviews: [{ viewpoint: "q1" }] } });
    const url = r.structuredContent.url;
    const token = tokenOf(url);

    const page = await http(url);
    assert.equal(page.status, 200);
    assert.match(page.headers["content-type"], /^text\/html/);
    assert.equal(page.headers["referrer-policy"], "no-referrer");
    assert.equal((await http(`http://127.0.0.1:${ui.port}/ui/review.html?t=${token}`)).status, 200);

    assert.equal((await http(url.replace(token, "x".repeat(token.length)))).status, 403, "鍵が違う");
    assert.equal((await http(`http://127.0.0.1:${ui.port}/r/-/R1`)).status, 403, "鍵がない");
    assert.equal((await http(url.replace("/r/-/", "/r/0123456789/"))).status, 404, "このプロセスが作っていない対象の印");
    assert.equal((await call(ui, token, "inloop_get_request", { id: "R1" }, undefined, "0123456789")).status, 404);
    assert.equal((await http(url, { headers: { host: `evil.example:${ui.port}` } })).status, 403, "Hostが違う");
    assert.equal((await http(url.replace("127.0.0.1", "localhost"))).status, 200);

    const got = await call(ui, token, "inloop_get_request", { id: "R1" });
    assert.equal(got.status, 200);
    assert.equal(JSON.parse(got.body).structuredContent.packet.id, "R1");

    assert.equal((await call(ui, token, "request_review", { reviews: [{ viewpoint: "x" }] })).status, 404, "AIのツールは呼べない");
    assert.equal((await call(ui, token, "get_review_result", { ids: ["R1"] })).status, 404);
    assert.equal((await call(ui, token, "toString", {})).status, 404);
    assert.equal((await call(ui, token, "inloop_get_request", { id: "R1" }, { "content-type": "text/plain" })).status, 415, "フォーム送信の形は受け付けない");
    assert.equal(JSON.parse((await call(ui, token, "inloop_get_request", {})).body).isError, true, "引数を確かめる");
  } finally {
    await close();
  }
});

test("get_review_resultはwaitで回答を待ち、時間切れなら未回答の依頼を示す", async () => {
  const { ui, client, close } = await setup();
  try {
    const r = await client.callTool({ name: "request_review", arguments: { reviews: [{ viewpoint: "q1" }, { viewpoint: "q2" }] } });
    const token = tokenOf(r.structuredContent.url);

    const timedOut = await client.callTool({ name: "get_review_result", arguments: { ids: ["R1", "R2"], wait: 1 } });
    assert.equal(textOf(timedOut), "R1 pending\nR2 pending");

    const waiting = client.callTool({ name: "get_review_result", arguments: { ids: ["R1", "R2"], wait: 30 } });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const submitted = await call(ui, token, "inloop_submit", { from: "R1", answers: [{ id: "R1", verdict: "hold" }, { id: "R2", verdict: "ask", comment: "なぜ?" }] });
    assert.match(JSON.parse(submitted.body).structuredContent.message, /^\[inloop\] レビュー回答/);
    const started = Date.now();
    assert.equal(textOf(await waiting), 'R1 hold\nR2 ask "なぜ?"');
    assert.ok(Date.now() - started < 5000, "回答が記録されたらすぐ返る");

    // 保留・質問の回答を受け取った後に待つと、人が未回答に戻して答え直すまで待つ。
    assert.equal(textOf(await client.callTool({ name: "get_review_result", arguments: { ids: ["R2"], wait: 1 } })), "no change");
    const again = client.callTool({ name: "get_review_result", arguments: { ids: ["R2"], wait: 30 } });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await call(ui, token, "inloop_reopen", { from: "R1", ids: ["R2"] });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await call(ui, token, "inloop_submit", { from: "R1", answers: [{ id: "R2", verdict: "ok" }] });
    assert.equal(textOf(await again), "R2 ok");

    // waitがなければ、これまでどおり待たずに返す。
    assert.equal(textOf(await client.callTool({ name: "get_review_result", arguments: { ids: ["R9"] } })), "none");
  } finally {
    await close();
  }
});

test("ブラウザで開く経路でも、AIから見えるツール定義は短い", async () => {
  const { client, close } = await setup();
  try {
    const { tools } = await client.listTools();
    const modelTools = tools.filter((t) => !t._meta?.ui?.visibility || t._meta.ui.visibility.includes("model"));
    assert.deepEqual(modelTools.map((t) => t.name).sort(), ["get_review_result", "request_review"]);
    const size = JSON.stringify(modelTools.map((t) => ({ n: t.name, d: t.description, s: t.inputSchema }))).length;
    assert.ok(size < 1500, `model-visible tool definitions are ${size} chars`);
  } finally {
    await close();
  }
});
