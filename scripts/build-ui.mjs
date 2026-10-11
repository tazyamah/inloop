// UIを外部依存のない単一HTMLにまとめる（MCP AppsのiframeはCSPで外部読込が制限されるため）。
// ブラウザで開く経路のホスト（ADR-0010）も同じ形にする。
import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";

async function bundle(entry, templateFile, out) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    target: "es2022",
    minify: true,
    write: false,
    legalComments: "none",
  });
  const js = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
  const template = await readFile(templateFile, "utf8");
  if (!template.includes("<!--SCRIPT-->")) throw new Error(`template marker missing: ${templateFile}`);
  const html = template.replace("<!--SCRIPT-->", () => `<script type="module">${js}</script>`);
  await writeFile(out, html);
  console.log(`${out} ${Buffer.byteLength(html)} bytes`);
}

await mkdir("dist/ui", { recursive: true });
await bundle("src/ui/main.ts", "src/ui/template.html", "dist/ui/review.html");
await bundle("src/ui/browser-host.ts", "src/ui/browser-host.html", "dist/ui/browser.html");
