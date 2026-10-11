import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 画面は web/、サーバー（Hono）は server/。開発中は /api をサーバーへ転送する。
// 開発用の画面は 127.0.0.1:5173 に固定する（localhost だと ::1 だけで待ち受けることがあり、
// Tauri の devUrl から届かない。ポートが使われていれば別のポートに逃げずに止まる）。
export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: { host: "127.0.0.1", port: 5173, strictPort: true, proxy: { "/api": "http://127.0.0.1:8787" } },
});
