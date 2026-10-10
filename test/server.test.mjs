import { test } from "node:test";
import assert from "node:assert/strict";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer, UI_URI } from "../dist/server/create-server.js";

async function connect() {
  const server = createServer();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(ct);
  return client;
}

const textOf = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const visibility = (t) => t._meta?.ui?.visibility;

test("AIから見えるツールとUI専用ツールが分かれている", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.deepEqual(Object.keys(byName).sort(), ["get_review_result", "inloop_get_request", "inloop_submit", "request_review"]);
  for (const t of tools) assert.equal(t._meta?.ui?.resourceUri, UI_URI, t.name);
  assert.deepEqual(visibility(byName.inloop_get_request), ["app"]);
  assert.deepEqual(visibility(byName.inloop_submit), ["app"]);
  assert.ok(visibility(byName.request_review) === undefined || visibility(byName.request_review).includes("model"));
  assert.deepEqual(visibility(byName.get_review_result), ["model"]);
});

test("AIから見えるツール定義の説明文は短い", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  const modelTools = tools.filter((t) => !visibility(t) || visibility(t).includes("model"));
  const size = JSON.stringify(modelTools.map((t) => ({ n: t.name, d: t.description, s: t.inputSchema }))).length;
  assert.ok(size < 1500, `model-visible tool definitions are ${size} chars`);
});

test("request_reviewはIDと状態だけを返し、コードを含まない", async () => {
  const client = await connect();
  const r = await client.callTool({ name: "request_review", arguments: { viewpoint: "キャンセル済みの注文を再度キャンセルした時の扱いでよいか", symbols: ["src/db/orders.ts#cancelOrder"], range: "abc..def" } });
  assert.equal(textOf(r), "R1 pending");
  assert.deepEqual(r.structuredContent, { id: "R1" });
  assert.ok(JSON.stringify(r).length < 300, JSON.stringify(r));
  assert.doesNotMatch(JSON.stringify(r), /UPDATE orders/);
});

test("UI用の取得は理解順の依頼票と受付箱を返す", async () => {
  const client = await connect();
  await client.callTool({ name: "request_review", arguments: { viewpoint: "q1" } });
  await client.callTool({ name: "request_review", arguments: { viewpoint: "q2" } });
  const r = await client.callTool({ name: "inloop_get_request", arguments: { id: "R2" } });
  const { packet, inbox, status } = r.structuredContent;
  assert.equal(packet.id, "R2");
  assert.equal(packet.viewpoint, "q2");
  assert.equal(packet.fixture, true);
  assert.equal(status, "pending");
  assert.deepEqual(packet.steps.map((s) => s.order), [1, 2, 3]);
  assert.deepEqual(inbox.map((i) => i.id), ["R1", "R2"]);
  assert.deepEqual(inbox[0].symbols, packet.steps.map((s) => s.symbol));
  const unknown = await client.callTool({ name: "inloop_get_request", arguments: { id: "R9" } });
  assert.equal(unknown.isError, true);
});

test("回答は1行1件で記録され、AI向けの取得でも同じ形式になる", async () => {
  const client = await connect();
  await client.callTool({ name: "request_review", arguments: { viewpoint: "q1" } });
  await client.callTool({ name: "request_review", arguments: { viewpoint: "q2" } });
  const r = await client.callTool({
    name: "inloop_submit",
    arguments: { answers: [
      { id: "R1", verdict: "ok" },
      { id: "R2", verdict: "fix", ref: "src/db/orders.ts#cancelOrder#L44", comment: "発送済みも409にする" },
    ] },
  });
  assert.equal(r.isError, undefined);
  assert.equal(r.structuredContent.message,
    "[inloop] レビュー回答。fixは修正後にrequest_reviewで差分を再依頼:\nR1 ok\nR2 fix src/db/orders.ts#cancelOrder#L44 \"発送済みも409にする\"");
  assert.deepEqual(r.structuredContent.inbox.map((i) => i.status), ["approved", "fixing"]);
  const g = await client.callTool({ name: "get_review_result", arguments: {} });
  assert.equal(textOf(g), "R1 ok\nR2 fix src/db/orders.ts#cancelOrder#L44 \"発送済みも409にする\"");
});

test("1つの依頼に複数の行コメントを付けられ、行範囲も参照できる", async () => {
  const client = await connect();
  await client.callTool({ name: "request_review", arguments: { viewpoint: "q1" } });
  await client.callTool({ name: "request_review", arguments: { viewpoint: "q2" } });
  const r = await client.callTool({
    name: "inloop_submit",
    arguments: { answers: [
      { id: "R1", verdict: "fix", ref: "src/db/orders.ts#cancelOrder#L43-L44", comment: "SQLは1行にまとめる" },
      { id: "R1", verdict: "ask", ref: "src/api/orders.ts#postCancel#L91", comment: "購読先はどこ?" },
      { id: "R2", verdict: "ask", comment: "全体として妥当?" },
    ] },
  });
  assert.equal(r.isError, undefined, JSON.stringify(r));
  assert.equal(r.structuredContent.message.split("\n").slice(1).join("\n"), [
    'R1 fix src/db/orders.ts#cancelOrder#L43-L44 "SQLは1行にまとめる"',
    'R1 ask src/api/orders.ts#postCancel#L91 "購読先はどこ?"',
    'R2 ask "全体として妥当?"',
  ].join("\n"));
  assert.deepEqual(r.structuredContent.inbox.map((i) => i.status), ["fixing", "answering"]);
  const g = await client.callTool({ name: "get_review_result", arguments: { ids: ["R2"] } });
  assert.equal(textOf(g), 'R2 ask "全体として妥当?"');
});

test("不正な回答は1行でもあれば全体を拒否する", async () => {
  const client = await connect();
  await client.callTool({ name: "request_review", arguments: { viewpoint: "q1" } });
  await client.callTool({ name: "request_review", arguments: { viewpoint: "q2" } });
  const ok1 = { id: "R1", verdict: "ok" };
  const cases = [
    [ok1, { id: "R2", verdict: "fix" }],
    [ok1, { id: "R2", verdict: "ask", comment: "  " }],
    [ok1, { id: "R2", verdict: "fix", ref: "src/nowhere.ts#x", comment: "c" }],
    [ok1, { id: "R2", verdict: "fix", ref: "src/db/orders.ts#cancelOrder#L40", comment: "表示範囲外" }],
    [ok1, { id: "R2", verdict: "fix", ref: "src/db/orders.ts#cancelOrder#L46-L44", comment: "逆順" }],
    [ok1, { id: "R1", verdict: "hold" }],
    [{ id: "R1", verdict: "ok" }, { id: "R1", verdict: "fix", comment: "承認と同時" }],
    [{ id: "R9", verdict: "ok" }],
  ];
  for (const answers of cases) {
    const r = await client.callTool({ name: "inloop_submit", arguments: { answers } });
    assert.equal(r.isError, true, JSON.stringify(answers));
  }
  const g = await client.callTool({ name: "get_review_result", arguments: {} });
  assert.equal(textOf(g), "none");
  await client.callTool({ name: "inloop_submit", arguments: { answers: [ok1] } });
  const again = await client.callTool({ name: "inloop_submit", arguments: { answers: [{ id: "R1", verdict: "hold" }] } });
  assert.equal(again.isError, true);
});

test("UIリソースはMCP AppsのMIMEで、外部読込を含まない単一HTML", async () => {
  const client = await connect();
  const { contents } = await client.readResource({ uri: UI_URI });
  assert.equal(contents.length, 1);
  assert.equal(contents[0].mimeType, "text/html;profile=mcp-app");
  const html = contents[0].text;
  assert.match(html, /<script type="module">/);
  assert.doesNotMatch(html, /<!--SCRIPT-->/);
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.doesNotMatch(html, /<link[^>]+href=/i);
});
