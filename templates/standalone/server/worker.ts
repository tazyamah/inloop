// Web Workerの入口。Hono（createApp）をここで動かし、画面からの要求を app.fetch で処理して返す。
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";
import { storageInfo } from "./sqlite-wasm.ts";

interface Call { id: number; url: string; method: string; headers: [string, string][]; body: string | null }

const ctx = self as unknown as Worker;
let app: ReturnType<typeof createApp>;
let startError: string | null = null;
try {
  app = createApp(openDb("/app.db"));
} catch (e) {
  startError = e instanceof Error ? e.message : String(e);
}

ctx.addEventListener("message", async (e: MessageEvent<Call>) => {
  const { id, url, method, headers, body } = e.data;
  if (startError !== null) {
    ctx.postMessage({ id, status: 500, headers: [["content-type", "application/json"]], body: JSON.stringify({ error: startError }) });
    return;
  }
  const res = await app.fetch(new Request(new URL(url, "http://app.local"), { method, headers, body }));
  ctx.postMessage({ id, status: res.status, headers: [...res.headers], body: await res.text() });
});
ctx.postMessage({ ready: true, storage: startError === null ? storageInfo : `起動できない（${startError}）` });
