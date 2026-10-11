// サーバーを起動する。build 後は dist/web の画面も配る。
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";

const app = createApp(openDb());
app.use("/*", serveStatic({ root: "./dist/web" }));

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => {
  console.log(`http://127.0.0.1:${port}`);
});
