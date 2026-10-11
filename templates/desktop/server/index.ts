// サーバーを起動する。build 後は dist/web の画面も配る。
// デスクトップアプリでは、Tauriが同梱したこのサーバーを起動し、PORT と DB_PATH を渡す。
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";

const port = Number(process.env.PORT ?? 8787);
// Honoのミドルウェアは、あとから登録したルートにしか効かない。確認を先に登録した親のアプリに、
// ルートを持つアプリをつなぐ。
const app = new Hono();

// 同じマシンの別のWebページから呼ばれないよう、宛先と送信元を確かめる（inloopの画面のサーバーと同じ考え方）。
// 開発中は画面（vite）が別のポートから /api を転送してくるので、確かめるのはデスクトップアプリのときだけ。
if (process.env.DESKTOP === "1") {
  app.use("*", async (c, next) => {
    const host = c.req.header("host");
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return c.text("forbidden", 403);
    const origin = c.req.header("origin");
    if (c.req.method !== "GET" && origin !== `http://${host}`) return c.text("forbidden origin", 403);
    await next();
  });
}
app.route("/", createApp(openDb()));
app.use("/*", serveStatic({ root: "./dist/web" }));

serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => {
  console.log(`http://127.0.0.1:${port}`);
});
