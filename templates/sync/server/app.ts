// サーバー（Hono）。画面からの /api の要求を受ける。
import { Hono } from "hono";
import type { Db } from "./db.ts";
import type { SyncApi } from "./sync/engine.ts";
// inloop:imports

export interface Note { uid: string; body: string; created_at: number; updated_at: number }

export function createApp(db: Db, now: () => number = Date.now, sync?: SyncApi) {
  const app = new Hono();

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.get("/api/notes", (c) => {
    const notes = db.prepare("SELECT uid, body, created_at, updated_at FROM notes WHERE deleted = 0 ORDER BY created_at DESC").all() as unknown as Note[];
    return c.json(notes);
  });

  app.post("/api/notes", async (c) => {
    const input = (await c.req.json().catch(() => null)) as { body?: unknown } | null;
    const body = typeof input?.body === "string" ? input.body.trim() : "";
    if (body === "" || body.length > 1000) return c.json({ error: "body must be 1-1000 characters" }, 400);
    const uid = crypto.randomUUID();
    const t = now();
    db.prepare("INSERT INTO notes (uid, body, deleted, created_at, updated_at, dirty) VALUES (?, ?, 0, ?, ?, 1)").run(uid, body, t, t);
    sync?.touch();
    return c.json({ uid }, 201);
  });

  app.delete("/api/notes/:uid", (c) => {
    const r = db.prepare("UPDATE notes SET deleted = 1, updated_at = ?, dirty = 1 WHERE uid = ? AND deleted = 0").run(now(), c.req.param("uid"));
    if (r.changes === 0) return c.json({ error: "not found" }, 404);
    sync?.touch();
    return c.body(null, 204);
  });

  // 同期（共有）。中継がなくても、アプリは使える。
  const body = async (c: { req: { json: () => Promise<unknown> } }) => ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() !== "" && v.length <= max ? v.trim() : null);
  const guard = async (fn: () => Promise<unknown>) => {
    try { return { ok: true as const, value: await fn() }; } catch (e) { return { ok: false as const, error: e instanceof Error ? e.message : "error" }; }
  };
  const idle = { state: "unavailable", role: null, members: [], requests: [], joiningDigits: null, alert: null, error: null, pending: 0, lastSyncAt: null };
  app.get("/api/sync", (c) => c.json(sync?.status() ?? idle));
  app.post("/api/sync/create-room", async (c) => {
    const name = text((await body(c)).name, 40);
    if (!sync || !name) return c.json({ error: "invalid name" }, 400);
    const r = await guard(() => sync.createRoom(name));
    return r.ok ? c.json({ ok: true }, 201) : c.json({ error: r.error }, 400);
  });
  app.post("/api/sync/invite", async (c) => {
    if (!sync) return c.json({ error: "sync unavailable" }, 400);
    const r = await guard(() => sync.invite());
    return r.ok ? c.json(r.value, 201) : c.json({ error: r.error }, 400);
  });
  for (const action of ["approve", "reject", "remove"] as const) {
    app.post(`/api/sync/${action}`, async (c) => {
      const id = text((await body(c)).id, 64);
      if (!sync || !id) return c.json({ error: "invalid id" }, 400);
      const r = await guard(() => sync[action](id));
      return r.ok ? c.json({ ok: true }) : c.json({ error: r.error }, 400);
    });
  }
  app.post("/api/sync/join", async (c) => {
    const input = await body(c);
    const code = text(input.code, 64);
    const name = text(input.name, 40);
    if (!sync || !code || !name) return c.json({ error: "invalid code or name" }, 400);
    const r = await guard(() => sync.join(code, name));
    return r.ok ? c.json({ ok: true }) : c.json({ error: r.error }, 400);
  });
  app.post("/api/sync/leave", async (c) => {
    await sync?.leave();
    return c.body(null, 204);
  });

  // inloop:routes（`inloop generate scaffold`が、ここに /api/<名前> を足す）

  return app;
}
