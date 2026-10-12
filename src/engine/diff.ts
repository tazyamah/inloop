// 変更された行（ADR-0015）。作業ツリーのファイルを、範囲の基点と比べる。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
  if (fileAtBase(repo, base, file) === undefined) return new Set(Array.from({ length: lineCount }, (_, i) => i + 1));
  const out = git(repo, ["diff", "--no-color", "--no-ext-diff", "-U0", base, "--", file]);
  const lines = new Set<number>();
  for (const m of out.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    for (let i = 0; i < count; i++) lines.add(start + i);
  }
  return lines;
}

/**
 * 基点から作業ツリーまでに変わったファイル（ADR-0022）。追跡していない新しいファイルを含む。
 * 名前の変更は、消したファイルと追加したファイルとして扱う。パスの順。
 */
export function changedFiles(repo: string, base: string): { path: string; deleted: boolean }[] {
  const out = new Map<string, boolean>();
  const list = (args: string[]) => git(repo, args).split("\0").filter((p) => p !== "");
  if (base === "HEAD" && !hasCommits(repo)) {
    for (const p of list(["ls-files", "-z", "--cached", "--others", "--exclude-standard"])) out.set(p, false);
  } else {
    const entries = list(["diff", "--no-color", "--no-ext-diff", "--no-renames", "--name-status", "-z", base]);
    for (let i = 0; i + 1 < entries.length; i += 2) out.set(entries[i + 1]!, entries[i]!.startsWith("D"));
    for (const p of list(["ls-files", "-z", "--others", "--exclude-standard"])) out.set(p, false);
  }
  return [...out].map(([path, deleted]) => ({ path, deleted })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** 基点のファイルの中身。基点にない（コミットがない場合を含む）ならundefined。 */
export function fileAtBase(repo: string, base: string, file: string): Buffer | undefined {
  if (base === "HEAD" && !hasCommits(repo)) return undefined;
  try {
    git(repo, ["cat-file", "-e", `${base}:${file}`]);
  } catch {
    return undefined;
  }
  return execFileSync("git", ["-C", repo, "cat-file", "blob", `${base}:${file}`], { stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
}

function hasCommits(repo: string): boolean {
  try {
    git(repo, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * 作業ツリーの内容の指紋。HEAD、追跡しているファイルのHEADからの差分、追跡していない（無視されていない）ファイルの中身から決める。
 * 同じ内容なら同じ値になる。証拠（テスト結果など）が今のコードのものかを確かめるのに使う（ADR-0024）。
 */
export function treeFingerprint(repo: string): string {
  const h = createHash("sha256");
  const commits = hasCommits(repo);
  h.update(commits ? git(repo, ["rev-parse", "HEAD"]) : "no-commits\n");
  if (commits) h.update(git(repo, ["diff", "--no-color", "--no-ext-diff", "--binary", "HEAD"]));
  const others = git(repo, ["ls-files", "-z", "--others", "--exclude-standard"]).split("\0").filter((p) => p !== "").sort();
  for (const p of others) {
    h.update(`\0${p}\0`);
    try { h.update(readFileSync(join(repo, p))); } catch { h.update("unreadable"); }
  }
  return h.digest("hex");
}
