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
    "[inloop] レビュー回答。fixは修正後にrequest_reviewで差分を再依頼:\nR1 ok\nR2 fix src/db/orders.ts#cancelOrder#L44 \"発送済みも409にする\"");
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
