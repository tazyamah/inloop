// ユースケース図（ADR-0046）。依頼票のusecasesだけから描く。推測で線を足さない。
// 左: その入口へ要求を送るテスト。中: 入口（HTTPのルート）。右: 入口のSQLが読む・書くテーブル。矢印は要求・読み書きの向き。
import type { ReviewTable, ReviewUseCase } from "../server/types.js";

const SVG = "http://www.w3.org/2000/svg";
const W = 210;
const H = 40;
const GAP_X = 70;
const GAP_Y = 12;
const PAD = 6;
const MAX_LABEL = 28;

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, text?: string): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text !== undefined) e.textContent = text;
  return e;
}

const clip = (s: string) => (s.length > MAX_LABEL ? `${s.slice(0, MAX_LABEL - 1)}…` : s);
export const ACCESS_LABEL = { read: "読む", write: "書く", schema: "スキーマ" } as const;

/** `書く tasks(done, due)`のような、テーブルの使い方の文字列。 */
export function tableText(t: Omit<ReviewTable, "symbol">): string {
  const cols = t.columns ? `(${t.columns.map((c) => (c === "*" ? "全列または不明" : c)).join(", ")})` : "";
  const via = t.via ? `（${t.via.map((v) => v.slice(v.indexOf("#") + 1)).join(" → ")} 経由）` : "";
  return `${ACCESS_LABEL[t.access]} ${t.table}${cols}${via}`;
}

interface Node { key: string; label: string; sub: string; title: string; y: number; want: number }

/** 列の中の置き場所。希望の高さ（つながる入口の平均）の順に、重ならないよう下げる。 */
function place(nodes: Node[]): void {
  nodes.sort((a, b) => a.want - b.want);
  let floor = PAD;
  for (const n of nodes) {
    n.y = Math.max(n.want, floor);
    floor = n.y + H + GAP_Y;
  }
}

/**
 * ユースケース図のSVGを作る。usecasesのない依頼票、入口が1つもない依頼票ではundefined。
 * onPick: 入口の箱を押したとき、その入口を登録しているコードへ移るために呼ぶ。
 */
export function usecaseDiagram(usecases: ReviewUseCase[] | undefined, onPick: (symbol: string) => void): SVGSVGElement | undefined {
  if (!usecases || usecases.length === 0) return undefined;
  const caseY = usecases.map((_, i) => PAD + i * (H + GAP_Y));
  const testsByKey = new Map<string, Node & { cases: number[] }>();
  const tablesByKey = new Map<string, Node & { cases: number[] }>();
  usecases.forEach((u, i) => {
    for (const t of u.tests) {
      const key = `${t.file}\n${t.name}`;
      const n = testsByKey.get(key) ?? { key, label: t.name, sub: `${t.file}:${t.line}`, title: `${t.name}\n${t.file}:${t.line}`, y: 0, want: 0, cases: [] };
      n.cases.push(i);
      testsByKey.set(key, n);
    }
    for (const t of u.tables) {
      const n = tablesByKey.get(t.table) ?? { key: t.table, label: t.table, sub: "", title: t.table, y: 0, want: 0, cases: [] };
      if (!n.cases.includes(i)) n.cases.push(i);
      tablesByKey.set(t.table, n);
    }
  });
  const tests = [...testsByKey.values()];
  const tables = [...tablesByKey.values()];
  for (const col of [tests, tables]) {
    for (const n of col) n.want = n.cases.reduce((s, i) => s + caseY[i]!, 0) / n.cases.length;
    place(col);
  }
  for (const t of tables) {
    const uses = usecases.flatMap((u) => u.tables.filter((x) => x.table === t.key).map((x) => x.access));
    t.sub = (["write", "read", "schema"] as const).filter((a) => uses.includes(a)).map((a) => ACCESS_LABEL[a]).join("・");
  }
  const x = [PAD, PAD + W + GAP_X, PAD + 2 * (W + GAP_X)] as const;
  const width = x[2] + W + PAD;
  const height = Math.max(PAD * 2 + usecases.length * (H + GAP_Y) - GAP_Y, ...[...tests, ...tables].map((n) => n.y + H + PAD));
  const root = svg("svg", { class: "graph usecase-diagram", width, height, viewBox: `0 0 ${width} ${height}`, role: "img" });
  root.append(svg("title", {}, "ユースケース図: テスト → 入口 → テーブル"));
  const defs = svg("defs", {});
  const marker = svg("marker", { id: "u-arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" });
  marker.append(svg("path", { d: "M0,0 L10,5 L0,10 z", class: "g-head" }));
  defs.append(marker);
  root.append(defs);

  const curve = (x1: number, y1: number, x2: number, y2: number) => `M${x1},${y1} C${x1 + GAP_X / 2},${y1} ${x2 - GAP_X / 2},${y2} ${x2},${y2}`;
  const edges = svg("g", {});
  const edge = (d: string, cls: string, title: string, from: string, to: string) => {
    const p = svg("path", { d, class: `g-edge ${cls}`, "marker-end": "url(#u-arrow)" });
    p.dataset.from = from;
    p.dataset.to = to;
    p.append(svg("title", {}, title));
    edges.append(p);
  };
  usecases.forEach((u, i) => {
    for (const t of u.tests) {
      const n = testsByKey.get(`${t.file}\n${t.name}`)!;
      edge(curve(x[0] + W, n.y + H / 2, x[1], caseY[i]! + H / 2), "u-request", `${t.name} → ${u.id}`, `t:${n.key}`, `c:${u.id}`);
    }
    // 同じテーブルへの使い方が複数（読む・書く）あっても、線は1本にして、いちばん強い使い方で描く。
    for (const n of tables) {
      const uses = u.tables.filter((t) => t.table === n.key);
      if (uses.length === 0) continue;
      const kind = uses.some((t) => t.access === "write") ? "u-write" : uses.some((t) => t.access === "schema") ? "weak" : "u-read";
      edge(curve(x[1] + W, caseY[i]! + H / 2, x[2], n.y + H / 2), kind, `${u.id}: ${uses.map(tableText).join(" / ")}`, `c:${u.id}`, `d:${n.key}`);
    }
  });
  root.append(edges);

  const box = (cls: string, px: number, py: number, label: string, sub: string, title: string, key: string, alert = false) => {
    const g = svg("g", { class: `g-node ${cls}`, transform: `translate(${px},${py})` });
    g.dataset.key = key;
    g.append(svg("title", {}, title), svg("rect", { width: W, height: H, rx: 6 }), svg("text", { x: 8, y: 17, class: "g-name" }, clip(label)), svg("text", { x: 8, y: 33, class: "g-sub" }, clip(sub)));
    if (alert) g.append(svg("circle", { cx: W - 9, cy: 9, r: 4, class: "g-unresolved" }));
    g.addEventListener("mouseenter", () => root.querySelectorAll<SVGPathElement>(".g-edge").forEach((e) => e.classList.toggle("hot", e.dataset.from === key || e.dataset.to === key)));
    g.addEventListener("mouseleave", () => root.querySelectorAll(".g-edge.hot").forEach((e) => e.classList.remove("hot")));
    return g;
  };
  for (const n of tests) root.append(box("u-test", x[0], n.y, n.label, n.sub, n.title, `t:${n.key}`));
  usecases.forEach((u, i) => {
    const g = box("u-case", x[1], caseY[i]!, u.id, u.tests.length === 0 ? "テストなし" : `テスト ${u.tests.length}件`, `${u.id}\n${u.file}:${u.line}${u.tests.length === 0 ? "\nこの入口へ要求を送るテストが見つからない" : ""}\n押すとコードへ移る`, `c:${u.id}`, u.tests.length === 0);
    g.setAttribute("tabindex", "0");
    g.dataset.usecase = u.id;
    g.addEventListener("click", () => onPick(u.symbol));
    g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(u.symbol); } });
    root.append(g);
  });
  for (const n of tables) root.append(box("u-table", x[2], n.y, n.label, n.sub, n.title, `d:${n.key}`));
  return root;
}
