// 依頼票を、対象のリポジトリのコードから決定的に組み立てる（ADR-0002、ADR-0015）。
// AIが書いたもののうち使うのは、観点の文と対象のシンボルIDだけ。構造はすべてここで決める。
// 必須の依頼の観点は、AIではなく信頼境界ルールの問いから作る（ADR-0022）。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type BoundaryHit, evaluate, fileCode, loadRules } from "./boundaries.js";
import { baseOf, changedLines, checkBase, fileAtBase } from "./diff.js";
import { type Declaration, TsProject } from "./project.js";
import { CONFIG_FILE } from "./rules.js";
import type { ReviewKind, ReviewPacket, ReviewStep } from "../server/types.js";

/** レビュー予算（変更行の数）の上限の目安。単位は未決（ADR-0015）。 */
export const BUDGET_LIMIT = 40;

export interface PlannedReview {
  id: string;
  group: string;
  viewpoint: string;
  symbols: string[];
  /** 省略するとoptional。requiredは、信頼境界ルールによる必須の依頼（ADR-0022）。 */
  kind?: ReviewKind;
  triggeredBy?: string[];
}

export interface BuildOptions {
  /**
   * 依頼票に並べるコードの行数の上限（ADR-0017）。超えた依頼は、対象のシンボルが2つ以上なら断る。
   * 1つだけなら、それ以上小さくできないので受け付ける。省略すると上限なし。
   */
  maxLines?: number;
  /**
   * 信頼境界ルールを範囲の変更に当て、当たった単位を渡して、必須の依頼を決めてもらう（ADR-0022）。
   * 返した依頼も、同じ解析で依頼票を作る。省略するとルールを当てない。
   */
  required?: (hits: BoundaryHit[]) => PlannedReview[];
}

/**
 * 1回の呼び出しの依頼票をまとめて作る。解析は1回だけ行う。
 * 指定されたシンボルが見つからない、範囲が読めない、などの場合は例外を投げ、何も作らない（fail-closed）。
 */
export function buildPackets(repo: string, reviews: PlannedReview[], range: string, options: BuildOptions = {}): ReviewPacket[] {
  const base = baseOf(range);
  checkBase(repo, base);
  const project = new TsProject(repo);
  try {
    const errors: string[] = [];
    for (const r of reviews) {
      if (r.symbols.length === 0) errors.push(`${r.id}: 対象のシンボルがない（symbols にシンボルIDを指定する）`);
      for (const s of r.symbols) if (!exists(project, repo, base, s)) errors.push(`${s}: 見つからないシンボル`);
    }
    if (errors.length > 0) throw new Error([...new Set(errors)].join("\n"));
    let hits: BoundaryHit[] = [];
    let extra: PlannedReview[] = [];
    if (options.required) {
      hits = evaluate(project, repo, base, loadRules(repo, base));
      extra = options.required(hits);
    }
    const boundaries = new Map(hits.map((h) => [h.symbol, h.rules]));
    const diffs = new Map<string, Set<number>>();
    const changed = (file: string, lineCount: number) => {
      let lines = diffs.get(file);
      if (!lines) {
        lines = changedLines(repo, base, file, lineCount);
        diffs.set(file, lines);
      }
      return lines;
    };
    const ctx: Context = { project, repo, base, changed, boundaries };
    const packets = [...reviews, ...extra].map((r) => packetOf(ctx, r, range));
    const max = options.maxLines;
    if (max !== undefined) {
      const over = packets.flatMap((p) => {
        const lines = p.steps.reduce((n, s) => n + s.code.split("\n").length, 0);
        return p.kind !== "required" && lines > max && new Set(p.requestedSymbols).size > 1
          ? [`${p.id}: 依頼票が${lines}行で、上限の${max}行を超える。対象のシンボルを分けて、別々の依頼（別の呼び出し）にする`]
          : [];
      });
      if (over.length > 0) throw new Error(over.join("\n"));
    }
    return packets;
  } finally {
    project.close();
  }
}

interface Context {
  project: TsProject;
  repo: string;
  base: string;
  changed: (file: string, lineCount: number) => Set<number>;
  /** ルールに当たった単位のシンボルIDと、ルールのid */
  boundaries: Map<string, string[]>;
}

/** シンボルIDが指すものがあるか。`#`のないIDはファイル（作業ツリーか基点にあるもの）を指す（ADR-0022）。 */
function exists(project: TsProject, repo: string, base: string, symbol: string): boolean {
  if (symbol.includes("#")) return project.find(symbol) !== undefined;
  return symbol !== "" && !symbol.startsWith("/") && !symbol.split("/").includes("..") &&
    (existsSync(join(repo, symbol)) || fileAtBase(repo, base, symbol) !== undefined);
}

function packetOf(ctx: Context, review: PlannedReview, range: string): ReviewPacket {
  const { project } = ctx;
  const decls: Declaration[] = [];
  const files: string[] = [];
  for (const s of new Set(review.symbols)) {
    if (s.includes("#")) decls.push(project.find(s)!);
    else files.push(s);
  }
  // 指定されたシンボルと、それが直接使う同じリポジトリのシンボル。数の上限は設けない。
  // 依頼を小さくするのはAIの側の務めで、画面の側では省かない（R4の指摘）。
  const deps = new Map<string, string[]>();
  const unresolved: string[] = [];
  const all = new Map<string, Declaration>(decls.map((d) => [d.id, d]));
  for (const d of decls) {
    const refs = project.references(d);
    deps.set(d.id, refs.internal);
    unresolved.push(...refs.unresolved);
    for (const id of refs.internal) {
      if (!all.has(id)) all.set(id, project.find(id)!);
    }
  }
  const declSteps = order([...all.values()], deps).map((d): Omit<ReviewStep, "order"> => {
    const lines = ctx.changed(d.file, project.lineCount(d.file));
    const rel: number[] = [];
    for (let l = d.startLine; l <= d.endLine; l++) if (lines.has(l)) rel.push(l - d.startLine + 1);
    const total = d.endLine - d.startLine + 1;
    return {
      symbol: d.id,
      file: d.file,
      startLine: d.startLine,
      layer: "",
      boundaries: ctx.boundaries.get(d.id) ?? [],
      change: rel.length === 0 ? "unchanged" : rel.length === total ? "added" : "modified",
      code: d.code,
      changedLines: rel,
    };
  });
  const steps = [...files.flatMap((f) => fileSteps(ctx, f)), ...declSteps].map((s, i): ReviewStep => ({ order: i + 1, ...s }));
  return {
    id: review.id,
    group: review.group,
    kind: review.kind ?? "optional",
    triggeredBy: review.triggeredBy ?? [],
    viewpoint: review.viewpoint,
    requestedSymbols: review.symbols,
    range,
    steps,
    unresolved: [...new Set(unresolved)],
    evidence: [],
    budget: { changedLines: steps.reduce((n, s) => n + s.changedLines.length, 0), limit: BUDGET_LIMIT },
    fixture: false,
  };
}

/**
 * ファイルを指すシンボル（`#`のないID）の依頼票の並び（ADR-0022）。今のファイル全体を示す。
 * 消したファイルと、inloop.jsonは、基点の中身も`<基点>:<パス>`として先に示す（変わった行だけでは、消した行が見えない）。
 */
function fileSteps(ctx: Context, file: string): Omit<ReviewStep, "order">[] {
  const out: Omit<ReviewStep, "order">[] = [];
  const abs = join(ctx.repo, file);
  const current = existsSync(abs) ? fileCode(readFileSync(abs)) : undefined;
  const old = fileAtBase(ctx.repo, ctx.base, file);
  const boundaries = ctx.boundaries.get(file) ?? [];
  if (old !== undefined && (current === undefined || file === CONFIG_FILE)) {
    out.push({ symbol: `${ctx.base}:${file}`, file, startLine: 1, layer: "", boundaries, change: "unchanged", code: fileCode(old), changedLines: [] });
  }
  if (current !== undefined) {
    const count = current.split("\n").length;
    const lines = current === "（バイナリのファイル）" ? new Set<number>() : ctx.changed(file, count);
    const rel = [...lines].filter((l) => l <= count).sort((a, b) => a - b);
    out.push({
      symbol: file,
      file,
      startLine: 1,
      layer: "",
      boundaries,
      change: old === undefined ? "added" : rel.length === 0 ? "unchanged" : "modified",
      code: current,
      changedLines: rel,
    });
  }
  return out;
}

/**
 * 理解順（定義が使用より先）に並べる。依存を先に置き、それ以外はファイルと位置の順。
 * 循環があれば、ファイルと位置の順で先のものから置く。同じ入力からは同じ順になる。
 */
function order(decls: Declaration[], deps: Map<string, string[]>): Declaration[] {
  const byPos = [...decls].sort((a, b) => (a.file === b.file ? a.start - b.start : a.file < b.file ? -1 : 1));
  const placed = new Set<string>();
  const out: Declaration[] = [];
  const visiting = new Set<string>();
  const ids = new Set(decls.map((d) => d.id));
  const byId = new Map(decls.map((d) => [d.id, d]));
  const visit = (d: Declaration) => {
    if (placed.has(d.id) || visiting.has(d.id)) return;
    visiting.add(d.id);
    for (const dep of [...(deps.get(d.id) ?? [])].filter((x) => ids.has(x)).sort((a, b) => byPos.indexOf(byId.get(a)!) - byPos.indexOf(byId.get(b)!))) {
      visit(byId.get(dep)!);
    }
    visiting.delete(d.id);
    placed.add(d.id);
    out.push(d);
  };
  for (const d of byPos) visit(d);
  return out;
}
