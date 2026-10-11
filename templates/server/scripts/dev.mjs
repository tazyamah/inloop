// 開発用。サーバー（tsx watch）と画面（vite）を一緒に動かす。
import { spawn } from "node:child_process";

const run = (args) => spawn("npx", args, { stdio: "inherit", shell: process.platform === "win32" });
const children = [run(["tsx", "watch", "server/index.ts"]), run(["vite"])];
const stop = () => { for (const c of children) c.kill(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const c of children) c.on("exit", stop);
