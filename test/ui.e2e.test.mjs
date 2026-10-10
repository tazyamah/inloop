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
const HEADER = "[inloop] レビュー回答。fixは修正後にrequest_reviewで差分を再依頼:";

async function setup({ theme = "light", requests = 2 } = {}) {
  const { chromium } = await import("playwright");
  const server = createServer();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "e2e", version: "0" });
  await client.connect(ct);
  if (requests > 1) await client.callTool({ name: "request_review", arguments: { viewpoint: "トークンの扱いは既存APIと揃っているか" } });
  const input = { viewpoint: "発送済みの注文をキャンセルしようとした時、409で返す方針でよいか", symbols: ["src/db/orders.ts#cancelOrder"], range: "a1b2c3..d4e5f6" };
  const result = await client.callTool({ name: "request_review", arguments: input });
  const id = result.structuredContent.id;

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
  return { browser, page, view, calls, messages, errors, id };
}

const line = (view, ref) => view.locator(`.ln[data-ref="${ref}"]`);

test("依頼が複数あると、行クリックで宛先の依頼を選んでから行の直下にコメントを書ける", { skip: !enabled }, async () => {
  const { browser, page, view, calls, messages, errors } = await setup();
  try {
    assert.equal(await view.locator("#title").textContent(), "inloop レビュー依頼 R2");
    assert.equal(await view.locator(".step").count(), 3);
    assert.equal(await view.locator("textarea").count(), 0, "最初はコメント欄を出さない");
    assert.ok(await view.locator("#send").isDisabled());

    // 44行目をクリック → 宛先選択（表示中のR2が先頭）
    await line(view, "src/db/orders.ts#cancelOrder#L44").click();
    const choices = view.locator(".composer [data-choose]");
    assert.deepEqual(await choices.evaluateAll((els) => els.map((e) => e.dataset.choose)), ["R2", "R1"]);
    await shot(page, "review-choose");
    await view.locator('.composer [data-choose="R1"]').click();

    // 行の直下にR1宛てのコメント欄。Shift+クリックで範囲にする
    assert.match(await view.locator(".composer-title").textContent(), /^R1 · cancelOrder L44$/);
    await line(view, "src/db/orders.ts#cancelOrder#L46").click({ modifiers: ["Shift"] });
    assert.match(await view.locator(".composer-title").textContent(), /^R1 · cancelOrder L44-L46$/);
    assert.equal(await view.locator(".ln.sel").count(), 3);
    const composerFollowsLine = await view.locator(".composer").evaluate((c) => c.previousElementSibling?.dataset.ref);
    assert.equal(composerFollowsLine, "src/db/orders.ts#cancelOrder#L46");
    assert.ok(await view.locator("#send").isDisabled(), "書きかけのコメントがある間は送信できない");
    await view.locator("[data-composer-text]").fill("SQLの組み立てを1行にまとめて");
    await view.locator(".composer button.primary").click();

    // 吹き出しになり、R1の行には承認/保留の代わりに件数が出る
    assert.equal(await view.locator('[data-bubble^="R1:"]').count(), 1);
    assert.match(await view.locator('.item[data-id="R1"] .summary').textContent(), /コメント 1件（修正依頼として送信）/);
    assert.equal(await view.locator('.item[data-id="R1"] [data-decision]').count(), 0);

    // 同じR1に質問を1行追加（⌘/Ctrl+Enterで追加）
    await line(view, "src/api/orders.ts#postCancel#L91").click();
    await view.locator('.composer [data-choose="R1"]').click();
    await view.locator('.composer input[value="ask"]').check();
    await view.locator("[data-composer-text]").fill("購読先はどこ?");
    await view.locator("[data-composer-text]").press("Control+Enter");
    assert.equal(await view.locator('[data-bubble^="R1:"]').count(), 2);

    // R2は承認
    await view.locator('.item[data-id="R2"] [data-decision="ok"]').click();
    assert.equal(await view.locator("#send").textContent(), "まとめて送信（2件の依頼・3行）");
    await shot(page, "review-answering");

    await view.locator("#send").click();
    await view.locator("#status", { hasText: "2件の依頼への回答を送信しました" }).waitFor({ timeout: 5000 });
    const submit = calls.find((c) => c.name === "inloop_submit");
    assert.deepEqual(submit.arguments.answers, [
      { id: "R1", verdict: "fix", comment: "SQLの組み立てを1行にまとめて", ref: "src/db/orders.ts#cancelOrder#L44-L46" },
      { id: "R1", verdict: "ask", comment: "購読先はどこ?", ref: "src/api/orders.ts#postCancel#L91" },
      { id: "R2", verdict: "ok" },
    ]);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].content[0].text, [
      HEADER,
      'R1 fix src/db/orders.ts#cancelOrder#L44-L46 "SQLの組み立てを1行にまとめて"',
      'R1 ask src/api/orders.ts#postCancel#L91 "購読先はどこ?"',
      "R2 ok",
    ].join("\n"));
    assert.equal(await view.locator('.item[data-id="R1"] .chip.ok').textContent(), "修正待ち");
    assert.equal(await view.locator('.item[data-id="R2"] .chip.ok').textContent(), "承認済み");
    assert.equal(await view.locator(".bubble").count(), 0);

    // 回答済みの依頼しかない行をクリックしても、コメント欄は開かない
    await line(view, "src/db/orders.ts#cancelOrder#L44").click();
    assert.equal(await view.locator(".composer").count(), 0);
    assert.match(await view.locator("#status").textContent(), /未回答の依頼はありません/);

    await view.locator("#full").click();
    assert.equal(await page.evaluate(() => window.__displayMode), "fullscreen");
    await shot(page, "review-sent");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test("依頼が1件なら選択なしでコメント欄が開き、編集・削除と依頼全体へのコメントができる", { skip: !enabled }, async () => {
  const { browser, view, messages, errors } = await setup({ requests: 1 });
  try {
    await line(view, "src/db/orders.ts#cancelOrder#L44").click();
    assert.equal(await view.locator(".composer [data-choose]").count(), 0);
    assert.match(await view.locator(".composer-title").textContent(), /^R1 · cancelOrder L44$/);
    // 空のコメントは追加できない
    await view.locator(".composer button.primary").click();
    assert.match(await view.locator("#status").textContent(), /コメントを入力してください/);
    await view.locator("[data-composer-text]").fill("最初の文");
    await view.locator(".composer button.primary").click();
    // 編集
    await view.locator('[data-bubble^="R1:"] button', { hasText: "編集" }).click();
    assert.equal(await view.locator("[data-composer-text]").inputValue(), "最初の文");
    await view.locator("[data-composer-text]").fill("直した文");
    await view.locator(".composer button.primary", { hasText: "更新" }).click();
    assert.match(await view.locator('[data-bubble^="R1:"] .bubble-text').textContent(), /^直した文$/);
    // 削除すると承認/保留に戻る
    await view.locator('[data-bubble^="R1:"] button', { hasText: "削除" }).click();
    assert.equal(await view.locator('.item[data-id="R1"] [data-decision]').count(), 2);
    // Escでキャンセル
    await line(view, "src/db/orders.ts#cancelOrder#L45").click();
    await view.locator("[data-composer-text]").press("Escape");
    assert.equal(await view.locator(".composer").count(), 0);
    // 依頼全体へのコメント
    await view.locator('[data-general="R1"]').click();
    await view.locator("[data-composer-text]").fill("全体として妥当?");
    await view.locator(".composer button.primary").click();
    await view.locator("#send").click();
    await view.locator("#status", { hasText: "1件の依頼への回答を送信しました" }).waitFor({ timeout: 5000 });
    assert.equal(messages[0].content[0].text, `${HEADER}\nR1 ask "全体として妥当?"`);
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
    await line(view, "src/db/orders.ts#cancelOrder#L44").click();
    await view.locator('.composer [data-choose="R1"]').click();
    await shot(page, "review-dark");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
