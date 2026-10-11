// 依存の図（ADR-0020）。依頼票のstepsとedgesだけから描く。推測で線を足さない。
// 使われる側を左、使う側を右に置き、矢印は使う側から使われる側へ引く。
import type { ReviewPacket, ReviewStep } from "../server/types.js";

const SVG = "http://www.w3.org/2000/svg";
const W = 200;
const H = 42;
const GAP_X = 56;
const GAP_Y = 12;
const PAD = 6;
const MAX_LABEL = 26;
/** 箱の下を回る線のための余白 */
const DETOUR = 34;

const KIND_LABEL: Record<string, string> = { call: "呼び出し", new: "new", type: "型の参照", inherit: "継承・実装" };

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, text?: string): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text !== undefined) e.textContent = text;
  return e;
}

const nameOf = (symbol: string) => symbol.slice(symbol.indexOf("#") + 1);
const clip = (s: string) => (s.length > MAX_LABEL ? `${s.slice(0, MAX_LABEL - 1)}…` : s);

/** 未解決の参照（`file:line 式`）を、それを含むシンボルに割り当てる。含むものがなければ数えない。 */
export function unresolvedBySymbol(p: ReviewPacket): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const u of p.unresolved) {
    const m = /^(.+?):(\d+) /.exec(u);
    if (!m) continue;
    const line = Number(m[2]);
    const owner = p.steps
      .filter((s) => s.file === m[1] && line >= s.startLine && line < s.startLine + s.code.split("\n").length)
      // 内側（短い）ものを選ぶ。クラスの中のメソッドなど。
      .sort((a, b) => a.code.length - b.code.length)[0];
    if (owner) out.set(owner.symbol, [...(out.get(owner.symbol) ?? []), u]);
  }
  return out;
}

/** シンボルごとの、使う先・使われる元。図とコードの見出しで共通に使う。 */
export function relationsOf(p: ReviewPacket): { uses: Map<string, string[]>; usedBy: Map<string, string[]> } {
  const uses = new Map<string, string[]>();
  const usedBy = new Map<string, string[]>();
  for (const e of p.edges ?? []) {
    if (e.from === e.to) continue;
    if (!uses.get(e.from)?.includes(e.to)) uses.set(e.from, [...(uses.get(e.from) ?? []), e.to]);
    if (!usedBy.get(e.to)?.includes(e.from)) usedBy.set(e.to, [...(usedBy.get(e.to) ?? []), e.from]);
  }
  return { uses, usedBy };
}

/** 依存の深さ。何も使わないものが0、使うものの深さの最大＋1。循環は、たどっている途中のものを0とみなして切る。 */
function levels(steps: ReviewStep[], uses: Map<string, string[]>): Map<string, number> {
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (id: string): number => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const lv = Math.max(-1, ...(uses.get(id) ?? []).map(visit)) + 1;
    visiting.delete(id);
    memo.set(id, lv);
    return lv;
  };
  for (const s of steps) visit(s.symbol);
  return memo;
}

/**
 * 依存の図のSVGを作る。edgesのない依頼票（ADR-0020より前の記録）ではundefined。
 * onPick: 箱を押したとき、そのシンボルのコードへ移るために呼ぶ。
 */
export function dependencyGraph(p: ReviewPacket, onPick: (symbol: string) => void): SVGSVGElement | undefined {
  if (!p.edges || p.steps.length === 0) return undefined;
  const { uses } = relationsOf(p);
  const unresolved = unresolvedBySymbol(p);
  const lv = levels(p.steps, uses);
  // 呼び出し元（ADR-0021）は、並べたシンボルの右に1列で置く。
  const callerSet = new Set((p.callers ?? []).map((c) => c.symbol));
  const callerColumn = Math.max(...p.steps.map((s) => lv.get(s.symbol)!)) + 1;
  const nodes: ReviewStep[] = [
    ...p.steps,
    ...(p.callers ?? []).map((c, i): ReviewStep => ({ ...c, order: p.steps.length + 1 + i, layer: "", boundaries: [], change: "unchanged", changedLines: [] })),
  ];
  for (const c of callerSet) lv.set(c, callerColumn);
  const columns: ReviewStep[][] = [];
  for (const s of nodes) (columns[lv.get(s.symbol)!] ??= []).push(s);
  // 列の中は理解順。2列目からは、使う先の行の平均が上のものから置き、線の交差を減らす（同じ入力からは同じ並び）。
  const row = new Map<string, number>();
  columns.forEach((col, c) => {
    if (c > 0) {
      const center = (s: ReviewStep) => {
        const rs = (uses.get(s.symbol) ?? []).map((u) => row.get(u)).filter((r): r is number => r !== undefined);
        return rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : Infinity;
      };
      col.sort((a, b) => center(a) - center(b) || a.order - b.order);
    }
    col.forEach((s, r) => row.set(s.symbol, r));
  });
  const pos = new Map<string, { x: number; y: number }>();
  columns.forEach((col, c) => col.forEach((s, r) => pos.set(s.symbol, { x: PAD + c * (W + GAP_X), y: PAD + r * (H + GAP_Y) })));
  // 列を飛ばす線と、循環で戻る線は、箱の下を回す。その分の余白を下に取る。
  const detour = p.edges.some((e) => e.from !== e.to && lv.get(e.from)! - lv.get(e.to)! !== 1);
  const width = PAD * 2 + columns.length * W + (columns.length - 1) * GAP_X;
  const height = PAD * 2 + Math.max(...columns.map((c) => c.length)) * (H + GAP_Y) - GAP_Y + (detour ? DETOUR : 0);
  const root = svg("svg", { class: "graph", width, height, viewBox: `0 0 ${width} ${height}`, role: "img" });
  root.append(svg("title", {}, "依存の図: 矢印は使う側から使われる側へ"));
  const defs = svg("defs", {});
  const marker = svg("marker", { id: "g-arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" });
  marker.append(svg("path", { d: "M0,0 L10,5 L0,10 z", class: "g-head" }));
  defs.append(marker);
  root.append(defs);

  // 同じ2つの間の線は1本にまとめ、種類は線の説明に並べる。呼び出しかnewがあれば実線、型と継承だけなら破線。
  const pairs = new Map<string, { from: string; to: string; kinds: string[] }>();
  for (const e of p.edges) {
    if (e.from === e.to || !pos.has(e.from) || !pos.has(e.to)) continue;
    const key = `${e.from}\n${e.to}`;
    const pair = pairs.get(key) ?? { from: e.from, to: e.to, kinds: [] };
    pair.kinds.push(e.kind);
    pairs.set(key, pair);
  }
  const edgeLayer = svg("g", {});
  for (const pair of pairs.values()) {
    const a = pos.get(pair.from)!;
    const b = pos.get(pair.to)!;
    // 隣の列へは、使う側の左端から使われる側の右端へ。列を飛ばすとき、循環で逆向き・同じ列になるときは、箱の下を回る。
    const span = Math.round((a.x - b.x) / (W + GAP_X));
    const d = span === 1
      ? `M${a.x},${a.y + H / 2} C${a.x - GAP_X / 2},${a.y + H / 2} ${b.x + W + GAP_X / 2},${b.y + H / 2} ${b.x + W},${b.y + H / 2}`
      : span > 1
        ? `M${a.x + 16},${a.y + H} C${a.x + 16},${Math.max(a.y, b.y) + H + DETOUR} ${b.x + W - 16},${Math.max(a.y, b.y) + H + DETOUR} ${b.x + W - 16},${b.y + H}`
        : `M${a.x + W / 2},${a.y + H} C${a.x + W / 2},${a.y + H + DETOUR} ${b.x + W / 2},${b.y + H + DETOUR} ${b.x + W / 2},${b.y + H}`;
    const strong = pair.kinds.some((k) => k === "call" || k === "new");
    const path = svg("path", { d, class: `g-edge${strong ? "" : " weak"}`, "marker-end": "url(#g-arrow)" });
    path.dataset.from = pair.from;
    path.dataset.to = pair.to;
    path.append(svg("title", {}, `${nameOf(pair.from)} → ${nameOf(pair.to)}: ${pair.kinds.map((k) => KIND_LABEL[k]).join("・")}`));
    edgeLayer.append(path);
  }
  root.append(edgeLayer);

  const requested = new Set(p.requestedSymbols);
  for (const s of nodes) {
    const { x, y } = pos.get(s.symbol)!;
    const caller = callerSet.has(s.symbol);
    const g = svg("g", { class: `g-node g-${caller ? "caller" : s.change}${requested.has(s.symbol) ? " g-req" : ""}`, transform: `translate(${x},${y})`, tabindex: 0 });
    g.dataset.symbol = s.symbol;
    const lines = s.code.split("\n").length;
    const change = caller ? `呼び出し元 ${lines}行` : s.change === "unchanged" ? "変更なし" : `${s.change === "added" ? "追加" : "変更"} ${s.changedLines.length}行`;
    const un = unresolved.get(s.symbol)?.length ?? 0;
    g.append(
      svg("title", {}, `${s.symbol}（${lines}行）${requested.has(s.symbol) ? "\nAIが指定した対象" : ""}${un ? `\n未解決の参照 ${un}件` : ""}\n押すとコードへ移る`),
      svg("rect", { width: W, height: H, rx: 6 }),
      svg("text", { x: 8, y: 17, class: "g-name" }, clip(nameOf(s.symbol))),
      svg("text", { x: 8, y: 33, class: "g-sub" }, `${caller ? "" : `${s.order}. `}${change}${un ? ` ・未解決 ${un}` : ""}`),
    );
    if (un) g.append(svg("circle", { cx: W - 9, cy: 9, r: 4, class: "g-unresolved" }));
    const pick = () => onPick(s.symbol);
    g.addEventListener("click", pick);
    g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
    // 箱に乗ったら、その箱につながる線だけを強調する。
    g.addEventListener("mouseenter", () => root.querySelectorAll<SVGPathElement>(".g-edge").forEach((e) => {
      e.classList.toggle("hot", e.dataset.from === s.symbol || e.dataset.to === s.symbol);
    }));
    g.addEventListener("mouseleave", () => root.querySelectorAll(".g-edge.hot").forEach((e) => e.classList.remove("hot")));
    root.append(g);
  }
  return root;
}
