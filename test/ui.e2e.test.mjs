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

test("依頼が複数あると、行クリックで宛先の依頼を選んでから行の直下にコメントを書ける", { skip: !enabled }, async () => {
  const { browser, page, view, calls, messages, errors } = await setup();
  try {
    assert.equal(await view.locator("#title").textContent(), "inloop レビュー依頼 R1", "最初の依頼を表示する");
    assert.equal(await view.locator(".step").count(), 3);
    assert.equal(await view.locator("textarea").count(), 0, "最初はコメント欄を出さない");
    assert.ok(await view.locator("#send").isDisabled());

    // 44行目をクリック → 宛先選択（表示中のR1が先頭）
    await line(view, "src/db/orders.ts#cancelOrder#L44").click();
    const choices = view.locator(".composer [data-choose]");
    assert.deepEqual(await choices.evaluateAll((els) => els.map((e) => e.dataset.choose)), ["R1", "R2"]);
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
    assert.equal(submit.arguments.from, "R1");
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

    // 回答済みの依頼しかない行をクリックしても、コメント欄は開かず、位置をコピーする（ADR-0017）
    await line(view, "src/db/orders.ts#cancelOrder#L44").click();
    assert.equal(await view.locator(".composer").count(), 0);
    await view.locator("#status", { hasText: "R1 src/db/orders.ts#cancelOrder#L44" }).waitFor({ timeout: 5000 });

    await view.locator("#full").click();
    // 要求はiframeからホストへ非同期に届くので、届くまで待つ。
    await page.waitForFunction(() => window.__displayMode === "fullscreen", null, { timeout: 5000 });
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

test("別の呼び出しで出された依頼は受付箱に出ず、件数だけを知らせる", { skip: !enabled }, async () => {
  const { browser, page, view, messages, errors } = await setup({ elsewhere: 2 });
  try {
    assert.deepEqual(await view.locator(".item[data-id]").evaluateAll((els) => els.map((e) => e.dataset.id)), ["R1", "R2"]);
    assert.match(await view.locator("[data-elsewhere]").textContent(), /ほかに未回答の依頼が2件あります/);
    // 行コメントの宛先候補にも、別に出された依頼は出ない。
    await line(view, "src/db/orders.ts#cancelOrder#L44").click();
    assert.deepEqual(await view.locator(".composer [data-choose]").evaluateAll((els) => els.map((e) => e.dataset.choose)), ["R1", "R2"]);
    await view.locator(".composer").getByRole("button", { name: "キャンセル", exact: true }).click();
    await shot(page, "review-elsewhere");
    await view.locator('.item[data-id="R1"] [data-decision="ok"]').click();
    await view.locator('.item[data-id="R2"] [data-decision="ok"]').click();
    await view.locator("#send").click();
    await view.locator("#status", { hasText: "2件の依頼への回答を送信しました" }).waitFor({ timeout: 5000 });
    assert.equal(messages[0].content[0].text, `${HEADER}\nR1 ok\nR2 ok`);
    // すべて回答した後は、回答の操作とほかの依頼の件数を出さず、回答済みと示す。
    assert.equal(await view.locator("[data-elsewhere]").count(), 0);
    assert.equal(await view.locator("#all-answered").isVisible(), true);
    assert.equal(await view.locator("#send").isHidden(), true);
    assert.equal(await view.locator("#kind .state").textContent(), "承認済み");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test("保留中・回答待ちの依頼を未回答に戻して回答し直せ、再依頼済みの依頼は引き継ぎ先を示す", { skip: !enabled }, async () => {
  const { browser, page, view, calls, messages, errors, client } = await setup();
  try {
    assert.equal(await view.locator("#history-box").isHidden(), true, "前の依頼がなければ、前の依頼への回答は出さない");
    assert.equal(await view.locator("#own-box").isHidden(), true, "回答がまだなければ、この依頼への回答は出さない");
    await view.locator('.item[data-id="R1"] [data-decision="hold"]').click();
    await view.locator('[data-general="R2"]').click();
    await view.locator("[data-composer-text]").fill("既存APIはどれ?");
    await view.locator(".composer button.primary").click();
    await view.locator("#send").click();
    await view.locator("#status", { hasText: "2件の依頼への回答を送信しました" }).waitFor({ timeout: 5000 });
    assert.equal(await view.locator('.item[data-id="R1"] .chip.ok').textContent(), "保留中");
    assert.equal(await view.locator('.item[data-id="R2"] .chip.ok').textContent(), "回答待ち");
    // 回答した直後から、再読み込みした時と同じ記録を出す。
    assert.equal(await view.locator("#kind .state").textContent(), "回答済み（保留）");
    assert.deepEqual(await view.locator("#own li").allTextContents(), ["R1 保留"]);
    assert.deepEqual(await view.locator("[data-reopen]").evaluateAll((els) => els.map((e) => e.dataset.reopen)), ["R1", "R2"]);
    await shot(page, "review-reopen");

    // 回答待ちのR2を未回答に戻す。会話には何も送らない。
    await view.locator('[data-reopen="R2"]').click();
    await view.locator("#status", { hasText: "R2を未回答に戻しました" }).waitFor({ timeout: 5000 });
    assert.deepEqual(calls.find((c) => c.name === "inloop_reopen").arguments, { from: "R1", ids: ["R2"] });
    assert.equal(messages.length, 1);
    assert.equal(await view.locator('.item[data-id="R2"] [data-decision]').count(), 2);
    assert.equal(await view.locator('[data-reopen="R2"]').count(), 0);
    // R2の依頼票を開くと、戻す前の質問が「この依頼への回答」に記録として残っている。
    await view.locator('.item[data-id="R2"] .vp').click();
    await view.locator("#title", { hasText: "R2" }).waitFor({ timeout: 5000 });
    assert.deepEqual(await view.locator("#own li").allTextContents(), ["R2 質問 依頼全体: 既存APIはどれ?"]);
    assert.equal(await view.locator("#history-box").isHidden(), true);
    await view.locator('.item[data-id="R2"] [data-decision="ok"]').click();
    await view.locator("#send").click();
    await view.locator("#status", { hasText: "1件の依頼への回答を送信しました" }).waitFor({ timeout: 5000 });
    assert.equal(messages[1].content[0].text, `${HEADER}\nR2 ok`);
    assert.equal(await view.locator('.item[data-id="R2"] .chip.ok').textContent(), "承認済み");

    // AIが保留中のR1を再依頼すると、この画面のR1は再依頼済みになり、戻すことも回答することもできない。
    const again = await client.callTool({ name: "request_review", arguments: { reviews: [{ follows: "R1" }] } });
    assert.equal(again.content[0].text, "R1-1 pending");
    await view.locator("body").evaluate(() => window.dispatchEvent(new Event("focus")));
    await view.locator('.item[data-id="R1"] [data-next="R1-1"]', { hasText: "再依頼済み → R1-1" }).waitFor({ timeout: 5000 });
    // MCP Appsのホストでは、引き継ぎ先の画面は再依頼した会話にあると案内する。
    await view.locator('.item[data-id="R1"] [data-next="R1-1"]').click();
    await view.locator("#status", { hasText: "R1-1は、再依頼した会話の画面から開いてください" }).waitFor({ timeout: 5000 });
    assert.equal(await view.locator("[data-reopen]").count(), 0);
    assert.equal(await view.locator('.item[data-id="R1"] [data-decision]').count(), 0);
    assert.equal(await view.locator(".item[data-id]").count(), 2, "再依頼は、この画面の受付箱には入らない");
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
    // 行コメントも枝番のIDに付く。
    await line(view, "src/db/orders.ts#cancelOrder#L44").click();
    assert.match(await view.locator(".composer-title").textContent(), /^R1-1 · cancelOrder L44$/);
    await view.locator("[data-composer-text]").press("Escape");
    await view.locator('.item[data-id="R1-1"] [data-decision="ok"]').click();
    await view.locator("#send").click();
    await view.locator("#status", { hasText: "1件の依頼への回答を送信しました" }).waitFor({ timeout: 5000 });
    assert.deepEqual(calls.find((c) => c.name === "inloop_submit").arguments, { from: "R1-1", answers: [{ id: "R1-1", verdict: "ok" }] });
    assert.equal(messages[0].content[0].text, `${HEADER}\nR1-1 ok`);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test("位置をコピーでき、回答済みの依頼では行のクリックで位置をコピーする", { skip: !enabled }, async () => {
  const { browser, page, view, errors } = await setup({ requests: 1 });
  try {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
    await view.locator('[data-copy="src/db/orders.ts#cancelOrder"]').click();
    await view.locator("#status", { hasText: "コピーしました: R1 src/db/orders.ts#cancelOrder" }).waitFor({ timeout: 5000 });
    // コメント欄の中から、選んだ範囲の位置をコピーする。
    await line(view, "src/db/orders.ts#cancelOrder#L44").click();
    await line(view, "src/db/orders.ts#cancelOrder#L46").click({ modifiers: ["Shift"] });
    await view.locator('[data-copy="composer"]').click();
    await view.locator("#status", { hasText: "コピーしました: R1 src/db/orders.ts#cancelOrder#L44-L46" }).waitFor({ timeout: 5000 });
    await view.locator("[data-composer-text]").press("Escape");
    // 回答した後は、行のクリックで位置をコピーする（会話で「ここの範囲」と話すため）。
    await view.locator('.item[data-id="R1"] [data-decision="hold"]').click();
    await view.locator("#send").click();
    await view.locator("#status", { hasText: "1件の依頼への回答を送信しました" }).waitFor({ timeout: 5000 });
    await line(view, "src/db/orders.ts#cancelOrder#L42").click();
    await line(view, "src/db/orders.ts#cancelOrder#L43").click({ modifiers: ["Shift"] });
    await view.locator("#status", { hasText: "コピーしました: R1 src/db/orders.ts#cancelOrder#L42-L43" }).waitFor({ timeout: 5000 });
    assert.equal(await view.locator(".ln.sel").count(), 2);
    await shot(page, "review-copy");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
