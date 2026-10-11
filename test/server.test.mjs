import { test } from "node:test";
import assert from "node:assert/strict";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, UI_URI } from "../dist/server/create-server.js";
import { ReviewStore } from "../dist/server/store.js";

async function connect(store) {
  const server = createServer(store);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(ct);
  return client;
}

/** 依頼を1回の呼び出しでまとめて作る。同じ呼び出しの依頼は、まとめて回答できる。 */
const ask = (client, ...viewpoints) =>
  client.callTool({ name: "request_review", arguments: { reviews: viewpoints.map((viewpoint) => ({ viewpoint })) } });
const requestTwo = (client) => ask(client, "q1", "q2");

const textOf = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const visibility = (t) => t._meta?.ui?.visibility;

test("AIから見えるツールとUI専用ツールが分かれている", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.deepEqual(Object.keys(byName).sort(), ["answer_review", "get_review_result", "inloop_get_request", "inloop_reopen", "inloop_submit", "request_review"]);
  for (const t of tools) assert.equal(t._meta?.ui?.resourceUri, UI_URI, t.name);
  assert.deepEqual(visibility(byName.inloop_get_request), ["app"]);
  assert.deepEqual(visibility(byName.inloop_submit), ["app"]);
  assert.deepEqual(visibility(byName.inloop_reopen), ["app"]);
  assert.ok(visibility(byName.request_review) === undefined || visibility(byName.request_review).includes("model"));
  assert.deepEqual(visibility(byName.get_review_result), ["model"]);
  assert.deepEqual(visibility(byName.answer_review), ["model"]);
});

test("AIから見えるツール定義の説明文は短い", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  const modelTools = tools.filter((t) => !visibility(t) || visibility(t).includes("model"));
  const size = JSON.stringify(modelTools.map((t) => ({ n: t.name, d: t.description, s: t.inputSchema }))).length;
  // 会話から承認・保留を記録するツール（ADR-0017）を足して、上限を1500から2000にした。
  assert.ok(size < 2000, `model-visible tool definitions are ${size} chars`);
});

test("request_reviewはIDと状態だけを返し、コードを含まない", async () => {
  const client = await connect();
  const r = await client.callTool({ name: "request_review", arguments: { reviews: [{ viewpoint: "キャンセル済みの注文を再度キャンセルした時の扱いでよいか", symbols: ["src/db/orders.ts#cancelOrder"] }], range: "abc..def" } });
  assert.equal(textOf(r), "R1 pending");
  assert.deepEqual(r.structuredContent, { ids: ["R1"] });
  assert.ok(JSON.stringify(r).length < 300, JSON.stringify(r));
  assert.doesNotMatch(JSON.stringify(r), /UPDATE orders/);
  // 複数の依頼を1回で出すと、IDを並べて返す。
  const many = await ask(client, "q2", "q3", "q4");
  assert.equal(textOf(many), "R2 R3 R4 pending");
  assert.deepEqual(many.structuredContent, { ids: ["R2", "R3", "R4"] });
  // 依頼のない呼び出しや、古い形の引数は受け付けない。
  assert.equal((await client.callTool({ name: "request_review", arguments: { reviews: [] } })).isError, true);
  assert.equal((await client.callTool({ name: "request_review", arguments: { viewpoint: "q" } })).isError, true);
  // 観点のない依頼は、再依頼（follows）でなければ受け付けない。
  const noViewpoint = await client.callTool({ name: "request_review", arguments: { reviews: [{ viewpoint: "q5" }, {}] } });
  assert.equal(noViewpoint.isError, true);
  assert.equal(textOf(await ask(client, "q5")), "R5 pending");
});

test("UI用の取得は理解順の依頼票と受付箱を返す", async () => {
  const client = await connect();
  await requestTwo(client);
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
  await requestTwo(client);
  const r = await client.callTool({
    name: "inloop_submit",
    arguments: { from: "R1", answers: [
      { id: "R1", verdict: "ok" },
      { id: "R2", verdict: "fix", ref: "src/db/orders.ts#cancelOrder#L44", comment: "発送済みも409にする" },
    ] },
  });
  assert.equal(r.isError, undefined);
  assert.equal(r.structuredContent.message,
    "[inloop] レビュー回答。fixは修正後にrequest_reviewのfollowsで再依頼、askは会話で答える:\nR1 ok\nR2 fix src/db/orders.ts#cancelOrder#L44 \"発送済みも409にする\"");
  assert.deepEqual(r.structuredContent.inbox.map((i) => i.status), ["approved", "fixing"]);
  const g = await client.callTool({ name: "get_review_result", arguments: { ids: ["R1", "R2"] } });
  assert.equal(textOf(g), "R1 ok\nR2 fix src/db/orders.ts#cancelOrder#L44 \"発送済みも409にする\"");
});

test("1つの依頼に複数の行コメントを付けられ、行範囲も参照できる", async () => {
  const client = await connect();
  await requestTwo(client);
  const r = await client.callTool({
    name: "inloop_submit",
    arguments: { from: "R1", answers: [
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
  await requestTwo(client);
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
    const r = await client.callTool({ name: "inloop_submit", arguments: { from: "R1", answers } });
    assert.equal(r.isError, true, JSON.stringify(answers));
  }
  const g = await client.callTool({ name: "get_review_result", arguments: { ids: ["R1", "R2"] } });
  assert.equal(textOf(g), "none");
  await client.callTool({ name: "inloop_submit", arguments: { from: "R1", answers: [ok1] } });
  const again = await client.callTool({ name: "inloop_submit", arguments: { from: "R1", answers: [{ id: "R1", verdict: "hold" }] } });
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

const tmpLog = () => join(mkdtempSync(join(tmpdir(), "inloop-test-")), "state", "reviews.jsonl");
const at = () => "2026-10-10T00:00:00.000Z";

test("保存先を指定すると、依頼と回答が再起動後も残る", async () => {
  const file = tmpLog();
  const first = await connect(new ReviewStore({ file, now: at }));
  await first.callTool({ name: "request_review", arguments: { reviews: [{ viewpoint: "q1", symbols: ["src/db/orders.ts#cancelOrder"] }, { viewpoint: "q2" }, { viewpoint: "q3" }], range: "a..b" } });
  const submitted = await first.callTool({
    name: "inloop_submit",
    arguments: { from: "R1", answers: [
      { id: "R2", verdict: "fix", ref: "src/db/orders.ts#cancelOrder#L43-L44", comment: "SQLは1行にまとめる" },
      { id: "R2", verdict: "ask", comment: "全体として妥当?" },
      { id: "R1", verdict: "ok" },
    ] },
  });
  assert.equal(submitted.isError, undefined, JSON.stringify(submitted));
  const before = await first.callTool({ name: "inloop_get_request", arguments: { id: "R1" } });
  await first.close();

  // 別のプロセスで起動し直した場合に相当する。
  const second = await connect(new ReviewStore({ file, now: at }));
  const after = await second.callTool({ name: "inloop_get_request", arguments: { id: "R1" } });
  assert.deepEqual(after.structuredContent, before.structuredContent);
  assert.deepEqual(after.structuredContent.inbox.map((i) => [i.id, i.status]), [["R1", "approved"], ["R2", "fixing"], ["R3", "pending"]]);
  const g = await second.callTool({ name: "get_review_result", arguments: { ids: ["R1", "R2", "R3"] } });
  assert.equal(textOf(g), 'R2 fix src/db/orders.ts#cancelOrder#L43-L44 "SQLは1行にまとめる"\nR2 ask "全体として妥当?"\nR1 ok');
  // 回答済みの依頼には、再起動後も重ねて回答できない。未回答の依頼には回答できる。
  const again = await second.callTool({ name: "inloop_submit", arguments: { from: "R1", answers: [{ id: "R1", verdict: "hold" }] } });
  assert.equal(again.isError, true);
  const r3 = await second.callTool({ name: "inloop_submit", arguments: { from: "R1", answers: [{ id: "R3", verdict: "hold" }] } });
  assert.equal(r3.isError, undefined);
  // 依頼IDは続きから振る。
  // 依頼IDは続きから振る。再起動後の依頼は、再起動前の依頼とは別のまとまりになる。
  const next = await ask(second, "q4");
  assert.equal(textOf(next), "R4 pending");
  const view = await second.callTool({ name: "inloop_get_request", arguments: { id: "R4" } });
  assert.deepEqual(view.structuredContent.inbox.map((i) => i.id), ["R4"]);
});

test("記録は1行1件のJSONで、追記だけを行う", () => {
  const file = tmpLog();
  const store = new ReviewStore({ file, now: at });
  assert.equal(readFileSync(file, "utf8"), "");
  store.create([{ viewpoint: "q1", symbols: [] }], "HEAD");
  const afterRequest = readFileSync(file, "utf8");
  store.submit([{ id: "R1", verdict: "ask", comment: " なぜ? " }], "R1");
  const text = readFileSync(file, "utf8");
  assert.ok(text.startsWith(afterRequest));
  assert.ok(text.endsWith("\n"));
  const events = text.trimEnd().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(events.map((e) => [e.v, e.type, e.at]), [[1, "request", at()], [1, "answer", at()]]);
  assert.equal(events[0].packet.id, "R1");
  assert.deepEqual(events[1].answers, [{ id: "R1", verdict: "ask", comment: "なぜ?" }]);
  // 拒否された回答は記録しない。
  assert.throws(() => store.submit([{ id: "R1", verdict: "ok" }], "R1"));
  assert.equal(readFileSync(file, "utf8"), text);
});

test("同じ記録を使う別のサーバーの依頼と回答が見え、IDが重ならない", () => {
  const file = tmpLog();
  const a = new ReviewStore({ file, now: at });
  const b = new ReviewStore({ file, now: at });
  assert.deepEqual(a.create([{ viewpoint: "qa", symbols: [] }, { viewpoint: "qa2", symbols: [] }], "HEAD").map((p) => p.id), ["R1", "R2"]);
  assert.deepEqual(b.create([{ viewpoint: "qb", symbols: [] }], "HEAD").map((p) => [p.id, p.group]), [["R3", "R3"]]);
  assert.deepEqual(a.create([{ viewpoint: "qa3", symbols: [] }], "HEAD").map((p) => p.id), ["R4"]);
  // 別のサーバーが作った依頼も見え、同じ呼び出しの依頼にはどちらのサーバーからでも回答できる。
  assert.deepEqual(b.inbox("R1").map((i) => i.id), ["R1", "R2"]);
  assert.equal(b.pendingElsewhere("R1"), 2);
  b.submit([{ id: "R1", verdict: "ok" }], "R2");
  assert.equal(a.statusOf("R1"), "approved");
  assert.throws(() => a.submit([{ id: "R1", verdict: "hold" }], "R1"), /回答済み/);
  assert.deepEqual(a.answered(), [{ id: "R1", verdict: "ok" }]);
});

test("読めない記録は推測で補わず、行を示して拒否する", () => {
  const good = (() => {
    const file = tmpLog();
    new ReviewStore({ file, now: at }).create([{ viewpoint: "q", symbols: [] }], "HEAD");
    return readFileSync(file, "utf8");
  })();
  const answer = (id) => JSON.stringify({ v: 1, type: "answer", at: at(), answers: [{ id, verdict: "ok" }] }) + "\n";
  const cases = [
    ["{not json\n", /:2: JSONとして読めない/],
    [JSON.stringify({ v: 2, type: "request", at: at(), packet: {} }) + "\n", /:2: 対応していない版/],
    [JSON.stringify({ v: 1, type: "note", at: at() }) + "\n", /:2: 知らない種類/],
    [JSON.stringify({ v: 1, type: "request", at: at(), packet: { id: "X1" } }) + "\n", /:2: 依頼票の形が不正/],
    [good, /:2: 依頼IDが重複している R1/],
    [answer("R7"), /:2: 存在しない依頼への回答 R7/],
    [answer("R1") + answer("R1"), /:3: 回答済みの依頼への回答 R1/],
    [answer("R1").slice(0, 20), /最後の行が途中で終わっている/],
  ];
  for (const [tail, expected] of cases) {
    const file = tmpLog();
    new ReviewStore({ file });
    writeFileSync(file, good + tail);
    assert.throws(() => new ReviewStore({ file }), expected, tail);
  }
  // 起動後に壊れた場合も、以後の操作を同じ理由で拒否し続ける。
  const file = tmpLog();
  const store = new ReviewStore({ file, now: at });
  store.create([{ viewpoint: "q", symbols: [] }], "HEAD");
  appendFileSync(file, "{not json\n");
  assert.throws(() => store.inbox("x"), /:2: JSONとして読めない/);
  assert.throws(() => store.create([{ viewpoint: "q2", symbols: [] }], "HEAD"), /:2: JSONとして読めない/);
  assert.equal(readFileSync(file, "utf8").split("\n").length, 3);
});

test("保存先を指定しなければ、ファイルを作らずメモリにだけ保持する", () => {
  // 作業ディレクトリに状態ディレクトリがすでにあっても、指定がなければ使わない。
  const before = existsSync(".inloop/reviews.jsonl") ? readFileSync(".inloop/reviews.jsonl", "utf8") : undefined;
  const store = new ReviewStore();
  assert.equal(store.location, undefined);
  assert.equal(store.create([{ viewpoint: "q", symbols: [] }], "HEAD")[0].id, "R1");
  const after = existsSync(".inloop/reviews.jsonl") ? readFileSync(".inloop/reviews.jsonl", "utf8") : undefined;
  assert.equal(after, before);
});

test("受付箱と回答は呼び出しごとに分かれ、別の呼び出しの依頼には回答できない", async () => {
  const client = await connect();
  const call = (name, args) => client.callTool({ name, arguments: args });
  // 会話Aが2件をまとめて、会話Bが1件、会話Aが後からもう1件を出した場合に相当する。
  await ask(client, "Aの1件目", "Aの2件目");
  await ask(client, "Bの1件目");
  await ask(client, "Aが後から出した1件");

  // UIには同じ呼び出しの依頼だけが出て、ほかの未回答は件数だけが分かる。
  const viewA = (await call("inloop_get_request", { id: "R2" })).structuredContent;
  assert.deepEqual(viewA.inbox.map((i) => i.id), ["R1", "R2"]);
  assert.equal(viewA.elsewhere, 2);
  const viewB = (await call("inloop_get_request", { id: "R3" })).structuredContent;
  assert.deepEqual(viewB.inbox.map((i) => i.id), ["R3"]);
  assert.equal(viewB.elsewhere, 3);
  // まとまりを示す値は、依頼票（UI専用）にだけ入る。AIには返さない。
  assert.equal(viewA.packet.group, "R1");
  assert.equal(viewB.packet.group, "R3");

  // 別の呼び出しの依頼への回答を含む送信は、全体を拒否する。
  for (const other of ["R3", "R4"]) {
    const crossed = await call("inloop_submit", { from: "R2", answers: [{ id: "R1", verdict: "ok" }, { id: other, verdict: "ok" }] });
    assert.equal(crossed.isError, true);
    assert.match(textOf(crossed), new RegExp(`${other}: 別に出された依頼`));
  }
  for (const id of ["R1", "R3", "R4"]) assert.equal((await call("inloop_get_request", { id })).structuredContent.status, "pending");
  const unknownFrom = await call("inloop_submit", { from: "R9", answers: [{ id: "R1", verdict: "ok" }] });
  assert.equal(unknownFrom.isError, true);
  const missingFrom = await call("inloop_submit", { answers: [{ id: "R1", verdict: "ok" }] });
  assert.equal(missingFrom.isError, true);

  // 同じ呼び出しの依頼は、どちらの依頼を表示していても、まとめて回答できる。
  const ok = await call("inloop_submit", { from: "R1", answers: [{ id: "R1", verdict: "ok" }, { id: "R2", verdict: "hold" }] });
  assert.equal(ok.isError, undefined, JSON.stringify(ok));
  assert.deepEqual(ok.structuredContent.inbox.map((i) => [i.id, i.status]), [["R1", "approved"], ["R2", "held"]]);
  assert.equal(ok.structuredContent.elsewhere, 2);
  await call("inloop_submit", { from: "R3", answers: [{ id: "R3", verdict: "ask", comment: "Bへの質問" }] });

  // AI向けの取得は、指定したIDの分だけを返す。IDなしでは返さない。
  assert.equal(textOf(await call("get_review_result", { ids: ["R1", "R2"] })), "R1 ok\nR2 hold");
  assert.equal(textOf(await call("get_review_result", { ids: ["R3"] })), 'R3 ask "Bへの質問"');
  assert.equal(textOf(await call("get_review_result", { ids: ["R4"] })), "none");
  assert.equal((await call("get_review_result", {})).isError, true);
  assert.equal((await call("get_review_result", { ids: [] })).isError, true);
});

test("1回の呼び出しの依頼は1回の書き込みで記録され、まとまりは最初の依頼のIDになる", () => {
  const file = tmpLog();
  const store = new ReviewStore({ file, now: at });
  store.create([{ viewpoint: "q1", symbols: [] }], "HEAD");
  const made = store.create([{ viewpoint: "q2", symbols: ["a#b"] }, { viewpoint: "q3", symbols: [] }], "x..y");
  assert.deepEqual(made.map((p) => [p.id, p.group, p.viewpoint, p.range]), [["R2", "R2", "q2", "x..y"], ["R3", "R2", "q3", "x..y"]]);
  assert.deepEqual(made[0].requestedSymbols, ["a#b"]);
  const events = readFileSync(file, "utf8").trimEnd().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(events.map((e) => [e.type, e.packet.id, e.packet.group]), [["request", "R1", "R1"], ["request", "R2", "R2"], ["request", "R3", "R2"]]);
  assert.throws(() => store.create([], "HEAD"), /依頼がない/);
  // 再起動しても、まとまりは変わらない。
  const reloaded = new ReviewStore({ file, now: at });
  assert.deepEqual(reloaded.inbox("R2").map((i) => i.id), ["R2", "R3"]);
  assert.equal(reloaded.pendingElsewhere("R2"), 1);
});

test("まとまりのない古い記録の依頼は、その依頼だけのまとまりとして扱う", () => {
  const file = tmpLog();
  const store = new ReviewStore({ file, now: at });
  store.create([{ viewpoint: "古い依頼1", symbols: [] }, { viewpoint: "古い依頼2", symbols: [] }], "HEAD");
  // ADR-0008より前の形（groupなし）に書き換える。
  const lines = readFileSync(file, "utf8").trimEnd().split("\n").map((l) => {
    const e = JSON.parse(l);
    delete e.packet.group;
    return JSON.stringify(e);
  });
  writeFileSync(file, lines.join("\n") + "\n");
  const reloaded = new ReviewStore({ file, now: at });
  assert.deepEqual([reloaded.get("R1").group, reloaded.get("R2").group], ["R1", "R2"]);
  assert.deepEqual(reloaded.inbox("R1").map((i) => i.id), ["R1"]);
  assert.throws(() => reloaded.submit([{ id: "R2", verdict: "ok" }], "R1"), /別に出された依頼/);
  reloaded.submit([{ id: "R1", verdict: "ok" }], "R1");
  // まとまりの形が不正な記録は拒否する。
  writeFileSync(file, lines.map((l) => { const e = JSON.parse(l); e.packet.group = "x"; return JSON.stringify(e); }).join("\n") + "\n");
  assert.throws(() => new ReviewStore({ file }), /:1: 依頼票の形が不正/);
});

// ---- 状態遷移（ADR-0009） ----

test("再依頼は元のIDに枝番を足したIDになり、元の依頼は再依頼済みになる", async () => {
  const client = await connect();
  const call = (name, args) => client.callTool({ name, arguments: args });
  const view = async (id) => (await call("inloop_get_request", { id })).structuredContent;
  await call("request_review", { reviews: [{ viewpoint: "q1", symbols: ["src/db/orders.ts#cancelOrder"] }, { viewpoint: "q2" }], range: "a..b" });
  await call("inloop_submit", { from: "R1", answers: [
    { id: "R1", verdict: "fix", ref: "src/db/orders.ts#cancelOrder#L44", comment: "発送済みも409にする" },
    { id: "R2", verdict: "ok" },
  ] });

  // AIは、修正後に元のIDを渡して再依頼する。観点と対象は元の依頼から引き継ぐ。戻り値はIDと状態だけ。
  const again = await call("request_review", { reviews: [{ follows: "R1" }, { viewpoint: "q3" }], range: "b..c" });
  assert.equal(textOf(again), "R1-1 R3 pending");
  assert.deepEqual(again.structuredContent, { ids: ["R1-1", "R3"] });
  const next = await view("R1-1");
  assert.deepEqual([next.packet.id, next.packet.group, next.packet.viewpoint, next.packet.range], ["R1-1", "R1-1", "q1", "b..c"]);
  assert.deepEqual(next.packet.requestedSymbols, ["src/db/orders.ts#cancelOrder"]);
  assert.equal(next.status, "pending");
  // 再依頼は新しい呼び出しのまとまりに入る。元の依頼は、元のまとまりに再依頼済みとして残る。
  assert.deepEqual(next.inbox.map((i) => [i.id, i.status]), [["R1-1", "pending"], ["R3", "pending"]]);
  assert.deepEqual((await view("R1")).inbox.map((i) => [i.id, i.status, i.supersededBy]), [["R1", "superseded", "R1-1"], ["R2", "approved", undefined]]);
  // 再依頼のUIには、前回の指摘が出る。
  assert.deepEqual(next.history, [{ id: "R1", answers: [{ id: "R1", verdict: "fix", ref: "src/db/orders.ts#cancelOrder#L44", comment: "発送済みも409にする" }] }]);

  // 再依頼済みの依頼には、元の画面からも新しい画面からも回答できない。
  for (const from of ["R1", "R1-1"]) {
    const r = await call("inloop_submit", { from, answers: [{ id: "R1", verdict: "ok" }] });
    assert.equal(r.isError, true, from);
  }
  assert.match(textOf(await call("inloop_submit", { from: "R1", answers: [{ id: "R1", verdict: "ok" }] })), /R1: 再依頼済み（R1-1に回答する）/);

  // 2回目の再依頼。元の依頼として系列のどのIDを渡しても、最新の依頼を引き継ぐ。観点は書き換えられる。
  await call("inloop_submit", { from: "R1-1", answers: [{ id: "R1-1", verdict: "ask", comment: "なぜ409?" }, { id: "R3", verdict: "hold" }] });
  assert.equal(textOf(await call("request_review", { reviews: [{ follows: "R1", viewpoint: "q1改" }] })), "R1-2 pending");
  const third = await view("R1-2");
  assert.equal(third.packet.viewpoint, "q1改");
  assert.deepEqual(third.history.map((h) => [h.id, h.answers[0].verdict]), [["R1", "fix"], ["R1-1", "ask"]]);
  assert.equal((await view("R1-1")).inbox[0].supersededBy, "R1-2");
  // 未回答のまま再依頼してもよい（依頼票を出し直す）。承認済みの依頼も再依頼できる。
  assert.equal(textOf(await call("request_review", { reviews: [{ follows: "R1-2" }, { follows: "R2" }] })), "R1-3 R2-1 pending");
  assert.equal((await view("R2")).status, "superseded");
  // 新しい依頼の番号は、枝番に関係なく続きから振る。
  assert.equal(textOf(await ask(client, "q4")), "R4 pending");

  await call("inloop_submit", { from: "R1-3", answers: [{ id: "R1-3", verdict: "ok" }] });
  assert.equal(textOf(await call("get_review_result", { ids: ["R1", "R1-1", "R1-3"] })),
    'R1 fix src/db/orders.ts#cancelOrder#L44 "発送済みも409にする"\nR1-1 ask "なぜ409?"\nR1-3 ok');
});

test("不正な再依頼は呼び出し全体を拒否し、何も記録しない", async () => {
  const file = tmpLog();
  const client = await connect(new ReviewStore({ file, now: at }));
  await ask(client, "q1", "q2");
  const before = readFileSync(file, "utf8");
  for (const [reviews, expected] of [
    [[{ viewpoint: "q3" }, { follows: "R9" }], /R9: 存在しない依頼/],
    [[{ follows: "R1-1" }], /R1-1: 存在しない依頼/],
    [[{ follows: "x" }], /x: 存在しない依頼/],
    [[{ follows: "R1" }, { follows: "R1" }], /R1: 同じ依頼への再依頼が重複している/],
    [[{ viewpoint: "q3" }, {}], /観点がない/],
  ]) {
    const r = await client.callTool({ name: "request_review", arguments: { reviews } });
    assert.equal(r.isError, true, JSON.stringify(reviews));
    assert.match(textOf(r), expected);
    assert.ok(textOf(r).length < 100, textOf(r));
  }
  assert.equal(readFileSync(file, "utf8"), before);
  assert.equal(textOf(await ask(client, "q3")), "R3 pending");
});

test("保留中・回答待ちの依頼は、同じ画面から未回答に戻して回答し直せる", async () => {
  const client = await connect();
  const call = (name, args) => client.callTool({ name, arguments: args });
  await ask(client, "q1", "q2", "q3", "q4");
  await ask(client, "別に出した依頼");
  await call("inloop_submit", { from: "R1", answers: [
    { id: "R1", verdict: "hold" },
    { id: "R2", verdict: "ask", comment: "リトライは冪等?" },
    { id: "R3", verdict: "fix", comment: "直して" },
    { id: "R4", verdict: "ok" },
  ] });
  await call("inloop_submit", { from: "R5", answers: [{ id: "R5", verdict: "hold" }] });

  // 修正待ち・承認済み・未回答の依頼、別に出された依頼、存在しない依頼は戻せない。1つでもあれば全体を拒否する。
  for (const [ids, expected] of [
    [["R1", "R3"], /R3: fixingの依頼は未回答に戻せない/],
    [["R4"], /R4: approvedの依頼は未回答に戻せない/],
    [["R1", "R5"], /R5: 別に出された依頼は、この画面から戻せない/],
    [["R1", "R1"], /R1: 重複している/],
    [["R9"], /R9: 存在しない依頼/],
  ]) {
    const r = await call("inloop_reopen", { from: "R1", ids });
    assert.equal(r.isError, true, ids.join());
    assert.match(textOf(r), expected);
  }
  assert.equal((await call("inloop_reopen", { ids: ["R1"] })).isError, true);
  assert.equal((await call("inloop_reopen", { from: "R9", ids: ["R1"] })).isError, true);
  assert.equal((await call("inloop_get_request", { id: "R1" })).structuredContent.status, "held");

  const r = await call("inloop_reopen", { from: "R1", ids: ["R1", "R2"] });
  assert.equal(r.isError, undefined, JSON.stringify(r));
  assert.deepEqual(r.structuredContent.inbox.map((i) => [i.id, i.status]), [["R1", "pending"], ["R2", "pending"], ["R3", "fixing"], ["R4", "approved"]]);
  assert.equal(r.structuredContent.elsewhere, 0);
  // 戻した依頼は未回答なので、もう一度は戻せない。AI向けの取得にも、戻す前の回答は出ない。
  assert.equal((await call("inloop_reopen", { from: "R1", ids: ["R1"] })).isError, true);
  assert.equal(textOf(await call("get_review_result", { ids: ["R1", "R2", "R3"] })), 'R3 fix "直して"');
  // 戻す前の回答は、UIに「これまでの回答」として出る。
  assert.deepEqual((await call("inloop_get_request", { id: "R2" })).structuredContent.history,
    [{ id: "R2", answers: [{ id: "R2", verdict: "ask", comment: "リトライは冪等?" }] }]);

  const answered = await call("inloop_submit", { from: "R1", answers: [{ id: "R2", verdict: "ok" }, { id: "R1", verdict: "ask", comment: "やはり質問" }] });
  assert.equal(answered.isError, undefined, JSON.stringify(answered));
  assert.equal(answered.structuredContent.message.split("\n").slice(1).join("\n"), 'R2 ok\nR1 ask "やはり質問"');
  assert.equal(textOf(await call("get_review_result", { ids: ["R1", "R2", "R3"] })), 'R3 fix "直して"\nR2 ok\nR1 ask "やはり質問"');
  assert.deepEqual((await call("inloop_get_request", { id: "R2" })).structuredContent.history.map((h) => h.answers[0].verdict), ["ask", "ok"]);
});

test("再依頼と、未回答に戻した記録が、再起動後も同じ状態になる", async () => {
  const file = tmpLog();
  const store = new ReviewStore({ file, now: at });
  store.create([{ viewpoint: "q1" }, { viewpoint: "q2" }], "HEAD");
  store.submit([{ id: "R1", verdict: "fix", comment: "直して" }, { id: "R2", verdict: "hold" }], "R1");
  store.reopen(["R2"], "R1");
  store.create([{ follows: "R1" }, { viewpoint: "q3" }], "HEAD");
  store.submit([{ id: "R1-1", verdict: "ok" }], "R1-1");
  const events = readFileSync(file, "utf8").trimEnd().split("\n").map((l) => JSON.parse(l));
  // 版は1のまま。未回答に戻す記録が1種類増え、再依頼は枝番のIDを持つ依頼として記録する。
  assert.deepEqual(events.map((e) => [e.v, e.type, e.packet?.id ?? e.ids ?? e.answers.map((a) => a.id)]), [
    [1, "request", "R1"], [1, "request", "R2"], [1, "answer", ["R1", "R2"]], [1, "reopen", ["R2"]],
    [1, "request", "R1-1"], [1, "request", "R3"], [1, "answer", ["R1-1"]],
  ]);
  assert.deepEqual(events[3], { v: 1, type: "reopen", at: at(), ids: ["R2"] });
  assert.deepEqual([events[4].packet.group, events[5].packet.group], ["R1-1", "R1-1"]);
  // 拒否された操作は記録しない。
  const text = readFileSync(file, "utf8");
  assert.throws(() => store.reopen(["R1"], "R1"), /supersededの依頼は未回答に戻せない/);
  assert.throws(() => store.create([{ follows: "R7" }], "HEAD"), /R7: 存在しない依頼/);
  assert.equal(readFileSync(file, "utf8"), text);

  const reloaded = new ReviewStore({ file, now: at });
  for (const id of ["R1", "R2", "R1-1", "R3"]) {
    assert.equal(reloaded.statusOf(id), store.statusOf(id), id);
    assert.deepEqual(reloaded.get(id), store.get(id), id);
    assert.deepEqual(reloaded.history(id), store.history(id), id);
  }
  assert.deepEqual(["R1", "R2", "R1-1", "R3"].map((id) => reloaded.statusOf(id)), ["superseded", "pending", "approved", "pending"]);
  assert.deepEqual(reloaded.inbox("R1"), store.inbox("R1"));
  assert.deepEqual(reloaded.answered(), store.answered());
  assert.equal(reloaded.pendingElsewhere("R1"), 1);
  // 続きの番号と枝番も同じになる。
  assert.deepEqual(reloaded.create([{ follows: "R1" }, { viewpoint: "q4" }], "HEAD").map((p) => p.id), ["R1-2", "R4"]);
});

test("状態遷移に合わない記録は、行を示して拒否する", () => {
  const file = tmpLog();
  const store = new ReviewStore({ file, now: at });
  store.create([{ viewpoint: "q1" }, { viewpoint: "q2" }], "HEAD");
  store.submit([{ id: "R1", verdict: "hold" }, { id: "R2", verdict: "fix", comment: "c" }], "R1");
  const good = readFileSync(file, "utf8");
  const packet = JSON.parse(good.split("\n")[0]).packet;
  const line = (e) => JSON.stringify({ v: 1, at: at(), ...e }) + "\n";
  const request = (id, extra = {}) => line({ type: "request", packet: { ...packet, id, group: id, ...extra } });
  const reopen = (...ids) => line({ type: "reopen", ids });
  const answer = (id) => line({ type: "answer", answers: [{ id, verdict: "ok" }] });
  const cases = [
    // 未回答に戻せるのは、保留中か回答待ちの依頼だけ。
    [reopen("R2"), /:4: fixingの依頼を未回答に戻している R2/],
    [reopen("R1") + reopen("R1"), /:5: pendingの依頼を未回答に戻している R1/],
    [reopen("R1", "R1"), /:4: 未回答に戻す依頼が重複している/],
    [reopen("R9"), /:4: 存在しない依頼を未回答に戻している R9/],
    [reopen(), /:4: 未回答に戻す依頼の形が不正/],
    [line({ type: "reopen", ids: ["x"] }), /:4: 未回答に戻す依頼の形が不正（0）/],
    // 再依頼は、系列の最新の依頼を、枝番を飛ばさずに引き継ぐ。
    [request("R9-1"), /:4: 存在しない依頼への再依頼 R9-1/],
    [request("R2-2"), /:4: 枝番が連続していない R2-2（最新はR2）/],
    [request("R2-1") + request("R2-1"), /:5: 依頼IDが重複している R2-1/],
    [request("R2-1") + request("R2-3"), /:5: 枝番が連続していない R2-3（最新はR2-1）/],
    [request("R2-0"), /:4: 依頼票の形が不正（id）/],
    [request("R2-1-1"), /:4: 依頼票の形が不正（id）/],
    // 再依頼済みの依頼には回答も、未回答に戻すこともできない。
    [request("R2-1") + answer("R2"), /:5: 再依頼済みの依頼への回答 R2/],
    [request("R1-1") + reopen("R1"), /:5: supersededの依頼を未回答に戻している R1/],
  ];
  for (const [tail, expected] of cases) {
    const f = tmpLog();
    new ReviewStore({ file: f });
    writeFileSync(f, good + tail);
    assert.throws(() => new ReviewStore({ file: f }), expected, tail);
  }
  // 整合する記録は読める。
  const f = tmpLog();
  new ReviewStore({ file: f });
  writeFileSync(f, good + reopen("R1") + answer("R1") + request("R2-1") + request("R2-2") + answer("R2-2"));
  const ok = new ReviewStore({ file: f });
  assert.deepEqual(["R1", "R2", "R2-1", "R2-2"].map((id) => ok.statusOf(id)), ["approved", "superseded", "superseded", "approved"]);
});

test("依頼票は読み込みで形の全体を確かめ、知らない項目は無視する", () => {
  const source = tmpLog();
  new ReviewStore({ file: source, now: at }).create([{ viewpoint: "q", symbols: ["a#b"] }], "HEAD");
  const packet = JSON.parse(readFileSync(source, "utf8")).packet;
  const write = (p) => {
    const f = tmpLog();
    new ReviewStore({ file: f });
    writeFileSync(f, JSON.stringify({ v: 1, type: "request", at: at(), packet: p }) + "\n");
    return f;
  };
  const without = (key) => { const p = structuredClone(packet); delete p[key]; return p; };
  const withStep = (patch) => { const p = structuredClone(packet); Object.assign(p.steps[1], patch); return p; };
  for (const [bad, where] of [
    [without("kind"), "kind"],
    [without("evidence"), "evidence"],
    [without("budget"), "budget"],
    [without("fixture"), "fixture"],
    [{ ...packet, kind: "maybe" }, "kind"],
    [{ ...packet, unresolved: "なし" }, "unresolved"],
    [{ ...packet, requestedSymbols: [1] }, "requestedSymbols.0"],
    [{ ...packet, evidence: [{ kind: "test", name: "t", status: "ok" }] }, "evidence.0.status"],
    [withStep({ code: undefined }), "steps.1.code"],
    [withStep({ startLine: 0 }), "steps.1.startLine"],
    [withStep({ change: "removed" }), "steps.1.change"],
    [withStep({ changedLines: ["1"] }), "steps.1.changedLines.0"],
  ]) {
    assert.throws(() => new ReviewStore({ file: write(bad) }), new RegExp(`:1: 依頼票の形が不正（${where.replaceAll(".", "\\.")}）`), where);
  }
  // 知らない項目（捨てた方式が残したthreadなど）は無視し、UIにも渡さない。
  const extra = structuredClone(packet);
  extra.thread = "T1";
  extra.steps[0].note = "x";
  const store = new ReviewStore({ file: write(extra) });
  assert.deepEqual(store.get("R1"), packet);
});
