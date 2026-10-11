// 依頼票を、対象のリポジトリのコードから決定的に組み立てる（ADR-0002、ADR-0015）。
// AIが書いたもののうち使うのは、観点の文と対象のシンボルIDだけ。構造はすべてここで決める。
import { baseOf, changedLines, checkBase } from "./diff.js";
import { type Declaration, TsProject } from "./project.js";
import type { ReviewPacket, ReviewStep } from "../server/types.js";

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
