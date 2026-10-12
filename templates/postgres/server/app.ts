// サーバー（Hono）。画面からの /api の要求を受ける。
import { Hono } from "hono";
import type { Db } from "./db.ts";

export interface Note { id: string; body: string; created_at: string }

export function createApp(db: Db) {
  const app = new Hono();

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.get("/api/notes", async (c) => {
    const { rows } = await db.query<Note>("SELECT id::text, body, created_at::text FROM notes ORDER BY id DESC");
    return c.json(rows);
  });

  app.post("/api/notes", async (c) => {
    const input = (await c.req.json().catch(() => null)) as { body?: unknown } | null;
    const body = typeof input?.body === "string" ? input.body.trim() : "";
    if (body === "" || body.length > 1000) return c.json({ error: "body must be 1-1000 characters" }, 400);
    const { rows } = await db.query<{ id: string }>("INSERT INTO notes (body) VALUES ($1) RETURNING id::text", [body]);
    return c.json({ id: rows[0]!.id }, 201);
  });

  return app;
}
