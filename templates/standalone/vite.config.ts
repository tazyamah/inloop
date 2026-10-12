import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 端末内で動くアプリ。サーバー（Hono）は、画面とは別のWeb Workerの中で動き、データは端末のOPFSのSQLiteに残る。
// 画面からの /api の要求は、web/src/local-api.ts がWorkerへ渡す（ネットワークには出ない）。
// server/ のコードは Node.js でも動くよう、node:sqlite を使う。ブラウザ向けのビルドでは、同じ使い方のできる
// server/sqlite-wasm.ts に差し替える。
export default defineConfig({
  root: "web",
  base: "./",
  plugins: [react()],
  resolve: { alias: { "node:sqlite": fileURLToPath(new URL("./server/sqlite-wasm.ts", import.meta.url)) } },
  optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
  worker: { format: "es" },
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: { host: "127.0.0.1", port: 5173, strictPort: true, fs: { allow: [".."] } },
});
