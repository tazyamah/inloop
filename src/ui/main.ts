// レビューUI。画面は読む場所と記録にする（ADR-0017、ADR-0018）。議論は会話で行い、
// 画面からは位置をコピーして会話に貼る。承認・保留は、画面のボタンか、会話の決まった言葉で記録する。
import { App } from "@modelcontextprotocol/ext-apps";
import type { Answer, AnswerRound, InboxItem, ReviewPacket, ReviewStep } from "../server/types.js";
import { dependencyGraph, relationsOf } from "./graph.js";

type Decision = "ok" | "hold";

const VERDICT_LABEL: Record<string, string> = { ok: "承認", fix: "修正依頼", ask: "質問", hold: "保留" };
const STATUS_LABEL: Record<string, string> = {
  pending: "未回答", approved: "承認済み", fixing: "修正待ち", answering: "回答待ち", held: "保留中", superseded: "再依頼済み",
};
/** 画面上部に出す、回答した後の状態。 */
const ANSWERED_LABEL: Record<string, string> = {
  approved: "承認済み", fixing: "回答済み（修正依頼）", answering: "回答済み（質問）", held: "回答済み（保留）",
};
/** 人が同じ依頼票のまま未回答に戻せる状態（ADR-0009）。 */
const REOPENABLE = new Set(["held", "answering"]);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function button(label: string, onClick: () => void, cls?: string): HTMLButtonElement {
  const b = el("button", cls, label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

const app = new App({ name: "inloop-review", version: "0.0.0" }, {});
let toolId: string | undefined;
/** 依頼の対象のリポジトリ。ツールの結果の`_meta`で受け取り、UI専用のツールに渡す（ADR-0010）。 */
let repo: string | undefined;
let shownId: string | undefined;
let inbox: InboxItem[] = [];
/** 別の呼び出しで出された未回答の依頼の数。この画面からは回答できない。 */
let elsewhere = 0;
const packets = new Map<string, ReviewPacket>();
/** 依頼と、同じ系列でそれより前の依頼に、これまで付いた回答。 */
const histories = new Map<string, AnswerRound[]>();
/** 選んだ行。クリックで位置をコピーし、Shift+クリックで範囲にする。 */
let picked: { symbol: string; start: number; end: number } | null = null;
/**
 * 開いた「変わっていない依存」のコード（`依頼ID シンボル`）。変わっていない依存は既定で畳む（ADR-0020）。
 * 畳むだけで省かない。見出しと行数は常に出す。
 */
const expanded = new Set<string>();
/** 図や見出しから移った先のシンボル。しばらく枠で示す。 */
let flashed: string | undefined;
/** 記録の操作の途中は、ボタンを押せなくする。 */
let busy = false;

function setStatus(msg: string, isError = false) {
  const s = $("status");
  s.textContent = msg;
  s.className = isError ? "err" : "";
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
/** 画面の下の表示欄はコードから遠いので、行をクリックした結果は、見えている位置にも短く出す。 */
function toast(msg: string, isError = false) {
  const t = $("toast");
  t.textContent = msg;
  t.className = isError ? "err" : "";
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

function structured<T>(r: { structuredContent?: unknown; isError?: boolean; content?: unknown }): T {
  if (r.isError) {
    const c = (r.content as { text?: string }[] | undefined)?.map((x) => x.text).join("\n");
    throw new Error(c || "tool error");
  }
  return r.structuredContent as T;
}

const withRepo = (args: Record<string, unknown>) => (repo ? { ...args, repo } : args);

async function fetchPacket(id: string): Promise<{ packet: ReviewPacket; inbox: InboxItem[]; elsewhere?: number }> {
  const r = await app.callServerTool({ name: "inloop_get_request", arguments: withRepo({ id }) });
  const data = structured<{ packet: ReviewPacket; inbox: InboxItem[]; elsewhere?: number; history?: AnswerRound[] }>(r);
  packets.set(id, data.packet);
  histories.set(id, data.history ?? []);
  return data;
}

async function load(id: string) {
  const data = await fetchPacket(id);
  shownId = id;
  inbox = data.inbox;
  elsewhere = data.elsewhere ?? 0;
  picked = null;
  render();
}

async function refreshInbox() {
  if (!shownId) return;
  try {
    const data = await fetchPacket(shownId);
    inbox = data.inbox;
    elsewhere = data.elsewhere ?? 0;
    render();
  } catch { /* 表示中の依頼の再取得に失敗しても既存表示を保つ */ }
}

const pendingItems = () => inbox.filter((i) => i.status === "pending");

function refOf(symbol: string, start: number, end: number): string {
  return start === end ? `${symbol}#L${start}` : `${symbol}#L${start}-L${end}`;
}

function parseRef(ref?: string): { symbol: string; start?: number; end?: number } | undefined {
  if (!ref) return undefined;
  const m = /^(.*)#L(\d+)(?:-L(\d+))?$/.exec(ref);
  if (!m) return { symbol: ref };
  return { symbol: m[1], start: Number(m[2]), end: Number(m[3] ?? m[2]) };
}

function shortRef(ref?: string): string {
  const r = parseRef(ref);
  if (!r) return "依頼全体";
  const name = r.symbol.split("#").pop() ?? r.symbol;
  return r.start === undefined ? name : r.start === r.end ? `${name} L${r.start}` : `${name} L${r.start}-L${r.end}`;
}

function answerText(a: Answer): string {
  const where = a.verdict === "ok" || a.verdict === "hold" ? "" : ` ${shortRef(a.ref)}`;
  return `${a.id} ${VERDICT_LABEL[a.verdict]}${where}${a.comment ? `: ${a.comment}` : ""}${a.by === "chat" ? "（会話での指示をAIが記録）" : ""}`;
}

// ---- 位置のコピー ----

/**
 * 行クリックの位置を、会話の入力欄に入れる（ADR-0032）。会話で「ここの範囲なんだけど」と話しかけるため（ADR-0017）。
 * 会話に入れられるホスト（MCP Appsの埋め込み）は`sendMessage`で入れ、あわせてクリップボードにも写す。
 * 会話に入れられないホスト（ブラウザの経路）は、クリップボードだけにする。
 */
async function copyText(text: string) {
  let copied = false;
  try {
    await navigator.clipboard.writeText(text);
    copied = true;
  } catch {
    const ta = el("textarea");
    ta.value = text;
    document.body.append(ta);
    ta.select();
    copied = document.execCommand("copy");
    ta.remove();
  }
  const res = await app.sendMessage({ role: "user", content: [{ type: "text", text }] }).catch(() => ({ isError: true }));
  const sent = res.isError !== true;
  const msg = sent ? `会話に位置を入れました${copied ? "（コピーも済み）" : ""}: ${text}` : copied ? `コピーしました: ${text}` : `コピーできませんでした。手で写してください: ${text}`;
  setStatus(msg, !sent && !copied);
  toast(msg, !sent && !copied);
}

/** 依頼IDと参照を、回答の1行と同じ形で並べた位置の文字列。例: R6 src/a.ts#f#L3-L5 */
const positionOf = (reviewId: string, ref: string) => `${reviewId} ${ref}`;

function onLineClick(step: ReviewStep, abs: number, shift: boolean) {
  picked = shift && picked?.symbol === step.symbol
    ? { symbol: step.symbol, start: Math.min(picked.start, abs), end: Math.max(picked.end, abs) }
    : { symbol: step.symbol, start: abs, end: abs };
  render();
  void copyText(positionOf(shownId!, refOf(picked.symbol, picked.start, picked.end)));
}

// ---- 記録の操作 ----

/** 承認・保留を、押したらすぐ記録する。複数の依頼をまとめて承認するときはidsに並べる。 */
async function decide(ids: string[], verdict: Decision) {
  if (busy || ids.length === 0) return;
  busy = true;
  render();
  try {
    const r = await app.callServerTool({ name: "inloop_submit", arguments: withRepo({ from: toolId ?? shownId, answers: ids.map((id) => ({ id, verdict })) }) });
    const data = structured<{ message: string; inbox: InboxItem[]; elsewhere?: number }>(r);
    inbox = data.inbox;
    elsewhere = data.elsewhere ?? 0;
    // 再読み込みした時と同じ表示にするため、回答した依頼の記録を取り直す。
    await Promise.all(ids.map((id) => fetchPacket(id).catch(() => undefined)));
    // 会話に入れられるホスト（MCP Appsの埋め込み）では、回答を会話に届ける。
    const res = await app.sendMessage({ role: "user", content: [{ type: "text", text: data.message }] });
    const label = ids.length > 1 ? `${ids.length}件の依頼を` : `${ids[0]}を`;
    setStatus(res.isError ? `${label}${VERDICT_LABEL[verdict]}として記録しました。会話でAIに伝えてください。` : `${label}${VERDICT_LABEL[verdict]}として記録しました。`);
  } catch (e) {
    setStatus((e as Error).message, true);
  }
  busy = false;
  render();
}

/** 保留中・回答待ちの依頼を未回答に戻す。会話には何も送らない。 */
async function reopen(id: string) {
  try {
    const r = await app.callServerTool({ name: "inloop_reopen", arguments: withRepo({ from: toolId ?? shownId, ids: [id] }) });
    const data = structured<{ inbox: InboxItem[]; elsewhere?: number }>(r);
    inbox = data.inbox;
    elsewhere = data.elsewhere ?? 0;
    setStatus(`${id}を未回答に戻しました。`);
  } catch (e) {
    setStatus((e as Error).message, true);
  }
  render();
}

/** 再依頼済みの依頼から、引き継ぎ先の依頼へ辿るボタン。 */
function nextButton(next: string): HTMLButtonElement {
  const b = button(`再依頼済み → ${next}`, () => { void goTo(next); }, "next");
  b.dataset.next = next;
  b.title = `${next}の画面を開く`;
  return b;
}

/**
 * 引き継ぎ先の依頼の画面を開く。引き継ぎ先は別の呼び出しのまとまりなので、この画面では回答できない。
 * ブラウザで開く経路では、そのページへ移る。MCP Appsでは、再依頼した会話にある画面を案内する。
 */
async function goTo(id: string) {
  if (app.getHostVersion()?.name === "inloop-browser-host") {
    const r = await app.openLink({ url: `inloop:review/${id}` }).catch(() => ({ isError: true }));
    if (!r.isError) return;
  }
  setStatus(`${id}は、再依頼した会話の画面から開いてください。`);
}

// ---- 描画 ----

function render() {
  renderDetail();
  renderAnswers();
}

function renderDetail() {
  const p = shownId ? packets.get(shownId) : undefined;
  if (!p) return;
  $("loading").hidden = true;
  $("detail").hidden = false;
  $("title").textContent = `inloop レビュー依頼 ${p.id}`;
  const kind = $("kind");
  kind.replaceChildren(el("span", p.kind === "required" ? "chip req" : "chip", p.kind === "required" ? "必須" : "任意"));
  if (p.kind === "required") kind.append(" ", el("span", "muted", `ルール: ${p.triggeredBy.join(", ")}`));
  // 回答した後の画面は記録として残す。上部に状態を出し、再依頼済みなら引き継ぎ先へ辿れるようにする。
  const item = inbox.find((i) => i.id === p.id);
  if (item?.supersededBy) {
    kind.prepend(nextButton(item.supersededBy), " ");
  } else if (item && ANSWERED_LABEL[item.status]) {
    kind.prepend(el("span", "chip ok state", ANSWERED_LABEL[item.status] + (item.by === "chat" ? "・会話で" : "")), " ");
  }
  $("fixture").hidden = !p.fixture;
  $("viewpoint").textContent = p.viewpoint;
  const meta = [`範囲: ${p.range}`, `変更行 ${p.budget.changedLines} / 予算 ${p.budget.limit}`];
  if (p.requestedSymbols.length) meta.push(`AIの指定: ${p.requestedSymbols.join(", ")}`);
  const branch = /^(R\d+)-(\d+)$/.exec(p.id);
  if (branch) meta.unshift(`${branch[1]}の再依頼（${branch[2]}回目）`);
  $("meta").textContent = meta.join(" ・ ");
  // 前の依頼（同じ系列）への回答と、この依頼への回答を分けて出す。どちらも記録で、後から変わらない。
  const rounds = histories.get(p.id) ?? [];
  const past = rounds.filter((r) => r.id !== p.id).flatMap((r) => r.answers);
  const own = rounds.filter((r) => r.id === p.id).flatMap((r) => r.answers);
  $("history-box").hidden = past.length === 0;
  $("history").replaceChildren(...past.map((a) => el("li", undefined, answerText(a))));
  $("own-box").hidden = own.length === 0;
  $("own").replaceChildren(...own.map((a) => el("li", undefined, answerText(a))));

  const graph = dependencyGraph(p, (symbol) => showStep(p, symbol));
  $("graph-box").hidden = !graph;
  $("graph").replaceChildren(...(graph ? [graph] : []));
  const { uses, usedBy } = relationsOf(p);
  const requested = new Set(p.requestedSymbols);
  $("steps").replaceChildren(...p.steps.map((s) => symbolBox(p, s, false, uses, usedBy, requested)));
  // 呼び出し元（ADR-0021）。理解順の対象ではなく影響範囲なので、別に並べ、既定で畳む。
  const callers = (p.callers ?? []).map((c): ReviewStep => ({ ...c, order: 0, layer: "", boundaries: [], change: "unchanged", changedLines: [] }));
  $("callers-box").hidden = p.callers === undefined;
  $("callers").replaceChildren(...(callers.length ? callers.map((c) => symbolBox(p, c, true, uses, usedBy, requested)) : [el("div", "muted", "なし（このリポジトリに、対象を呼び出している別のシンボルはない）")]));
  $("tables-box").hidden = p.tables === undefined;
  const label = { read: "読む", write: "書く", schema: "スキーマ" };
  $("tables").replaceChildren(...((p.tables ?? []).length ? p.tables!.map((t) => el("li", undefined, `${t.symbol}: ${label[t.access]} ${t.table}${t.columns ? `(${t.columns.map((c) => (c === "*" ? "全列または不明" : c)).join(", ")})` : ""}${t.via ? `（${t.via.map((v) => v.slice(v.indexOf("#") + 1)).join(" → ")} 経由）` : ""}`)) : [el("li", "muted", "なし（対象のコードに、読み取れるSQLはない）")]));
  const un = $("unresolved");
  un.replaceChildren(...(p.unresolved.length ? p.unresolved.map((u) => el("li", undefined, u)) : [el("li", "muted", "なし")]));
  const ev = $("evidence");
  if (p.evidence.length === 0) { ev.replaceChildren(el("li", "muted", "なし（テストや静的解析の結果はまだ取り込んでいない）")); return; }
  ev.replaceChildren(...p.evidence.map((e) => {
    const li = el("li");
    const mark = e.status === "pass" ? "✓ 成功" : e.status === "fail" ? "✗ 失敗" : "! 未作成";
    li.append(el("span", `ev-${e.status}`, mark), ` ${e.kind === "test" ? "テスト" : "静的解析"}: ${e.name}`);
    return li;
  }));
}

/** シンボル1つの見出しとコード。callerは呼び出し元（ADR-0021）で、番号と変更の印の代わりに「呼び出し元」と出す。 */
function symbolBox(p: ReviewPacket, s: ReviewStep, caller: boolean, uses: Map<string, string[]>, usedBy: Map<string, string[]>, requested: Set<string>): HTMLElement {
  const same = !caller && (p.prior?.same.includes(s.symbol) ?? false);
  const box = el("div", (caller ? "step caller" : "step") + (s.symbol === flashed ? " flash" : ""));
  box.dataset.symbol = s.symbol;
  const h = el("header");
  if (caller) h.append(el("span", "chip", "呼び出し元"), el("code", undefined, s.symbol));
  else {
    h.append(el("span", "n", `${s.order}`), el("code", undefined, s.symbol));
    if (s.layer) h.append(el("span", "chip", s.layer));
    h.append(el("span", "chip", s.change === "added" ? "追加" : s.change === "modified" ? "変更" : "変更なし"));
  }
  if (same) h.append(el("span", "chip", `${p.prior!.id}から変更なし`));
  for (const b of s.boundaries) h.append(el("span", "chip req", b));
  h.append(el("span", "spacer"));
  const copy = button("位置をコピー", () => { void copyText(positionOf(p.id, s.symbol)); }, "link");
  copy.dataset.copy = s.symbol;
  h.append(copy);
  const lineCount = s.code.split("\n").length;
  // 変わっていない依存と呼び出し元は既定で畳む（ADR-0020）。畳むだけで省かない。
  const foldable = caller || same || (s.change === "unchanged" && !requested.has(s.symbol));
  const folded = foldable && !expanded.has(`${p.id} ${s.symbol}`);
  if (foldable) {
    h.append(button(folded ? `コードを表示（${lineCount}行）` : "畳む", () => {
      const key = `${p.id} ${s.symbol}`;
      if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
      render();
    }, "link fold"));
  }
  const rel = el("div", "rel muted");
  const relLinks = (label: string, ids: string[] | undefined) => {
    if (!ids?.length) return;
    rel.append(`${label}: `);
    ids.forEach((id, i) => {
      if (i > 0) rel.append(", ");
      rel.append(button(id.slice(id.indexOf("#") + 1), () => showStep(p, id), "link"));
    });
    rel.append(" ");
  };
  relLinks("uses", uses.get(s.symbol));
  relLinks("used by", usedBy.get(s.symbol));
  box.append(h);
  if (rel.childNodes.length) box.append(rel);
  if (folded) return box;
  const code = el("div", "code");
  s.code.split("\n").forEach((line, i) => {
    const abs = s.startLine + i;
    const selected = picked?.symbol === s.symbol && abs >= picked.start && abs <= picked.end;
    const ln = el("div", "ln" + (s.changedLines.includes(i + 1) ? " chg" : "") + (selected ? " sel" : ""));
    ln.dataset.ref = `${s.symbol}#L${abs}`;
    ln.title = "クリックで位置をコピー、Shift+クリックで範囲";
    const no = el("span", "no");
    no.append(String(abs));
    ln.append(no, el("span", "tx", line));
    ln.addEventListener("click", (e) => onLineClick(s, abs, e.shiftKey));
    code.append(ln);
  });
  box.append(code);
  return box;
}

/** 図や見出しから、シンボルのコードへ移る。畳んであれば開く。 */
function showStep(p: ReviewPacket, symbol: string) {
  expanded.add(`${p.id} ${symbol}`);
  // フォーカスでの受付箱の再取得などで描き直されても、移った先の印が消えないよう、状態として持つ。
  flashed = symbol;
  render();
  const box = [...document.querySelectorAll<HTMLElement>(".step")].find((b) => b.dataset.symbol === symbol);
  box?.scrollIntoView({ behavior: "smooth", block: "start" });
  setTimeout(() => {
    if (flashed !== symbol) return;
    flashed = undefined;
    document.querySelectorAll(".step.flash").forEach((b) => b.classList.remove("flash"));
  }, 1500);
}

function renderAnswers() {
  const box = $("inbox");
  box.replaceChildren();
  for (const item of inbox) {
    const pending = item.status === "pending";
    const row = el("div", "item" + (item.id === shownId ? " cur" : "") + (pending ? "" : " done"));
    row.dataset.id = item.id;
    const head = el("div", "row");
    const vp = el("span", "vp", `${item.id}: ${item.viewpoint}`);
    vp.title = "この依頼票を表示";
    vp.addEventListener("click", () => { load(item.id).catch((e) => setStatus(String((e as Error).message ?? e), true)); });
    head.append(el("span", item.kind === "required" ? "chip req" : "chip", item.kind === "required" ? "必須" : "任意"), vp,
      item.supersededBy ? nextButton(item.supersededBy)
        : el("span", pending ? "chip" : "chip ok", (STATUS_LABEL[item.status] ?? item.status) + (item.by === "chat" ? "（会話で）" : "")));
    row.append(head);
    const actions = el("div", "row actions");
    if (pending) {
      for (const v of ["ok", "hold"] as Decision[]) {
        const b = button(VERDICT_LABEL[v], () => { void decide([item.id], v); }, v === "ok" ? "primary" : undefined);
        b.dataset.decision = v;
        b.disabled = busy;
        actions.append(b);
      }
    } else if (REOPENABLE.has(item.status)) {
      const back = button("未回答に戻す", () => { void reopen(item.id); });
      back.dataset.reopen = item.id;
      actions.append(back);
    }
    if (actions.childElementCount > 0) row.append(actions);
    box.append(row);
  }
  const open = pendingItems();
  const all = $("approve-all") as HTMLButtonElement;
  all.hidden = open.length < 2;
  all.disabled = busy;
  all.textContent = `まとめて承認（${open.length}件）`;
  $("answers-help").hidden = open.length === 0;
  $("all-answered").hidden = open.length > 0 || inbox.length === 0;
  if (open.length > 0 && elsewhere > 0) {
    const note = el("div", "item muted", `ほかに未回答の依頼が${elsewhere}件あります。それぞれが出された場所の画面から回答してください。`);
    note.dataset.elsewhere = String(elsewhere);
    box.append(note);
  }
}

$("approve-all").addEventListener("click", () => { void decide(pendingItems().map((i) => i.id), "ok"); });
$("full").addEventListener("click", () => {
  app.requestDisplayMode({ mode: "fullscreen" }).catch(() => setStatus("このホストでは大きく表示できません。", true));
});
// 別の依頼のUIで回答した後に戻ってきたとき、受付箱を最新にする
window.addEventListener("focus", () => { void refreshInbox(); });

app.ontoolresult = (params) => {
  // 1回の呼び出しで複数の依頼が作られる。最初の依頼を表示し、残りは受付箱から選べる。
  const sc = params.structuredContent as { ids?: string[] } | undefined;
  const t = (params.content as { type: string; text?: string }[] | undefined)?.find((c) => c.type === "text")?.text;
  const id = sc?.ids?.[0] ?? t?.split(" ")[0];
  if (!id || toolId === id) return;
  toolId = id;
  const r = (params._meta as Record<string, unknown> | undefined)?.["inloop/repo"];
  if (typeof r === "string") repo = r;
  load(id).catch((e) => setStatus(String((e as Error).message ?? e), true));
};

app.onhostcontextchanged = (ctx) => applyContext(ctx as { theme?: string; availableDisplayModes?: string[] });

function applyContext(ctx: { theme?: string; availableDisplayModes?: string[] } | undefined) {
  if (!ctx) return;
  if (ctx.theme === "dark" || ctx.theme === "light") document.documentElement.dataset.theme = ctx.theme;
  if (ctx.availableDisplayModes?.includes("fullscreen")) $("full").hidden = false;
}

await app.connect();
applyContext(app.getHostContext() as { theme?: string; availableDisplayModes?: string[] } | undefined);
