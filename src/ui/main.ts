import { App } from "@modelcontextprotocol/ext-apps";
import type { Answer, AnswerRound, InboxItem, ReviewPacket, ReviewStep } from "../server/types.js";

type CommentVerdict = "fix" | "ask";
type Decision = "ok" | "hold";

interface DraftComment { key: number; verdict: CommentVerdict; ref?: string; comment: string }
interface Draft { decision?: Decision; comments: DraftComment[] }

/** 開いているコメント欄。symbolがなければ依頼全体へのコメント。 */
interface Composer {
  symbol?: string;
  start?: number;
  end?: number;
  stage: "choose" | "write";
  reviewId?: string;
  candidates: string[];
  verdict: CommentVerdict;
  text: string;
  editingKey?: number;
}

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
let shownId: string | undefined;
let inbox: InboxItem[] = [];
/** 別の呼び出しで出された未回答の依頼の数。この画面からは回答できない。 */
let elsewhere = 0;
const packets = new Map<string, ReviewPacket>();
/** 依頼と、同じ系列でそれより前の依頼に、これまで付いた回答。 */
const histories = new Map<string, AnswerRound[]>();
const drafts = new Map<string, Draft>();
let composer: Composer | null = null;
let keySeq = 0;

function setStatus(msg: string, isError = false) {
  const s = $("status");
  s.textContent = msg;
  s.className = isError ? "err" : "";
}

function draftOf(id: string): Draft {
  let d = drafts.get(id);
  if (!d) { d = { comments: [] }; drafts.set(id, d); }
  return d;
}

function structured<T>(r: { structuredContent?: unknown; isError?: boolean; content?: unknown }): T {
  if (r.isError) {
    const c = (r.content as { text?: string }[] | undefined)?.map((x) => x.text).join("\n");
    throw new Error(c || "tool error");
  }
  return r.structuredContent as T;
}

async function fetchPacket(id: string): Promise<{ packet: ReviewPacket; inbox: InboxItem[]; elsewhere?: number }> {
  const r = await app.callServerTool({ name: "inloop_get_request", arguments: { id } });
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
  // 行コメントの宛先候補を決めるため、未回答の依頼票をすべて手元に置く
  await Promise.all(inbox.filter((i) => i.status === "pending" && !packets.has(i.id)).map((i) => fetchPacket(i.id)));
  render();
}

async function refreshInbox() {
  if (!shownId) return;
  try {
    const data = await fetchPacket(shownId);
    inbox = data.inbox;
    elsewhere = data.elsewhere ?? 0;
    for (const id of drafts.keys()) if (inbox.find((i) => i.id === id)?.status !== "pending") drafts.delete(id);
    render();
  } catch { /* 表示中の依頼の再取得に失敗しても既存表示を保つ */ }
}

const pendingItems = () => inbox.filter((i) => i.status === "pending");

function candidatesFor(symbol: string): string[] {
  const ids = pendingItems().filter((i) => i.symbols.includes(symbol)).map((i) => i.id);
  return ids.sort((a, b) => (a === shownId ? -1 : b === shownId ? 1 : 0));
}

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

function viewpointOf(id: string): string {
  return inbox.find((i) => i.id === id)?.viewpoint ?? "";
}

// ---- 行の操作 ----

function onLineClick(step: ReviewStep, abs: number, shift: boolean) {
  if (shift && composer?.symbol === step.symbol && composer.start !== undefined) {
    const anchor = composer.start;
    composer.start = Math.min(anchor, abs);
    composer.end = Math.max(anchor, composer.end ?? anchor, abs);
    render();
    return;
  }
  const candidates = candidatesFor(step.symbol);
  if (candidates.length === 0) {
    setStatus("この行に対応する未回答の依頼はありません。", true);
    return;
  }
  composer = {
    symbol: step.symbol, start: abs, end: abs,
    stage: candidates.length > 1 ? "choose" : "write",
    reviewId: candidates.length === 1 ? candidates[0] : undefined,
    candidates, verdict: "fix", text: "",
  };
  setStatus("");
  render();
}

function openGeneralComposer(reviewId: string) {
  composer = { stage: "write", reviewId, candidates: [reviewId], verdict: "ask", text: "" };
  render();
}

function openEditComposer(reviewId: string, c: DraftComment) {
  const r = parseRef(c.ref);
  composer = {
    symbol: r?.start !== undefined ? r.symbol : undefined, start: r?.start, end: r?.end,
    stage: "write", reviewId, candidates: [reviewId], verdict: c.verdict, text: c.comment, editingKey: c.key,
  };
  render();
}

function commitComposer() {
  if (!composer?.reviewId) return;
  const text = composer.text.trim();
  if (!text) { setStatus("コメントを入力してください。", true); return; }
  const d = draftOf(composer.reviewId);
  const ref = composer.symbol !== undefined && composer.start !== undefined
    ? refOf(composer.symbol, composer.start, composer.end ?? composer.start) : undefined;
  if (composer.editingKey !== undefined) {
    const c = d.comments.find((x) => x.key === composer!.editingKey);
    if (c) { c.verdict = composer.verdict; c.comment = text; c.ref = ref; }
  } else {
    d.comments.push({ key: ++keySeq, verdict: composer.verdict, ref, comment: text });
  }
  d.decision = undefined;
  composer = null;
  setStatus("");
  render();
}

/** 保留中・回答待ちの依頼を未回答に戻す。会話には何も送らない。 */
async function reopen(id: string) {
  try {
    const r = await app.callServerTool({ name: "inloop_reopen", arguments: { from: toolId ?? shownId, ids: [id] } });
    const data = structured<{ inbox: InboxItem[]; elsewhere?: number }>(r);
    inbox = data.inbox;
    elsewhere = data.elsewhere ?? 0;
    // 行コメントの宛先候補にするため、依頼票を手元に置く
    if (!packets.has(id)) await fetchPacket(id);
    setStatus(`${id}を未回答に戻しました。`);
  } catch (e) {
    setStatus((e as Error).message, true);
  }
  render();
}

function answerText(a: Answer): string {
  const where = a.verdict === "ok" || a.verdict === "hold" ? "" : ` ${shortRef(a.ref)}`;
  return `${a.id} ${VERDICT_LABEL[a.verdict]}${where}${a.comment ? `: ${a.comment}` : ""}`;
}

function removeComment(reviewId: string, key: number) {
  const d = draftOf(reviewId);
  d.comments = d.comments.filter((c) => c.key !== key);
  render();
}

function renderComposer(): HTMLElement {
  const c = composer!;
  const box = el("div", "composer");
  box.dataset.composer = c.reviewId ?? "choose";
  box.addEventListener("click", (e) => e.stopPropagation());
  const where = c.symbol !== undefined && c.start !== undefined ? shortRef(refOf(c.symbol, c.start, c.end ?? c.start)) : "依頼全体";

  if (c.stage === "choose") {
    box.append(el("div", "composer-title", `${where} へのコメント: どの依頼に対するものですか?`));
    for (const id of c.candidates) {
      const b = button(`${id}: ${viewpointOf(id)}`, () => { c.reviewId = id; c.stage = "write"; render(); }, "choice");
      b.dataset.choose = id;
      box.append(b);
    }
    box.append(el("div", "row"));
    box.lastElementChild!.append(button("キャンセル", () => { composer = null; render(); }));
    return box;
  }

  box.append(el("div", "composer-title", `${c.reviewId} · ${where}`));
  const radios = el("div", "row");
  for (const v of ["fix", "ask"] as CommentVerdict[]) {
    const lab = el("label");
    const r = el("input");
    r.type = "radio";
    r.name = "composer-verdict";
    r.value = v;
    r.checked = c.verdict === v;
    r.addEventListener("change", () => { c.verdict = v; });
    lab.append(r, ` ${VERDICT_LABEL[v]}`);
    radios.append(lab);
  }
  const ta = el("textarea");
  ta.rows = 3;
  ta.placeholder = c.verdict === "fix" ? "どう直してほしいか" : "聞きたいこと";
  ta.value = c.text;
  ta.dataset.composerText = "";
  ta.addEventListener("input", () => { c.text = ta.value; });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commitComposer(); }
    if (e.key === "Escape") { composer = null; render(); }
  });
  const actions = el("div", "row");
  actions.append(
    button(c.editingKey !== undefined ? "更新" : "コメントを追加", commitComposer, "primary"),
    button("キャンセル", () => { composer = null; render(); }),
    el("span", "muted", "⌘/Ctrl+Enterで追加 · Shift+クリックで行範囲"),
  );
  box.append(radios, ta, actions);
  queueMicrotask(() => ta.focus());
  return box;
}

function renderBubble(reviewId: string, c: DraftComment): HTMLElement {
  const b = el("div", "bubble");
  b.dataset.bubble = `${reviewId}:${c.key}`;
  b.addEventListener("click", (e) => e.stopPropagation());
  const head = el("div", "row");
  head.append(el("span", "chip " + (c.verdict === "fix" ? "req" : ""), `${reviewId} ${VERDICT_LABEL[c.verdict]}`),
    el("span", "muted", shortRef(c.ref)), el("span", "spacer"),
    button("編集", () => openEditComposer(reviewId, c), "link"),
    button("削除", () => removeComment(reviewId, c.key), "link"));
  b.append(head, el("div", "bubble-text", c.comment));
  return b;
}

// ---- 描画 ----

function render() {
  renderDetail();
  renderAnswers();
  updateSend();
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
    kind.prepend(el("span", "chip ok state", ANSWERED_LABEL[item.status]), " ");
  }
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

  const allComments = [...drafts.entries()].flatMap(([id, d]) => d.comments.map((c) => ({ id, c, r: parseRef(c.ref) })));
  const steps = $("steps");
  steps.replaceChildren();
  for (const s of p.steps) {
    const box = el("div", "step");
    const h = el("header");
    h.append(el("span", "n", `${s.order}`), el("code", undefined, s.symbol), el("span", "chip", s.layer),
      el("span", "chip", s.change === "added" ? "追加" : "変更"));
    for (const b of s.boundaries) h.append(el("span", "chip req", b));
    const code = el("div", "code");
    s.code.split("\n").forEach((line, i) => {
      const abs = s.startLine + i;
      const selected = composer?.symbol === s.symbol && composer.start !== undefined && abs >= composer.start && abs <= (composer.end ?? composer.start);
      const commented = allComments.some((x) => x.r?.symbol === s.symbol && x.r.start !== undefined && abs >= x.r.start && abs <= (x.r.end ?? x.r.start));
      const ln = el("div", "ln" + (s.changedLines.includes(i + 1) ? " chg" : "") + (selected ? " sel" : "") + (commented ? " has-comment" : ""));
      ln.dataset.ref = `${s.symbol}#L${abs}`;
      ln.title = "クリックでコメント、Shift+クリックで範囲選択";
      const no = el("span", "no");
      no.append(el("span", "plus", "+"), String(abs));
      ln.append(no, el("span", "tx", line));
      ln.addEventListener("click", (e) => onLineClick(s, abs, e.shiftKey));
      code.append(ln);
      for (const x of allComments) {
        if (x.r?.symbol === s.symbol && (x.r.end ?? x.r.start) === abs && composer?.editingKey !== x.c.key) code.append(renderBubble(x.id, x.c));
      }
      if (composer && composer.symbol === s.symbol && (composer.end ?? composer.start) === abs) code.append(renderComposer());
    });
    box.append(h, code);
    steps.append(box);
  }
  const un = $("unresolved");
  un.replaceChildren(...(p.unresolved.length ? p.unresolved.map((u) => el("li", undefined, u)) : [el("li", "muted", "なし")]));
  const ev = $("evidence");
  ev.replaceChildren(...p.evidence.map((e) => {
    const li = el("li");
    const mark = e.status === "pass" ? "✓ 成功" : e.status === "fail" ? "✗ 失敗" : "! 未作成";
    li.append(el("span", `ev-${e.status}`, mark), ` ${e.kind === "test" ? "テスト" : "静的解析"}: ${e.name}`);
    return li;
  }));
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
    vp.addEventListener("click", () => { composer = null; load(item.id).catch((e) => setStatus(String((e as Error).message ?? e), true)); });
    head.append(el("span", item.kind === "required" ? "chip req" : "chip", item.kind === "required" ? "必須" : "任意"), vp,
      item.supersededBy ? nextButton(item.supersededBy)
        : el("span", pending ? "chip" : "chip ok", STATUS_LABEL[item.status] ?? item.status));
    row.append(head);
    if (REOPENABLE.has(item.status)) {
      const actions = el("div", "row actions");
      const back = button("未回答に戻す", () => { void reopen(item.id); });
      back.dataset.reopen = item.id;
      actions.append(back);
      row.append(actions);
    }
    if (pending) {
      const d = draftOf(item.id);
      const actions = el("div", "row actions");
      if (d.comments.length > 0) {
        actions.append(el("span", "summary", `コメント ${d.comments.length}件（${d.comments.some((c) => c.verdict === "fix") ? "修正依頼" : "質問"}として送信）`));
      } else {
        for (const v of ["ok", "hold"] as Decision[]) {
          const b = button(VERDICT_LABEL[v], () => { d.decision = d.decision === v ? undefined : v; render(); }, "toggle" + (d.decision === v ? " on" : ""));
          b.dataset.decision = v;
          b.setAttribute("aria-pressed", String(d.decision === v));
          actions.append(b);
        }
      }
      const general = button("依頼全体にコメント", () => openGeneralComposer(item.id), "link");
      general.dataset.general = item.id;
      actions.append(general);
      row.append(actions);
      // 依頼全体へのコメント（行に紐づかないもの）
      for (const c of d.comments.filter((x) => !parseRef(x.ref)?.start && composer?.editingKey !== x.key)) row.append(renderBubble(item.id, c));
      // 別の依頼票を表示中に、その依頼へ付けた行コメント
      if (item.id !== shownId) {
        const others = d.comments.filter((x) => parseRef(x.ref)?.start !== undefined);
        if (others.length) row.append(el("div", "muted", `行コメント: ${others.map((x) => shortRef(x.ref)).join("、")}`));
      }
      if (composer && composer.symbol === undefined && composer.reviewId === item.id) row.append(renderComposer());
    }
    box.append(row);
  }
  // この画面の依頼がすべて回答済みなら、回答の操作とほかの依頼の件数は出さない。
  const open = pendingItems().length > 0;
  $("answers-title").textContent = open ? "回答（未回答の依頼をまとめて送信）" : "回答";
  $("answers-help").hidden = !open;
  $("send").hidden = !open;
  $("all-answered").hidden = open || inbox.length === 0;
  if (open && elsewhere > 0) {
    const note = el("div", "item muted", `ほかに未回答の依頼が${elsewhere}件あります。それぞれが出された場所の画面から回答してください。`);
    note.dataset.elsewhere = String(elsewhere);
    box.append(note);
  }
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

function collect(): Answer[] {
  const answers: Answer[] = [];
  for (const item of pendingItems()) {
    const d = drafts.get(item.id);
    if (!d) continue;
    if (d.comments.length > 0) {
      for (const c of d.comments) {
        const a: Answer = { id: item.id, verdict: c.verdict, comment: c.comment };
        if (c.ref) a.ref = c.ref;
        answers.push(a);
      }
    } else if (d.decision) {
      answers.push({ id: item.id, verdict: d.decision });
    }
  }
  return answers;
}

function updateSend() {
  const answers = collect();
  const ids = new Set(answers.map((a) => a.id));
  const btn = $("send") as HTMLButtonElement;
  btn.disabled = answers.length === 0 || composer !== null;
  btn.textContent = answers.length > 0 ? `まとめて送信（${ids.size}件の依頼・${answers.length}行）` : "まとめて送信";
  btn.title = composer !== null ? "書きかけのコメントを追加するかキャンセルしてください" : "";
}

async function send() {
  const answers = collect();
  if (answers.length === 0) return;
  ($("send") as HTMLButtonElement).disabled = true;
  try {
    const r = await app.callServerTool({ name: "inloop_submit", arguments: { from: toolId ?? shownId, answers } });
    const data = structured<{ message: string; inbox: InboxItem[]; elsewhere?: number }>(r);
    inbox = data.inbox;
    elsewhere = data.elsewhere ?? 0;
    for (const a of answers) drafts.delete(a.id);
    // 再読み込みした時と同じ表示にするため、回答した依頼の記録を取り直す。
    await Promise.all([...new Set(answers.map((a) => a.id))].map((id) => fetchPacket(id).catch(() => undefined)));
    const res = await app.sendMessage({ role: "user", content: [{ type: "text", text: data.message }] });
    if (res.isError) setStatus("回答は記録しましたが、会話への送信をホストが拒否しました。AIにget_review_resultを使うよう伝えてください。", true);
    else setStatus(`${new Set(answers.map((a) => a.id)).size}件の依頼への回答を送信しました。`);
  } catch (e) {
    setStatus((e as Error).message, true);
  }
  render();
}

$("send").addEventListener("click", () => { void send(); });
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
