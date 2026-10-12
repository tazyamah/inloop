import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp, type Note } from "./app.ts";
import { openDb } from "./db.ts";

const json = (method: string, body: unknown) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("メモを追加して一覧で取れる。消すと一覧から消えるが、行は残る（同期のため）", async () => {
  const db = openDb(":memory:");
  const app = createApp(db);
  const created = await app.request("/api/notes", json("POST", { body: "はじめてのメモ" }));
  assert.equal(created.status, 201);
  const list = async () => (await (await app.request("/api/notes")).json()) as Note[];
  const [note] = await list();
  assert.equal(note!.body, "はじめてのメモ");
  assert.match(note!.uid, /^[0-9a-f-]{36}$/);
  assert.equal((await app.request(`/api/notes/${note!.uid}`, { method: "DELETE" })).status, 204);
  assert.deepEqual(await list(), []);
  assert.equal((db.prepare("SELECT deleted, dirty FROM notes WHERE uid = ?").get(note!.uid) as { deleted: number; dirty: number }).deleted, 1);
  assert.equal((await app.request(`/api/notes/${note!.uid}`, { method: "DELETE" })).status, 404);
});

test("空のメモと長すぎるメモは受け付けない", async () => {
  const app = createApp(openDb(":memory:"));
  assert.equal((await app.request("/api/notes", json("POST", { body: " " }))).status, 400);
  assert.equal((await app.request("/api/notes", json("POST", { body: "x".repeat(1001) }))).status, 400);
  assert.equal((await app.request("/api/notes", { method: "POST", body: "壊れた" })).status, 400);
});
