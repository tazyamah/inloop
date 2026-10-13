import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// 端末内で動くアプリ。サーバー（Hono）は、画面とは別のWeb Workerの中で動き、データは端末のOPFSのSQLiteに残る。
// 画面からの /api の要求は、web/src/local-api.ts がWorkerへ渡す（ネットワークには出ない）。
// server/ のコードは Node.js でも動くよう、node:sqlite を使う。ブラウザ向けのビルドでは、同じ使い方のできる
// server/sqlite-wasm.ts に差し替える。
// ビルドごとの識別子。画面に埋め込み、同じ値を version.txt にも出して、置き場所の版と見比べる（web/src/offline.ts）。
const buildId = Date.now().toString();
// 拡張には、Webアプリの manifest（PWA用）がないので、参照を外す。
const extensionHtml: Plugin = { name: "extension-html", transformIndexHtml: (html) => html.replace(/<link rel="manifest"[^>]*>\s*/, "") };
const buildIdPlugin: Plugin = { name: "build-id", generateBundle() { this.emitFile({ type: "asset", fileName: "version.txt", source: buildId }); } };

// `vite build --mode extension` は、Chrome拡張として読み込める形（dist/extension）で出す。
// 拡張では、サービスワーカー（オフライン用）と更新通知は使わない（拡張のファイルは、端末に入っている）。
export default defineConfig(({ mode }) => ({
  root: "web",
  base: "./",
  publicDir: mode === "extension" ? "extension" : "public",
  // 拡張（--mode extension）でも、本番の設定（web/.env.production の VITE_SYNC_URL）を使う。
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
    ...(mode === "extension" ? { "import.meta.env.VITE_SYNC_URL": JSON.stringify(loadEnv("production", fileURLToPath(new URL("./web", import.meta.url)), "VITE_").VITE_SYNC_URL ?? "") } : {}),
  },
  plugins: [react(), ...(mode === "extension" ? [extensionHtml] : [buildIdPlugin])],
  resolve: { alias: { "node:sqlite": fileURLToPath(new URL("./server/sqlite-wasm.ts", import.meta.url)) } },
  optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
  worker: { format: "es" },
  build: { outDir: mode === "extension" ? "../dist/extension" : "../dist/web", emptyOutDir: true },
  server: { host: "127.0.0.1", port: 5173, strictPort: true, fs: { allow: [".."] } },
}));
