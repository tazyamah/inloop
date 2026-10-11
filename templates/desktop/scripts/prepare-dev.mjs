// `npm run dev:desktop`の前に動く。Tauriは、同梱するもの（sidecarのサーバーと画面のdist/web）が
// ないとビルドを止める。開発中の画面はvite＋tsxで動き、どちらも使わないが、なければ用意する。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";

mkdirSync("dist/web", { recursive: true });
const hasSidecar = existsSync("src-tauri/binaries") && readdirSync("src-tauri/binaries").some((f) => f.startsWith("server-"));
if (!hasSidecar) execFileSync(process.execPath, ["scripts/build-sidecar.mjs"], { stdio: "inherit" });
