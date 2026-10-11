// 実ブラウザでのUI検証。Playwrightが使える環境で INLOOP_UI_E2E=1 のときだけ実行する。
// Chromiumの場所を指定する場合は INLOOP_CHROMIUM、画面写真を残す場合は INLOOP_SHOT_DIR を使う。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../dist/server/create-server.js";

const enabled = process.env.INLOOP_UI_E2E === "1";
const shot = (page, name) => process.env.INLOOP_SHOT_DIR ? page.screenshot({ path: `${process.env.INLOOP_SHOT_DIR}/${name}.png`, fullPage: true }) : undefined;
const HEADER = "[inloop] レビュー回答。fixは修正後にrequest_reviewのfollowsで再依頼、askは会話で答える:";

async function setup({ theme = "light", requests = 2, elsewhere = 0, prepare } = {}) {
  const { chromium } = await import("playwright");
  const server = createServer();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "e2e", version: "0" });
  await client.connect(ct);
  // 依頼は1回の呼び出しでまとめて出す。同じ呼び出しの依頼が、1つのUIの受付箱に並ぶ。
  const main = { viewpoint: "発送済みの注文をキャンセルしようとした時、409で返す方針でよいか", symbols: ["src/db/orders.ts#cancelOrder"] };
  const reviews = requests > 1 ? [{ viewpoint: "トークンの扱いは既存APIと揃っているか" }, main] : [main];
  // prepareは、UIを開く呼び出しの前にサーバーの状態を作り、その呼び出しの引数を返す。
  const input = prepare ? await prepare(client) : { reviews, range: "a1b2c3..d4e5f6" };
  const result = await client.callTool({ name: "request_review", arguments: input });
  const id = result.structuredContent.ids[0];
  // 別の呼び出しで出された依頼。このUIには出ない。
  for (let i = 0; i < elsewhere; i++) await client.callTool({ name: "request_review", arguments: { reviews: [{ viewpoint: `別に出された依頼${i + 1}` }] } });

  const hostJs = (await build({ entryPoints: [new URL("./harness/host.mjs", import.meta.url).pathname], bundle: true, format: "esm", write: false })).outputFiles[0].text;
  const reviewHtml = await readFile(new URL("../dist/ui/review.html", import.meta.url), "utf8");

  const browser = await chromium.launch(process.env.INLOOP_CHROMIUM ? { executablePath: process.env.INLOOP_CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: 900, height: 1000 }, colorScheme: theme });
  const calls = [];
  const messages = [];
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.exposeFunction("__callTool", async (json) => {
    const params = JSON.parse(json);
    calls.push(params);
    return JSON.stringify(await client.callTool(params));
  });
  await page.exposeFunction("__onMessage", async (json) => { messages.push(JSON.parse(json)); });
  // setContentでは初期化スクリプトが走らないため、ホストへ渡す値はページ内に埋め込む。
  const globals = { __REVIEW_HTML: reviewHtml, __TOOL_INPUT: input, __TOOL_RESULT: result, __THEME: theme };
  const data = Object.entries(globals).map(([k, v]) => `window.${k}=${JSON.stringify(v).replace(/</g, "\\u003c")};`).join("");
  await page.setContent(`<!doctype html><html><body style="margin:0"><script>${data}</script><script type="module">${hostJs}</script></body></html>`);
  const view = page.frameLocator("#view");
  await view.locator("#detail").waitFor({ state: "visible", timeout: 10000 });
  return { browser, page, view, calls, messages, errors, id, client };
}

const line = (view, ref) => view.locator(`.ln[data-ref="${ref}"]`);

test("依頼票を表示し、行のクリックで位置をコピーする（コメント欄はない）", { skip: !enabled }, async () => {
  const { browser, page, view, errors } = await setup();
  try {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
    assert.equal(await view.locator("#title").textContent(), "inloop レビュー依頼 R1", "最初の依頼を表示する");
    assert.equal(await view.locator(".step").count(), 3);
    assert.equal(await view.locator("textarea").count(), 0, "コメント欄はない（議論は会話で、ADR-0018）");
    assert.equal(await view.locator("#send").count(), 0, "まとめて送信はない");
    await line(view, "src/db/orders.ts#cancelOrder#L44").click();
    await view.locator("#status", { hasText: "コピーしました: R1 src/db/orders.ts#cancelOrder#L44" }).waitFor({ timeout: 5000 });
    await line(view, "src/db/orders.ts#cancelOrder#L46").click({ modifiers: ["Shift"] });
    await view.locator("#status", { hasText: "コピーしました: R1 src/db/orders.ts#cancelOrder#L44-L46" }).waitFor({ timeout: 5000 });
    assert.equal(await view.locator(".ln.sel").count(), 3);
    await view.locator('[data-copy="src/db/orders.ts#cancelOrder"]').click();
    await view.locator("#status", { hasText: "コピーしました: R1 src/db/orders.ts#cancelOrder" }).waitFor({ timeout: 5000 });
    await shot(page, "review-copy");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test("承認・保留は押したらすぐ記録し、会話に届ける。まとめて承認もできる", { skip: !enabled }, async () => {
  const { browser, page, view, calls, messages, errors } = await setup();
  try {
    assert.equal(await view.locator("#approve-all").textContent(), "まとめて承認（2件）");
    await view.locator('.item[data-id="R2"] [data-decision="hold"]').click();
    await view.locator("#status", { hasText: "R2を保留として記録しました。" }).waitFor({ timeout: 5000 });
    assert.deepEqual(calls.find((c) => c.name === "inloop_submit").arguments, { from: "R1", answers: [{ id: "R2", verdict: "hold" }] });
    assert.equal(messages[0].content[0].text, `${HEADER}\nR2 hold`);
    assert.equal(await view.locator('.item[data-id="R2"] .chip.ok').textContent(), "保留中");
    assert.equal(await view.locator("#approve-all").isHidden(), true, "未回答が1件なら、まとめて承認は出さない");
    await view.locator('.item[data-id="R1"] [data-decision="ok"]').click();
    await view.locator("#status", { hasText: "R1を承認として記録しました。" }).waitFor({ timeout: 5000 });
    assert.equal(messages[1].content[0].text, `${HEADER}\nR1 ok`);
    assert.equal(await view.locator("#kind .state").textContent(), "承認済み");
    assert.equal(await view.locator("#all-answered").isVisible(), true);
    await view.locator("#full").click();
    await page.waitForFunction(() => window.__displayMode === "fullscreen", null, { timeout: 5000 });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test("まとめて承認で、画面の未回答の依頼をすべて承認する", { skip: !enabled }, async () => {
  const { browser, view, messages, errors } = await setup();
  try {
    await view.locator("#approve-all").click();
    await view.locator("#status", { hasText: "2件の依頼を承認として記録しました。" }).waitFor({ timeout: 5000 });
    assert.equal(messages[0].content[0].text, `${HEADER}\nR1 ok\nR2 ok`);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test("ダークテーマのホストでも描画できる", { skip: !enabled }, async () => {
  const { browser, page, view, errors } = await setup({ theme: "dark" });
  try {
    const bg = await view.locator("body").evaluate((b) => getComputedStyle(b).backgroundColor);
    assert.equal(bg, "rgb(13, 17, 23)");
    await shot(page, "review-dark");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test("別の呼び出しで出された依頼は受付箱に出ず、件数だけを知らせる", { skip: !enabled }, async () => {
  const { browser, page, view, errors } = await setup({ elsewhere: 2 });
  try {
    assert.deepEqual(await view.locator(".item[data-id]").evaluateAll((els) => els.map((e) => e.dataset.id)), ["R1", "R2"]);
    assert.equal(await view.locator("[data-elsewhere]").getAttribute("data-elsewhere"), "2");
    await shot(page, "review-elsewhere");
    await view.locator("#approve-all").click();
    await view.locator("#status", { hasText: "2件の依頼を承認として記録しました。" }).waitFor({ timeout: 5000 });
    assert.equal(await view.locator("[data-elsewhere]").count(), 0, "すべて回答した後は、ほかの依頼の件数を出さない");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test("保留中の依頼を未回答に戻して答え直せ、再依頼済みの依頼は引き継ぎ先を示す", { skip: !enabled }, async () => {
  const { browser, page, view, calls, messages, errors, client } = await setup();
  try {
    await view.locator('.item[data-id="R1"] [data-decision="hold"]').click();
    await view.locator("#status", { hasText: "R1を保留として記録しました。" }).waitFor({ timeout: 5000 });
    assert.equal(await view.locator("#kind .state").textContent(), "回答済み（保留）");
    assert.deepEqual(await view.locator("#own li").allTextContents(), ["R1 保留"]);
    await view.locator('[data-reopen="R1"]').click();
    await view.locator("#status", { hasText: "R1を未回答に戻しました" }).waitFor({ timeout: 5000 });
    assert.deepEqual(calls.find((c) => c.name === "inloop_reopen").arguments, { from: "R1", ids: ["R1"] });
    assert.equal(messages.length, 1, "未回答に戻したことは会話に送らない");
    await view.locator('.item[data-id="R1"] [data-decision="ok"]').click();
    await view.locator("#status", { hasText: "R1を承認として記録しました。" }).waitFor({ timeout: 5000 });
    assert.equal(messages[1].content[0].text, `${HEADER}\nR1 ok`);

    // AIが保留中のR2を再依頼すると、この画面のR2は再依頼済みになり、引き継ぎ先を示す。
    await view.locator('.item[data-id="R2"] [data-decision="hold"]').click();
    await view.locator("#status", { hasText: "R2を保留として記録しました。" }).waitFor({ timeout: 5000 });
    const again = await client.callTool({ name: "request_review", arguments: { reviews: [{ follows: "R2" }] } });
    assert.equal(again.content[0].text, "R2-1 pending");
    await view.locator("body").evaluate(() => window.dispatchEvent(new Event("focus")));
    await view.locator('.item[data-id="R2"] [data-next="R2-1"]', { hasText: "再依頼済み → R2-1" }).waitFor({ timeout: 5000 });
    assert.equal(await view.locator("[data-reopen]").count(), 0);
    await view.locator('.item[data-id="R2"] [data-next="R2-1"]').click();
    await view.locator("#status", { hasText: "R2-1は、再依頼した会話の画面から開いてください" }).waitFor({ timeout: 5000 });
    await shot(page, "review-superseded");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test("再依頼の画面には、元の依頼への指摘が出て、枝番のIDで回答する", { skip: !enabled }, async () => {
  const { browser, page, view, calls, messages, errors, id } = await setup({
    prepare: async (client) => {
      await client.callTool({ name: "request_review", arguments: { reviews: [{ viewpoint: "発送済みの注文は409でよいか", symbols: ["src/db/orders.ts#cancelOrder"] }] } });
      await client.callTool({ name: "inloop_submit", arguments: { from: "R1", answers: [
        { id: "R1", verdict: "fix", ref: "src/db/orders.ts#cancelOrder#L44-L46", comment: "SQLを1行にまとめて" },
        { id: "R1", verdict: "ask", comment: "テストはある?" },
      ] } });
      return { reviews: [{ follows: "R1" }], range: "d4e5f6..0a1b2c" };
    },
  });
  try {
    assert.equal(id, "R1-1");
    assert.equal(await view.locator("#title").textContent(), "inloop レビュー依頼 R1-1");
    assert.equal(await view.locator("#viewpoint").textContent(), "発送済みの注文は409でよいか");
    assert.match(await view.locator("#meta").textContent(), /^R1の再依頼（1回目） ・ 範囲: d4e5f6\.\.0a1b2c/);
    assert.deepEqual(await view.locator("#history li").allTextContents(), [
      "R1 修正依頼 cancelOrder L44-L46: SQLを1行にまとめて",
      "R1 質問 依頼全体: テストはある?",
    ]);
    assert.deepEqual(await view.locator(".item[data-id]").evaluateAll((els) => els.map((e) => e.dataset.id)), ["R1-1"]);
    await shot(page, "review-rerequest");
    await line(view, "src/db/orders.ts#cancelOrder#L44").click();
    await view.locator("#status", { hasText: "コピーしました: R1-1 src/db/orders.ts#cancelOrder#L44" }).waitFor({ timeout: 5000 });
    await view.locator('.item[data-id="R1-1"] [data-decision="ok"]').click();
    await view.locator("#status", { hasText: "R1-1を承認として記録しました。" }).waitFor({ timeout: 5000 });
    assert.deepEqual(calls.find((c) => c.name === "inloop_submit").arguments, { from: "R1-1", answers: [{ id: "R1-1", verdict: "ok" }] });
    assert.equal(messages[0].content[0].text, `${HEADER}\nR1-1 ok`);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
