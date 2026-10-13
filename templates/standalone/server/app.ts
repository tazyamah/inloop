// サーバー（Hono）。画面からの /api の要求を受ける。
import { Hono } from "hono";
import type { Db } from "./db.ts";
import { backupRoutes } from "./backup.ts";
// inloop:imports

export interface Note { id: number; body: string; created_at: string }

export function createApp(db: Db) {
  const app = new Hono();

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.get("/api/notes", (c) => {
    const notes = db.prepare("SELECT id, body, created_at FROM notes ORDER BY id DESC").all() as unknown as Note[];
    return c.json(notes);
  });

  app.post("/api/notes", async (c) => {
    const input = (await c.req.json().catch(() => null)) as { body?: unknown } | null;
    const body = typeof input?.body === "string" ? input.body.trim() : "";
    if (body === "" || body.length > 1000) return c.json({ error: "body must be 1-1000 characters" }, 400);
    const r = db.prepare("INSERT INTO notes (body) VALUES (?)").run(body);
    return c.json({ id: Number(r.lastInsertRowid) }, 201);
  });

  // データの書き出しと読み込み（バックアップ）。
  app.route("/api/backup", backupRoutes(db));

  // inloop:routes（`inloop generate scaffold`が、ここに /api/<名前> を足す）

  return app;
}
