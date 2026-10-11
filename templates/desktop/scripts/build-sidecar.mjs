// サーバー（Hono＋SQLite）を、Nodeの単一実行ファイル（SEA）にまとめ、Tauriが同梱できる名前で置く。
// 出力: src-tauri/binaries/server-<ターゲット>（例: server-aarch64-apple-darwin）
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { build } from "esbuild";

const TRIPLES = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "win32-x64": "x86_64-pc-windows-msvc",
};
const triple = process.env.TAURI_TARGET_TRIPLE ?? TRIPLES[`${process.platform}-${process.arch}`];
if (!triple) throw new Error(`${process.platform}-${process.arch} には対応していない（TAURI_TARGET_TRIPLE で指定する）`);
const ext = process.platform === "win32" ? ".exe" : "";

rmSync("dist/sidecar", { recursive: true, force: true });
mkdirSync("dist/sidecar", { recursive: true });
mkdirSync("src-tauri/binaries", { recursive: true });

// SEAの本体は1つのCommonJSファイルにする。node:sqliteなどの組み込みは外に置く。
await build({ entryPoints: ["server/index.ts"], bundle: true, platform: "node", format: "cjs", target: "node22", outfile: "dist/sidecar/server.cjs", logLevel: "warning" });
writeFileSync("dist/sidecar/sea-config.json", JSON.stringify({ main: "dist/sidecar/server.cjs", output: "dist/sidecar/server.blob", disableExperimentalSEAWarning: true }));
execFileSync(process.execPath, ["--experimental-sea-config", "dist/sidecar/sea-config.json"], { stdio: "inherit" });

const out = `src-tauri/binaries/server-${triple}${ext}`;
copyFileSync(process.execPath, out);
chmodSync(out, 0o755);
if (process.platform === "darwin") execFileSync("codesign", ["--remove-signature", out], { stdio: "inherit" });
const inject = ["postject", out, "NODE_SEA_BLOB", "dist/sidecar/server.blob", "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"];
if (process.platform === "darwin") inject.push("--macho-segment-name", "NODE_SEA");
execFileSync("npx", inject, { stdio: "inherit", shell: process.platform === "win32" });
if (process.platform === "darwin") execFileSync("codesign", ["--sign", "-", out], { stdio: "inherit" });
console.log(out);
