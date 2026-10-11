import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { formatAnswerLine, formatAnswerMessage, logModelBound, VERDICTS } from "./format.js";
import { ReviewStore } from "./store.js";

export const UI_URI = "ui://inloop/review.html";
export const UI_FILE = fileURLToPath(new URL("../ui/review.html", import.meta.url));

export const VERSION = "0.0.0";

/** get_review_resultで待てる最長の秒数 */
export const MAX_WAIT_SECONDS = 1800;
const POLL_MS = 300;

export type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

function error(t: string) {
  return { isError: true, content: [{ type: "text" as const, text: t }] };
}

export interface ServerOptions {
  /**
   * ブラウザで開く経路（ADR-0010）。指定すると、request_reviewが画面のURLを返す。
   * 依頼の最初のIDを受け取り、その依頼のまとまりを開くURLを返す。
   */
  browserUrl?: (id: string) => string;
}

/** UI専用のツール（visibility: app）。MCP AppsのホストとブラウザのホストのHTTPが同じものを使う。 */
export function appTools(store: ReviewStore) {
  return {
    inloop_get_request: {
      description: "UI only: fetch a review packet and the inbox.",
      inputSchema: z.object({ id: z.string() }),
      handler: async ({ id }: { id: string }): Promise<ToolResult> => {
        const packet = store.get(id);
        if (!packet) return error(`unknown review ${id}`);
        return {
          ...text(`${id}`),
          structuredContent: {
            packet,
            status: store.statusOf(id),
            inbox: store.inbox(packet.group),
            elsewhere: store.pendingElsewhere(packet.group),
            history: store.history(id),
          },
        };
      },
    },
    inloop_submit: {
      description: "UI only: record answers and return the message to send.",
      inputSchema: z.object({
        from: z.string(),
        answers: z
          .array(
            z.object({
              id: z.string(),
              verdict: z.enum(VERDICTS as [string, ...string[]]),
              ref: z.string().max(300).optional(),
              comment: z.string().max(2000).optional(),
            }),
          )
          .min(1)
          .max(50),
      }),
      handler: async ({ answers, from }: { from: string; answers: unknown[] }): Promise<ToolResult> => {
        try {
          const recorded = store.submit(answers as Parameters<ReviewStore["submit"]>[0], from);
          const group = store.get(from)!.group;
          const message = formatAnswerMessage(recorded);
          logModelBound("answer_message", message);
          return { ...text("recorded"), structuredContent: { message, inbox: store.inbox(group), elsewhere: store.pendingElsewhere(group) } };
        } catch (e) {
          return error((e as Error).message);
        }
      },
    },
    // 保留中・回答待ちの依頼を未回答に戻す。会話には何も送らない（ADR-0009）。
    inloop_reopen: {
      description: "UI only: return held or answering reviews to pending.",
      inputSchema: z.object({ from: z.string(), ids: z.array(z.string()).min(1).max(50) }),
      handler: async ({ ids, from }: { from: string; ids: string[] }): Promise<ToolResult> => {
        try {
          store.reopen(ids, from);
          const group = store.get(from)!.group;
          return { ...text("reopened"), structuredContent: { inbox: store.inbox(group), elsewhere: store.pendingElsewhere(group) } };
        } catch (e) {
          return error((e as Error).message);
        }
      },
    },
  };
}

export type AppTools = ReturnType<typeof appTools>;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

export function createServer(store = new ReviewStore(), options: ServerOptions = {}): McpServer {
  const server = new McpServer({ name: "inloop", version: VERSION });
  const { browserUrl } = options;

  // AIが呼ぶツール。戻り値は依頼IDと状態だけにする（ADR-0004）。
  // 1回の呼び出しで渡された依頼は、1つのUIからまとめて回答できる（ADR-0008）。
  // followsを付けた依頼は再依頼で、元のIDに枝番を足したIDになる（ADR-0009）。
  // ブラウザで開く経路では、画面のURLも返す（ADR-0010）。
  registerAppTool(
    server,
    "request_review",
    {
      title: "Request human review",
      description: browserUrl
        ? "Ask the human to review a change. Put all your current questions in one call: only reviews from the same call can be answered together. Each needs a concrete question and symbol IDs; never pass code. To re-request after a fix, pass follows: the earlier ID (viewpoint optional). Returns IDs and a url: open it in a browser for the human, then get_review_result with wait."
        : "Ask the human to review a change. Put all your current questions in one call: only reviews from the same call can be answered together. Each needs a concrete question and symbol IDs; never pass code. To re-request after a fix, pass follows: the earlier ID (viewpoint optional). Returns only IDs. Answers arrive later as a user message.",
      inputSchema: z.object({
        reviews: z
          .array(
            z.object({
              viewpoint: z.string().min(1).max(500).optional(),
              symbols: z.array(z.string().max(200)).max(50).optional(),
              follows: z.string().max(30).optional(),
            }),
          )
          .min(1)
          .max(10),
        range: z.string().max(100).optional(),
      }),
      _meta: { ui: { resourceUri: UI_URI } },
    },
    async ({ reviews, range }) => {
      let ids: string[];
      try {
        ids = store.create(reviews, range ?? "HEAD").map((p) => p.id);
      } catch (e) {
        // 観点も元の依頼もない、元の依頼が存在しない、など。何も記録していない。
        const t = (e as Error).message;
        logModelBound("request_review_error", t);
        return error(t);
      }
      if (browserUrl) {
        const url = browserUrl(ids[0]!);
        const t = `${ids.join(" ")} pending ${url}`;
        logModelBound("request_review", t);
        return { ...text(t), structuredContent: { ids, url } };
      }
      const t = `${ids.join(" ")} pending`;
      logModelBound("request_review", t);
      return { ...text(t), structuredContent: { ids } };
    },
  );

  // 回答の取得。sendMessageを使えないホスト向けの代替経路。
  // waitを付けると、指定した依頼がすべて回答されるまで待つ（ブラウザで開く経路、ADR-0010）。
  registerAppTool(
    server,
    "get_review_result",
    {
      title: "Get review answers",
      description: browserUrl
        ? "Get answers to your reviews by ID, one line each: <id> ok|fix|ask|hold [ref] [\"comment\"]. wait: seconds to block until all are answered."
        : "Get answers to your reviews by ID, one line each: <id> ok|fix|ask|hold [ref] [\"comment\"]. Usually not needed.",
      inputSchema: z.object({ ids: z.array(z.string()).min(1).max(50), wait: z.number().int().min(0).max(MAX_WAIT_SECONDS).optional() }),
      _meta: { ui: { resourceUri: UI_URI, visibility: ["model"] } },
    },
    async ({ ids, wait }, extra) => {
      // IDを必須にしている。絞り込みなしでは、別の会話の回答まで返してしまう。
      const pending = () => ids.filter((id) => store.statusOf(id) === "pending");
      if (wait) {
        const until = Date.now() + wait * 1000;
        const signal = (extra as { signal?: AbortSignal } | undefined)?.signal;
        // 保留・回答待ちの依頼は、人が未回答に戻して答え直しうる。待ち始めにそれらしかなければ、
        // すでに受け取った回答を返さず、新しい回答が記録されるまで待つ。
        const reopenable = (id: string) => store.statusOf(id) === "held" || store.statusOf(id) === "answering";
        const rounds = () => ids.reduce((n, id) => n + store.history(id).length, 0);
        const before = rounds();
        const awaitingNew = pending().length === 0 && ids.some(reopenable);
        const done = () => pending().length === 0 && (!awaitingNew || rounds() > before);
        while (!done() && Date.now() < until && !signal?.aborted) await sleep(POLL_MS, signal);
        if (awaitingNew && rounds() === before) {
          logModelBound("get_review_result", "no change");
          return text("no change");
        }
      }
      const lines = store.answered(ids).map(formatAnswerLine);
      // 待った場合は、まだ回答のない依頼も示す。待ち直すかどうかをAIが決められるように。
      if (wait) lines.push(...pending().map((id) => `${id} pending`));
      const t = lines.length > 0 ? lines.join("\n") : "none";
      logModelBound("get_review_result", t);
      return text(t);
    },
  );

  // 以下はUI専用。AIからは見えない（visibility: app）。
  const ui = appTools(store);
  const appOnly = { ui: { resourceUri: UI_URI, visibility: ["app" as const] } };
  const get = ui.inloop_get_request;
  registerAppTool(server, "inloop_get_request", { description: get.description, inputSchema: get.inputSchema, _meta: appOnly }, get.handler);
  const submit = ui.inloop_submit;
  registerAppTool(server, "inloop_submit", { description: submit.description, inputSchema: submit.inputSchema, _meta: appOnly }, submit.handler);
  const reopen = ui.inloop_reopen;
  registerAppTool(server, "inloop_reopen", { description: reopen.description, inputSchema: reopen.inputSchema, _meta: appOnly }, reopen.handler);

  registerAppResource(server, "inloop review", UI_URI, { description: "inloop review request UI" }, async () => ({
    contents: [{ uri: UI_URI, mimeType: RESOURCE_MIME_TYPE, text: await readFile(UI_FILE, "utf8") }],
  }));

  return server;
}
