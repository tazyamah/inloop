// テスト用のリポジトリ。解析エンジン（ADR-0015）が読めるTypeScriptのプロジェクトにする。
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 依頼の対象に使えるシンボル。 */
export const SYMBOL = "src/app.ts#hello";

/** tsconfig.jsonと小さなソースを持つgitリポジトリを作る。commitは任意。 */
export function makeRepo(name = "app", { commit = false, dir } = {}) {
  const repo = dir ?? join(realpathSync(mkdtempSync(join(tmpdir(), "inloop-repo-"))), name);
  mkdirSync(join(repo, "src"), { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  writeFileSync(join(repo, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, target: "es2022", module: "nodenext" }, include: ["src"] }));
  writeFileSync(join(repo, "src", "app.ts"), "export function greet(name: string): string {\n  return `hello ${name}`;\n}\n\nexport function hello(): string {\n  return greet(\"world\");\n}\n");
  if (commit) {
    execFileSync("git", ["-C", repo, "add", "-A"]);
    execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init"]);
  }
  return repo;
}
