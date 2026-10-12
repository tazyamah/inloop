// Web Workerの入口。Hono（createApp）をここで動かし、画面からの要求を app.fetch で処理して返す。
// 同期（sync/engine.ts）も、ここで動かす。他の端末の変更を取り込んだら、画面に知らせる。
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";
import { storageInfo } from "./sqlite-wasm.ts";
import { syncTables } from "./sync-tables.ts";
import { Sync } from "./sync/engine.ts";

interface Call { id: number; url: string; method: string; headers: [string, string][]; body: string | null }

const ctx = self as unknown as Worker;
let app: ReturnType<typeof createApp>;
let sync: Sync | undefined;
let startError: string | null = null;
try {
  const db = openDb("/app.db");
  // 中継のURLは、ビルド時に決める（web/.env.production の VITE_SYNC_URL）。なければ、同期は使えない。
  sync = new Sync(db, { url: import.meta.env.VITE_SYNC_URL, tables: syncTables, onChange: () => ctx.postMessage({ changed: true }) });
  app = createApp(db, Date.now, sync);
  void sync.init();
} catch (e) {
  startError = e instanceof Error ? e.message : String(e);
}

ctx.addEventListener("message", async (e: MessageEvent<Call | { wake: true }>) => {
  if ("wake" in e.data) return sync?.wake();
  const { id, url, method, headers, body } = e.data;
  if (startError !== null) {
    ctx.postMessage({ id, status: 500, headers: [["content-type", "application/json"]], body: JSON.stringify({ error: startError }) });
    return;
  }
  const res = await app.fetch(new Request(new URL(url, "http://app.local"), { method, headers, body }));
  ctx.postMessage({ id, status: res.status, headers: [...res.headers], body: await res.text() });
});
ctx.postMessage({ ready: true, storage: startError === null ? storageInfo : `起動できない（${startError}）` });
