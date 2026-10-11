// アプリのアイコン一式を、元絵から作り直す（src-tauri/icons/ を上書きする）。
// 使い方: npm run icon -- <light|dark|元絵のPNG/SVGのパス>
// 何もしなければ、置いてあるライト版の一式がそのまま使われる。ダーク版の元絵は置いてあるだけで、どこからも参照していない。
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const NAMED = { light: "src-tauri/icons/source/inloop-icon-light.svg", dark: "src-tauri/icons/source/inloop-icon-dark.svg" };
const arg = process.argv[2];
if (!arg) throw new Error("使い方: npm run icon -- <light|dark|元絵のPNG/SVGのパス>");
const source = NAMED[arg] ?? arg;
if (!existsSync(source)) throw new Error(`元絵が見つからない: ${source}`);
execFileSync("npx", ["tauri", "icon", source], { stdio: "inherit", shell: process.platform === "win32" });
