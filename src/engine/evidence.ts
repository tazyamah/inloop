// 証拠（テストや静的解析の結果）の実行と読み込み（ADR-0024）。
// 結果はinloopが自分でコマンドを動かして記録する。AIが書いた結果は使わない。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Evidence } from "../server/types.js";
import { treeFingerprint } from "./diff.js";
import type { TsProject } from "./project.js";
import { matchesAny, type EvidenceSpec } from "./rules.js";

export const EVIDENCE_FILE = "evidence.json";
const TIMEOUT_MS = 10 * 60 * 1000;

const resultsSchema = z.object({
  format: z.literal(1),
  results: z.array(z.object({
    id: z.string(),
    status: z.enum(["pass", "fail"]),
    exitCode: z.number().nullable(),
    /** 実行したときの作業ツリーの指紋 */
    tree: z.string(),
    command: z.array(z.string()),
    ranAt: z.string(),
  })),
});
type Results = z.infer<typeof resultsSchema>;

const fileOf = (repo: string) => join(repo, ".inloop", EVIDENCE_FILE);

function load(repo: string): Results["results"] {
  const file = fileOf(repo);
  if (!existsSync(file)) return [];
  try {
    return resultsSchema.parse(JSON.parse(readFileSync(file, "utf8"))).results;
  } catch {
    return []; // 読めない結果は、なかったものとして扱う（missing）
  }
}

/**
 * 設定した検査を作業ツリーで実行して、結果を`.inloop/evidence.json`に記録する。
 * 実行中にコードが変わった場合は、実行前の指紋で記録する（次に読むときに古いと判定される）。
 * `only`があればそのidだけ実行し、ほかの結果は残す。
 */
export function runEvidence(repo: string, specs: EvidenceSpec[], only?: string[]): { spec: EvidenceSpec; status: "pass" | "fail"; exitCode: number | null }[] {
  const run = only ? specs.filter((s) => only.includes(s.id)) : specs;
  const unknown = (only ?? []).filter((id) => !specs.some((s) => s.id === id));
  if (unknown.length > 0) throw new Error(`${unknown.join(" ")}: inloop.json にない証拠のid`);
  const kept = load(repo).filter((r) => specs.some((s) => s.id === r.id) && !run.some((s) => s.id === r.id));
  const out: { spec: EvidenceSpec; status: "pass" | "fail"; exitCode: number | null }[] = [];
  const results = [...kept];
  for (const spec of run) {
    const tree = treeFingerprint(repo);
    const [cmd, ...args] = spec.command;
    const r = spawnSync(cmd!, args, { cwd: repo, stdio: ["ignore", "inherit", "inherit"], timeout: TIMEOUT_MS });
    const status = r.status === 0 ? "pass" : "fail"; // 起動できない・時間切れ・シグナルはfail
    results.push({ id: spec.id, status, exitCode: r.status, tree, command: spec.command, ranAt: new Date().toISOString() });
    out.push({ spec, status, exitCode: r.status });
  }
  mkdirSync(join(repo, ".inloop"), { recursive: true });
  const dir = join(repo, ".inloop");
  if (!existsSync(join(dir, ".gitignore"))) writeFileSync(join(dir, ".gitignore"), "*\n");
  const tmp = `${fileOf(repo)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ format: 1, results } satisfies Results, null, 2)}\n`);
  renameSync(tmp, fileOf(repo));
  return out;
}

/**
 * 依頼票の`evidence`。設定した検査ごとに1件。結果が今の作業ツリーのものでなければ（実行していない、コードが変わった、
 * 設定のコマンドが変わった）、`missing`にして、名前に理由を足す。
 */
export function readEvidence(repo: string, specs: EvidenceSpec[]): Evidence[] {
  if (specs.length === 0) return [];
  const results = load(repo);
  const tree = treeFingerprint(repo);
  return specs.map((s): Evidence => {
    const r = results.find((x) => x.id === s.id);
    if (!r) return { kind: s.kind, name: `${s.name}（未実行）`, status: "missing" };
    if (r.tree !== tree || JSON.stringify(r.command) !== JSON.stringify(s.command)) {
      return { kind: s.kind, name: `${s.name}（結果が今のコードのものではない）`, status: "missing" };
    }
    return { kind: s.kind, name: s.name, status: r.status };
  });
}

/**
 * `tests`に当たるファイルが、呼び出す・newするシンボルのID（ADR-0025）。宣言の中と最上位の文（`test(...)`など）を調べる。
 * 宣言までたどれない呼び出しは数えない（推測でつなげない）。
 */
export function testCoverage(project: TsProject, patterns: string[]): Set<string> {
  const out = new Set<string>();
  if (patterns.length === 0) return out;
  const add = (uses: { to: string; kind: string }[]) => {
    for (const u of uses) if (u.kind === "call" || u.kind === "new") out.add(u.to);
  };
  for (const file of project.repoFiles()) {
    if (!matchesAny(patterns, file)) continue;
    for (const d of project.declarationsOf(file)) add(project.references(d).uses);
    const top = project.topLevel(file);
    if (top.nodes.length > 0) add(project.referencesIn(file, top.nodes).uses);
  }
  return out;
}

/**
 * 依頼票の`evidence`。`tests`のない検査はそのまま。`tests`のある検査は、依頼票の対象（指定したシンボルと変わったシンボル）の
 * どれかを参照するテストがあるときだけ結果を示し、なければ`missing`にする。一部だけなら名前に件数を足す。
 */
export function bindEvidence(specs: EvidenceSpec[], evidence: Evidence[], covered: (spec: EvidenceSpec) => Set<string>, targets: string[]): Evidence[] {
  return evidence.map((e, i) => {
    const spec = specs[i]!;
    if (!spec.tests) return e;
    const c = covered(spec);
    const n = targets.filter((t) => c.has(t)).length;
    if (n === 0) return { kind: e.kind, name: `${e.name}（対象のシンボルを参照するテストがない）`, status: "missing" };
    return n === targets.length ? e : { ...e, name: `${e.name}（対象${targets.length}件のうち${n}件を参照）` };
  });
}
