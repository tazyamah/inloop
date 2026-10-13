// 依頼票を、対象のリポジトリのコードから決定的に組み立てる（ADR-0002、ADR-0015）。
// AIが書いたもののうち使うのは、観点の文と対象のシンボルIDだけ。構造はすべてここで決める。
// 必須の依頼の観点は、AIではなく信頼境界ルールの問いから作る（ADR-0022）。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type BoundaryHit, evaluate, fileCode, loadConfig } from "./boundaries.js";
import { bindEvidence, readEvidence, testCoverage } from "./evidence.js";
import { baseOf, changedLines, checkBase, fileAtBase } from "./diff.js";
import { type Declaration, TsProject } from "./project.js";
import { INDIRECT_DEPTH, tablesOf } from "./sql.js";
import { usecaseMap, usecasesForPacket, type UseCaseMap } from "./usecases.js";
import { CONFIG_FILE, type EvidenceSpec, type Layer, layerOf } from "./rules.js";
import type { Evidence, ReviewCaller, ReviewEdge, ReviewKind, ReviewPacket, ReviewStep, ReviewTable } from "../server/types.js";

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
  /**
   * 再依頼のとき、前の依頼票と、そのうち人が読み終えたシンボルのコード（ADR-0029）。
   * コードが同じシンボルは、依頼票の`prior.same`に入る。
   */
  prior?: { id: string; codes: Record<string, string> };
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
    const config = loadConfig(repo, base);
    let hits: BoundaryHit[] = [];
    let extra: PlannedReview[] = [];
    if (options.required) {
      hits = evaluate(project, repo, base, config.rules, config.layerSets);
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
    const evidence = readEvidence(repo, config.evidence);
    const coverage = new Map<string, Set<string>>();
    const covered = (spec: EvidenceSpec) => {
      let c = coverage.get(spec.id);
      if (!c) coverage.set(spec.id, (c = testCoverage(project, spec.tests ?? [])));
      return c;
    };
    let ucMap: UseCaseMap | undefined;
    const usecases = config.usecases ? () => (ucMap ??= usecaseMap(project, config.usecases!)) : undefined;
    const ctx: Context = { project, repo, base, changed, boundaries, layers: config.layers, specs: config.evidence, evidence, covered, usecases };
    const packets = [...reviews, ...extra].map((r) => packetOf(ctx, r, range));
    const max = options.maxLines;
    if (max !== undefined) {
      const over = packets.flatMap((p) => {
        const lines = reviewLines(p);
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

/**
 * 依頼票の行数の上限（ADR-0017）に数える行。畳んで見せるコード（変わっていない依存、再依頼で前回と同じシンボル）は数えない（ADR-0029）。
 * 畳んだコードは、開けば全行読める。数えないのは、人がまず読む量ではないため。
 */
export function reviewLines(p: Pick<ReviewPacket, "steps" | "requestedSymbols" | "prior">): number {
  const same = new Set(p.prior?.same);
  const asked = new Set(p.requestedSymbols);
  return p.steps.reduce((n, s) => n + (same.has(s.symbol) || (s.change === "unchanged" && !asked.has(s.symbol)) ? 0 : s.code.split("\n").length), 0);
}

interface Context {
  project: TsProject;
  repo: string;
  base: string;
  changed: (file: string, lineCount: number) => Set<number>;
  /** ルールに当たった単位のシンボルIDと、ルールのid */
  boundaries: Map<string, string[]>;
  /** inloop.jsonのレイヤー（ADR-0023） */
  layers: Layer[];
  /** 設定した検査（ADR-0024）と、その結果。`specs`と同じ順 */
  specs: EvidenceSpec[];
  evidence: Evidence[];
  /** `tests`を持つ検査が、呼び出す・newするシンボルのID（ADR-0025） */
  covered: (spec: EvidenceSpec) => Set<string>;
  /** ユースケースの対応（ADR-0046）。`inloop.json`の`usecases`がなければundefined。 */
  usecases?: () => UseCaseMap;
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
  // 並べたシンボルどうしの使う関係（ADR-0020）。依存として並べたものの中の呼び出しも含める。
  // 新しいシンボルは足さない（並べるのは直接の依存まで、ADR-0015）。
  const edges: ReviewEdge[] = [];
  const tables: ReviewTable[] = [];
  for (const d of all.values()) {
    const sql = project.sqlIn(d.file, [d.node]);
    unresolved.push(...sql.dynamic);
    for (const st of sql.statements) for (const t of tablesOf(st)) addTable(tables, { symbol: d.id, ...t });
    // 並べていない宣言の中のSQL（間接、ADR-0030）。並べたシンボルは自分の分を持つので、そこで止める。
    for (const r of project.reachByCalls(d, INDIRECT_DEPTH, new Set(all.keys()))) {
      const inner = project.sqlIn(r.decl.file, [r.decl.node]);
      unresolved.push(...inner.dynamic, ...r.unresolved);
      for (const st of inner.statements) for (const t of tablesOf(st)) addTable(tables, { symbol: d.id, ...t, via: r.via });
    }
  }
  for (const d of all.values()) {
    for (const u of project.references(d).uses) {
      if (all.has(u.to)) edges.push({ from: d.id, to: u.to, kind: u.kind });
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
      layer: layerOf(ctx.layers, d.file),
      boundaries: ctx.boundaries.get(d.id) ?? [],
      change: rel.length === 0 ? "unchanged" : rel.length === total ? "added" : "modified",
      code: d.code,
      changedLines: rel,
    };
  });
  const steps = [...files.flatMap((f) => fileSteps(ctx, f)), ...declSteps].map((s, i): ReviewStep => ({ order: i + 1, ...s }));
  const callers = callersOf(project, review, steps, [...all.values()], edges);
  return {
    id: review.id,
    group: review.group,
    kind: review.kind ?? "optional",
    triggeredBy: review.triggeredBy ?? [],
    viewpoint: review.viewpoint,
    requestedSymbols: review.symbols,
    range,
    steps,
    edges: sortEdges(edges, steps, callers),
    callers,
    tables: sortTables(tables, steps),
    ...(ctx.usecases ? { usecases: usecasesForPacket(ctx.usecases(), new Set(steps.map((s) => s.symbol))) } : {}),
    ...(review.prior ? { prior: { id: review.prior.id, same: steps.filter((s) => review.prior!.codes[s.symbol] === s.code).map((s) => s.symbol) } } : {}),
    unresolved: [...new Set(unresolved)],
    evidence: bindEvidence(ctx.specs, ctx.evidence, ctx.covered, [...new Set([...review.symbols, ...steps.filter((s) => s.change !== "unchanged").map((s) => s.symbol)])].filter((id) => id.includes("#"))),
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
    out.push({ symbol: `${ctx.base}:${file}`, file, startLine: 1, layer: layerOf(ctx.layers, file), boundaries, change: "unchanged", code: fileCode(old), changedLines: [] });
  }
  if (current !== undefined) {
    const count = current.split("\n").length;
    const lines = current === "（バイナリのファイル）" ? new Set<number>() : ctx.changed(file, count);
    const rel = [...lines].filter((l) => l <= count).sort((a, b) => a - b);
    out.push({
      symbol: file,
      file,
      startLine: 1,
      layer: layerOf(ctx.layers, file),
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

const KIND_ORDER: ReviewEdge["kind"][] = ["call", "new", "inherit", "type"];

/**
 * 呼び出し元（ADR-0021）。AIが指定したシンボルと、変わったシンボルを呼び出す（newを含む）、リポジトリの宣言を1段だけ探す。
 * 並べたシンボル（steps）と、それを含む・それに含まれる宣言（クラスとそのメソッド）は除く。
 * 使う関係はedgesに足す（fromが呼び出し元）。数の上限は設けない（画面の側で省かない、R4）。
 */
function callersOf(project: TsProject, review: PlannedReview, steps: ReviewStep[], shown: Declaration[], edges: ReviewEdge[]): ReviewCaller[] {
  const targets = new Set([...review.symbols, ...steps.filter((s) => s.change !== "unchanged").map((s) => s.symbol)]);
  // 名前が本文に現れない宣言は、使っていないので解析しない。コンストラクターはクラス名で現れる。
  const names = [...targets].map((id) => {
    const parts = id.slice(id.indexOf("#") + 1).split(".");
    return parts.at(-1) === "constructor" ? parts[0]! : parts.at(-1)!;
  });
  const out: ReviewCaller[] = [];
  for (const file of project.repoFiles()) {
    const decls = project.declarationsOf(file);
    for (const d of decls) {
      if (shown.some((x) => x.id === d.id || overlaps(x, d))) continue;
      // クラスのように、ほかの宣言を含む宣言は、中のメンバーの側で数える。
      if (decls.some((x) => x !== d && inside(x, d))) continue;
      if (!names.some((n) => d.code.includes(n))) continue;
      // 呼び出しとnewだけを数える。型として参照しているだけの宣言まで入れると、型を変えたときに数が膨らむ。
      const uses = project.references(d).uses.filter((u) => targets.has(u.to) && (u.kind === "call" || u.kind === "new"));
      if (uses.length === 0) continue;
      out.push({ symbol: d.id, file: d.file, startLine: d.startLine, code: d.code });
      for (const u of uses) edges.push({ from: d.id, to: u.to, kind: u.kind });
    }
  }
  return out;
}

const inside = (a: Declaration, b: Declaration) => a.file === b.file && a.start >= b.start && a.end <= b.end;
const overlaps = (a: Declaration, b: Declaration) => inside(a, b) || inside(b, a);

/** 同じ入力から同じ並びになるよう、使う側・使われる側の理解順、種類の順に並べる。呼び出し元は並べたシンボルの後、見つけた順。 */
function sortEdges(edges: ReviewEdge[], steps: ReviewStep[], callers: ReviewCaller[]): ReviewEdge[] {
  const pos = new Map([...steps.map((s) => [s.symbol, s.order] as const), ...callers.map((c, i) => [c.symbol, steps.length + 1 + i] as const)]);
  return edges.sort((a, b) => pos.get(a.from)! - pos.get(b.from)! || pos.get(a.to)! - pos.get(b.to)! || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
}

/** 同じ（シンボル, テーブル, 種類, 経由の末尾）は1つにして、列を合わせる（`*`を先頭、ほかは名前順）。 */
function addTable(tables: ReviewTable[], t: ReviewTable): void {
  const last = (x: ReviewTable) => x.via?.[x.via.length - 1];
  const found = tables.find((x) => x.symbol === t.symbol && x.table === t.table && x.access === t.access && last(x) === last(t));
  if (!found) { tables.push(t); return; }
  if (!t.columns) return;
  const merged = new Map([...(found.columns ?? []), ...t.columns].map((c) => [c.toLowerCase(), c] as const));
  const cols = [...merged.values()];
  found.columns = [...cols.filter((c) => c === "*"), ...cols.filter((c) => c !== "*").sort()];
}

/** 並べたシンボルの順、読む・書く・スキーマの順。 */
function sortTables(tables: ReviewTable[], steps: ReviewStep[]): ReviewTable[] {
  const pos = new Map(steps.map((s) => [s.symbol, s.order]));
  const acc = ["read", "write", "schema"];
  return tables.sort((a, b) => (pos.get(a.symbol) ?? 0) - (pos.get(b.symbol) ?? 0) || acc.indexOf(a.access) - acc.indexOf(b.access));
}
