// UIを外部依存のない単一HTMLにまとめる（MCP AppsのiframeはCSPで外部読込が制限されるため）。
import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const result = await build({
  entryPoints: ["src/ui/main.ts"],
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  write: false,
  legalComments: "none",
});
const js = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const template = await readFile("src/ui/template.html", "utf8");
if (!template.includes("<!--SCRIPT-->")) throw new Error("template marker missing");
const html = template.replace("<!--SCRIPT-->", () => `<script type="module">${js}</script>`);
await mkdir("dist/ui", { recursive: true });
await writeFile("dist/ui/review.html", html);
console.log(`dist/ui/review.html ${Buffer.byteLength(html)} bytes`);
