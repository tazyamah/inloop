// 依頼票を、対象のリポジトリのコードから決定的に組み立てる（ADR-0002、ADR-0015）。
// AIが書いたもののうち使うのは、観点の文と対象のシンボルIDだけ。構造はすべてここで決める。
import { baseOf, changedLines, checkBase } from "./diff.js";
import { type Declaration, TsProject } from "./project.js";
import type { ReviewCaller, ReviewEdge, ReviewPacket, ReviewStep } from "../server/types.js";

/** レビュー予算（変更行の数）の上限の目安。単位は未決（ADR-0015）。 */
export const BUDGET_LIMIT = 40;

export interface PlannedReview {
  id: string;
  group: string;
  viewpoint: string;
  symbols: string[];
}

/**
 * 1回の呼び出しの依頼票をまとめて作る。解析は1回だけ行う。
 * 指定されたシンボルが見つからない、範囲が読めない、などの場合は例外を投げ、何も作らない（fail-closed）。
 */
export interface BuildOptions {
  /**
   * 依頼票に並べるコードの行数の上限（ADR-0017）。超えた依頼は、対象のシンボルが2つ以上なら断る。
   * 1つだけなら、それ以上小さくできないので受け付ける。省略すると上限なし。
   */
  maxLines?: number;
}

export function buildPackets(repo: string, reviews: PlannedReview[], range: string, options: BuildOptions = {}): ReviewPacket[] {
  const base = baseOf(range);
  checkBase(repo, base);
  const project = new TsProject(repo);
  try {
    const errors: string[] = [];
    for (const r of reviews) {
      if (r.symbols.length === 0) errors.push(`${r.id}: 対象のシンボルがない（symbols にシンボルIDを指定する）`);
      for (const s of r.symbols) if (!project.find(s)) errors.push(`${s}: 見つからないシンボル`);
    }
    if (errors.length > 0) throw new Error([...new Set(errors)].join("\n"));
    const diffs = new Map<string, Set<number>>();
    const changed = (d: Declaration) => {
      let lines = diffs.get(d.file);
      if (!lines) {
        lines = changedLines(repo, base, d.file, project.lineCount(d.file));
        diffs.set(d.file, lines);
      }
      return lines;
    };
    const packets = reviews.map((r) => packetOf(project, r, range, changed));
    const max = options.maxLines;
    if (max !== undefined) {
      const over = packets.flatMap((p) => {
        const lines = p.steps.reduce((n, s) => n + s.code.split("\n").length, 0);
        return lines > max && new Set(p.requestedSymbols).size > 1
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

function packetOf(project: TsProject, review: PlannedReview, range: string, changed: (d: Declaration) => Set<number>): ReviewPacket {
  const requested = [...new Set(review.symbols)].map((s) => project.find(s)!);
  // 指定されたシンボルと、それが直接使う同じリポジトリのシンボル。数の上限は設けない。
  // 依頼を小さくするのはAIの側の務めで、画面の側では省かない（R4の指摘）。
  const deps = new Map<string, string[]>();
  const unresolved: string[] = [];
  const all = new Map<string, Declaration>(requested.map((d) => [d.id, d]));
  for (const d of requested) {
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
  for (const d of all.values()) {
    for (const u of project.references(d).uses) {
      if (all.has(u.to)) edges.push({ from: d.id, to: u.to, kind: u.kind });
    }
  }
  const steps = order([...all.values()], deps).map((d, i): ReviewStep => {
    const lines = changed(d);
    const rel: number[] = [];
    for (let l = d.startLine; l <= d.endLine; l++) if (lines.has(l)) rel.push(l - d.startLine + 1);
    const total = d.endLine - d.startLine + 1;
    return {
      order: i + 1,
      symbol: d.id,
      file: d.file,
      startLine: d.startLine,
      layer: "",
      boundaries: [],
      change: rel.length === 0 ? "unchanged" : rel.length === total ? "added" : "modified",
      code: d.code,
      changedLines: rel,
    };
  });
  const callers = callersOf(project, review, steps, [...all.values()], edges);
  return {
    id: review.id,
    group: review.group,
    // 信頼境界ルールはまだない。必須の依頼はルールとともに作る（ADR-0001、ADR-0015）。
    kind: "optional",
    triggeredBy: [],
    viewpoint: review.viewpoint,
    requestedSymbols: review.symbols,
    range,
    steps,
    edges: sortEdges(edges, steps, callers),
    callers,
    unresolved: [...new Set(unresolved)],
    evidence: [],
    budget: { changedLines: steps.reduce((n, s) => n + s.changedLines.length, 0), limit: BUDGET_LIMIT },
    fixture: false,
  };
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
