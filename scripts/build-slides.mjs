// 紹介スライドを、依存のない単一HTMLにまとめる。
// docs/slides/inloop-intro.src.html の {{img:<repoからのパス>}} を、data URIに置き換えて inloop-intro.html を書く。
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "docs/slides/inloop-intro.src.html");
const OUT = join(ROOT, "docs/slides/inloop-intro.html");
const MIME = { ".png": "image/png", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".webp": "image/webp" };

const html = readFileSync(SRC, "utf8").replace(/\{\{img:([^}]+)\}\}/g, (_, path) => {
  const mime = MIME[extname(path)];
  if (!mime) throw new Error(`画像の種類が不明: ${path}`);
  return `data:${mime};base64,${readFileSync(join(ROOT, path)).toString("base64")}`;
});
writeFileSync(OUT, html);
process.stdout.write(`${OUT} (${(html.length / 1024).toFixed(0)} KB)\n`);
