// 変更された行（ADR-0015）。作業ツリーのファイルを、範囲の基点と比べる。
import { execFileSync } from "node:child_process";

/**
 * 範囲の基点。`A..B`ならA、それ以外（`HEAD`など）はその値。
 * コードは常に作業ツリーから取るので、範囲の終点は使わない。
 */
export function baseOf(range: string): string {
  const i = range.indexOf("..");
  return (i >= 0 ? range.slice(0, i) : range).trim() || "HEAD";
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
}

/** 基点がコミットとして読めるか。読めなければ、範囲の指定が不正。 */
export function checkBase(repo: string, base: string): void {
  // まだコミットのないリポジトリ（inloop newの直後など）は、すべてが追加として扱う。
  if (base === "HEAD" && !hasCommits(repo)) return;
  try {
    git(repo, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
  } catch {
    throw new Error(`${base}: コミットとして読めない（range の指定）`);
  }
}

/**
 * 作業ツリーのファイルのうち、基点から追加・変更された行（1始まり）。
 * 基点にないファイル（新しいファイル、gitが追跡していないファイル）は、すべての行が追加。
 */
export function changedLines(repo: string, base: string, file: string, lineCount: number): Set<number> {
  let existed = true;
  try {
    git(repo, ["cat-file", "-e", `${base}:${file}`]);
  } catch {
    existed = false;
  }
  if (!existed) return new Set(Array.from({ length: lineCount }, (_, i) => i + 1));
  const out = git(repo, ["diff", "--no-color", "--no-ext-diff", "-U0", base, "--", file]);
  const lines = new Set<number>();
  for (const m of out.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    for (let i = 0; i < count; i++) lines.add(start + i);
  }
  return lines;
}

function hasCommits(repo: string): boolean {
  try {
    git(repo, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    return true;
  } catch {
    return false;
  }
}
