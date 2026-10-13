// docs/diagrams.md のサンプル（画像と依頼票の抜粋）を、実際のエンジンとUIで作り直す。
// 使い方: npm run build && node scripts/diagram-samples.mjs [出力先=docs/diagrams]
// Playwright（Chromium）が要る。場所を指定するときは INLOOP_CHROMIUM。
// 手書きの値は入れない。題材のアプリは `inloop new` と `inloop generate scaffold` で作り、
// 変更を足して `request_review` を呼ぶ。出力はすべて、その依頼票とUIから取る。
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(process.argv[2] ?? join(root, "docs", "diagrams"));
const { createServer } = await import(join(root, "dist/server/create-server.js"));
const { Targets } = await import(join(root, "dist/server/target.js"));
const { chromium } = await import("playwright");

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "inloop-diagrams-")));
const app = join(tmp, "tasks-demo");
// アプリの登録先（~/.inloop など）を汚さない。
const env = { ...process.env, HOME: tmp, USERPROFILE: tmp };
const cli = (...args) => execFileSync("node", [join(root, "dist/cli.js"), ...args], { cwd: args[0] === "new" ? tmp : app, env, stdio: "pipe" });
const git = (...args) => execFileSync("git", ["-C", app, "-c", "user.name=demo", "-c", "user.email=demo@example.com", ...args], { stdio: "pipe" });
const read = (f) => readFileSync(join(app, f), "utf8");
const write = (f, s) => writeFileSync(join(app, f), s);
const replace = (f, from, to) => {
  const s = read(f);
  if (!s.includes(from)) throw new Error(`${f}: 置き換え元が見つからない（雛形が変わった？）`);
  write(f, s.replace(from, to));
};

try {
  // 1. 題材のアプリ（雛形＋scaffoldの表）をcommitして、基点にする。
  cli("new", app, "--name", "tasks-demo");
  cli("generate", "scaffold", "task", "title:text", "done:bool", "due:date:optional", "--label", "タスク");
  // 型を解決するため、依存を入れる（入れないと node:sqlite や hono の呼び出しが「未解決」になる）。
  execFileSync("npm", ["install", "--no-audit", "--no-fund", "--silent"], { cwd: app, stdio: "pipe" });
  git("add", "-A");
  git("commit", "-q", "-m", "base");

  // 2. 変更: 完了済みのタスクだけ削除できるようにする（DELETEの処理を関数に分ける）。表に列も足す。
  replace("server/routes/tasks.ts", "export function tasksRoutes(db: Db) {", `/** 完了済みか。タスクがなければundefined。 */
function isDone(db: Db, id: number): boolean | undefined {
  const row = db.prepare("SELECT done FROM tasks WHERE id = ?").get(id) as { done: number } | undefined;
  return row === undefined ? undefined : row.done === 1;
}

/** 完了済みのタスクだけ削除する。未完了は"open"、なければ"missing"。 */
export function removeTask(db: Db, id: number, onRemoved?: (id: number) => void): "removed" | "open" | "missing" {
  const done = isDone(db, id);
  if (done === undefined) return "missing";
  if (!done) return "open";
  db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
  onRemoved?.(id);
  notifyRemoved({}, "removed", id);
  return "removed";
}

/** 削除の通知。通知の種類は実行時に決まる（動的な呼び出し）。 */
export function notifyRemoved(hooks: Record<string, (id: number) => void>, kind: string, id: number): void {
  hooks[kind](id);
}

export function tasksRoutes(db: Db) {`);
  replace("server/routes/tasks.ts", `    const result = id === undefined ? undefined : db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    return result && result.changes > 0 ? c.body(null, 204) : c.json({ error: "not found" }, 404);`, `    const result = id === undefined ? "missing" : removeTask(db, id);
    if (result === "open") return c.json({ error: "未完了のタスクは削除できない" }, 409);
    return result === "removed" ? c.body(null, 204) : c.json({ error: "not found" }, 404);`);
  replace("server/db.ts", "  // inloop:tables", "  try { db.exec(\"ALTER TABLE tasks ADD COLUMN priority INTEGER\"); } catch { /* 追加済み */ }\n  // inloop:tables");

  // 3. 実際のサーバー（request_review）で依頼票を作り、実際のUIを実ブラウザで開く。
  const hostJs = (await build({ entryPoints: [join(root, "test/harness/host.mjs")], bundle: true, format: "esm", write: false })).outputFiles[0].text;
  const reviewHtml = readFileSync(join(root, "dist/ui/review.html"), "utf8");
  const browser = await chromium.launch(process.env.INLOOP_CHROMIUM ? { executablePath: process.env.INLOOP_CHROMIUM } : {});
  mkdirSync(out, { recursive: true });
  const packets = {};

  async function connect() {
    const server = createServer(new Targets({ repo: app }));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "diagram-samples", version: "0" });
    await client.connect(ct);
    return client;
  }
  /** 実際のレビューUIを、会話内の表示と同じ方法（MCP Appsのホスト）で開く。 */
  async function openUi(client, input, result, theme) {
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 }, colorScheme: theme });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.exposeFunction("__callTool", async (json) => JSON.stringify(await client.callTool(JSON.parse(json))));
    await page.exposeFunction("__onPosition", async () => {});
    await page.exposeFunction("__onMessage", async () => {});
    const globals = { __REVIEW_HTML: reviewHtml, __TOOL_INPUT: input, __TOOL_RESULT: result, __THEME: theme };
    const data = Object.entries(globals).map(([k, v]) => `window.${k}=${JSON.stringify(v).replace(/</g, "\\u003c")};`).join("");
    await page.setContent(`<!doctype html><html><body style="margin:0"><script>${data}</script><script type="module">${hostJs}</script></body></html>`);
    const view = page.frameLocator("#view");
    await view.locator("#detail").waitFor({ state: "visible", timeout: 15000 });
    return { page, view, errors };
  }
  const packetOf = async (client, id) => (await client.callTool({ name: "inloop_get_request", arguments: { id } })).structuredContent.packet;
  /** 依頼を出し、UIを開いて、after({view, ids, packets})を呼ぶ。 */
  async function session(input, theme, after) {
    const client = await connect();
    const result = await client.callTool({ name: "request_review", arguments: input });
    const ids = result.structuredContent.ids;
    const ui = await openUi(client, input, result, theme);
    // UIが表示しているのと同じ依頼票を、同じツールで取る。
    const packets = Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await packetOf(client, id)])));
    await after({ view: ui.view, ids, packets });
    if (ui.errors.length) throw new Error(`画面のエラー: ${ui.errors.join("; ")}`);
    await ui.page.close();
    return { ids, packets };
  }

  const request = (symbols, viewpoint, extra = {}) => ({ reviews: [{ viewpoint, symbols }], range: "HEAD", ...extra });
  const shotOf = async (view, selector, file) => {
    const el = view.locator(selector);
    await el.waitFor({ state: "visible", timeout: 5000 });
    await el.screenshot({ path: join(out, file) });
  };
  const excerpt = (p) => ({
    id: p.id,
    kind: p.kind,
    triggeredBy: p.triggeredBy,
    requestedSymbols: p.requestedSymbols,
    range: p.range,
    steps: p.steps.map(({ order, symbol, file, layer, boundaries, change, changedLines }) => ({ order, symbol, file, layer, boundaries, change, changedLines })),
    edges: p.edges,
    callers: p.callers?.map(({ symbol, file, startLine }) => ({ symbol, file, startLine })),
    tables: p.tables,
    unresolved: p.unresolved,
    ...(p.prior ? { prior: p.prior } : {}),
  });

  // A: 依存の図（呼び出し元・表の読み書きつき）。ライトとダーク。
  const a = request(["server/routes/tasks.ts#removeTask"], "完了済みのタスクだけ削除し、未完了は409にする方針でよいか");
  for (const theme of ["light", "dark"]) {
    await session(a, theme, async ({ view, ids, packets: ps }) => {
      await shotOf(view, "#graph-box", `graph-${theme}.png`);
      if (theme !== "light") return;
      await shotOf(view, "#tables-box", "tables-light.png");
      packets.graph = excerpt(ps[ids[0]]);
      // 同じ呼び出しで、信頼境界ルールが作った必須の依頼（範囲の変更すべてに当てる）。tasksRoutesの依頼を開く。
      const req = ids.find((id) => ps[id].kind === "required" && ps[id].requestedSymbols.includes("server/routes/tasks.ts#tasksRoutes"));
      await view.locator(`.item[data-id="${req}"] .vp`).click();
      await view.locator("#title", { hasText: `inloop レビュー依頼 ${req}` }).waitFor({ timeout: 5000 });
      await shotOf(view, "#graph-box", "graph-required.png");
      await shotOf(view, "#tables-box", "tables-required.png");
      await shotOf(view, '.step[data-symbol="server/routes/tasks.ts#tasksRoutes"] header', "step-boundaries.png");
      packets.required = excerpt(ps[req]);
    });
  }

  // D: 解決できない参照（動的な呼び出し）。推測でつながず、「未解決」と出す。
  await session(request(["server/routes/tasks.ts#notifyRemoved"], "通知の呼び出しは、この形でよいか"), "light", async ({ view, ids, packets: ps }) => {
    await shotOf(view, "#graph-box", "graph-unresolved.png");
    await shotOf(view, "#unresolved", "unresolved-list.png");
    packets.unresolved = excerpt(ps[ids[0]]);
  });

  // C: 再依頼。コードを少し直し、`follows`で出し直すと、変わらなかったシンボルは「から変更なし」で畳まれる。
  {
    const client = await connect();
    const first = await client.callTool({ name: "request_review", arguments: a });
    const firstId = first.structuredContent.ids[0];
    replace("server/routes/tasks.ts", `  if (!done) return "open";`, `  if (!done) return "open"; // 未完了は消さない`);
    const input = { reviews: [{ follows: firstId, viewpoint: "コメントを足した。方針は同じ", symbols: ["server/routes/tasks.ts#removeTask"] }], range: "HEAD" };
    const re = await client.callTool({ name: "request_review", arguments: input });
    packets.rerequest = excerpt(await packetOf(client, re.structuredContent.ids[0]));
    const ui = await openUi(client, input, re, "light");
    await shotOf(ui.view, "#steps", "steps-rerequest.png");
    if (ui.errors.length) throw new Error(`画面のエラー: ${ui.errors.join("; ")}`);
    await ui.page.close();
  }

  await browser.close();
  writeFileSync(join(out, "packets.json"), `${JSON.stringify(packets, null, 2)}\n`);
  process.stdout.write(`書き出しました: ${out}\n`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
