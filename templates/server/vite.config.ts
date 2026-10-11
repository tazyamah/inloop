import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 画面は web/、サーバー（Hono）は server/。開発中は /api をサーバーへ転送する。
export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: { proxy: { "/api": "http://127.0.0.1:8787" } },
});
