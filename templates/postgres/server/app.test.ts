import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";

test("メモを追加して一覧で取れる", async () => {
  const app = createApp(await openDb("memory:"));
  const created = await app.request("/api/notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: "はじめてのメモ" }) });
  assert.equal(created.status, 201);
  const list = (await (await app.request("/api/notes")).json()) as { body: string }[];
  assert.deepEqual(list.map((n) => n.body), ["はじめてのメモ"]);
});

test("空のメモは受け付けない", async () => {
  const app = createApp(await openDb("memory:"));
  const r = await app.request("/api/notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: " " }) });
  assert.equal(r.status, 400);
});
