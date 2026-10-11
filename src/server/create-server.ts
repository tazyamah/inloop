import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { formatAnswerLine, formatAnswerMessage, logModelBound, VERDICTS } from "./format.js";
import { ReviewStore } from "./store.js";

export const UI_URI = "ui://inloop/review.html";
const UI_FILE = fileURLToPath(new URL("../ui/review.html", import.meta.url));

export const VERSION = "0.0.0";

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

function error(t: string) {
  return { isError: true, content: [{ type: "text" as const, text: t }] };
}

export function createServer(store = new ReviewStore()): McpServer {
  const server = new McpServer({ name: "inloop", version: VERSION });

  // AIが呼ぶツール。戻り値は依頼IDと状態だけにする（ADR-0004）。
  // 1回の呼び出しで渡された依頼は、1つのUIからまとめて回答できる（ADR-0008）。
  // followsを付けた依頼は再依頼で、元のIDに枝番を足したIDになる（ADR-0009）。
  registerAppTool(
    server,
    "request_review",
    {
      title: "Request human review",
      description:
        "Ask the human to review a change. Put all your current questions in one call: only reviews from the same call can be answered together. Each needs a concrete question and symbol IDs; never pass code. To re-request after a fix, pass follows: the earlier ID (viewpoint optional). Returns only IDs. Answers arrive later as a user message.",
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
      const t = `${ids.join(" ")} pending`;
      logModelBound("request_review", t);
      return { ...text(t), structuredContent: { ids } };
    },
  );

  // 回答の取得。sendMessageを使えないホスト向けの代替経路。
  registerAppTool(
    server,
    "get_review_result",
    {
      title: "Get review answers",
      description: "Get answers to your reviews by ID, one line each: <id> ok|fix|ask|hold [ref] [\"comment\"]. Usually not needed.",
      inputSchema: z.object({ ids: z.array(z.string()).min(1).max(50) }),
      _meta: { ui: { resourceUri: UI_URI, visibility: ["model"] } },
    },
    async ({ ids }) => {
      // IDを必須にしている。絞り込みなしでは、別の会話の回答まで返してしまう。
      const lines = store.answered(ids).map(formatAnswerLine);
      const t = lines.length > 0 ? lines.join("\n") : "none";
      logModelBound("get_review_result", t);
      return text(t);
    },
  );

  // 以下はUI専用。AIからは見えない（visibility: app）。
  registerAppTool(
    server,
    "inloop_get_request",
    {
      description: "UI only: fetch a review packet and the inbox.",
      inputSchema: z.object({ id: z.string() }),
      _meta: { ui: { resourceUri: UI_URI, visibility: ["app"] } },
    },
    async ({ id }) => {
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
  );

  registerAppTool(
    server,
    "inloop_submit",
    {
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
      _meta: { ui: { resourceUri: UI_URI, visibility: ["app"] } },
    },
    async ({ answers, from }) => {
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
  );

  // 保留中・回答待ちの依頼を未回答に戻す。会話には何も送らない（ADR-0009）。
  registerAppTool(
    server,
    "inloop_reopen",
    {
      description: "UI only: return held or answering reviews to pending.",
      inputSchema: z.object({ from: z.string(), ids: z.array(z.string()).min(1).max(50) }),
      _meta: { ui: { resourceUri: UI_URI, visibility: ["app"] } },
    },
    async ({ ids, from }) => {
      try {
        store.reopen(ids, from);
        const group = store.get(from)!.group;
        return { ...text("reopened"), structuredContent: { inbox: store.inbox(group), elsewhere: store.pendingElsewhere(group) } };
      } catch (e) {
        return error((e as Error).message);
      }
    },
  );

  registerAppResource(server, "inloop review", UI_URI, { description: "inloop review request UI" }, async () => ({
    contents: [{ uri: UI_URI, mimeType: RESOURCE_MIME_TYPE, text: await readFile(UI_FILE, "utf8") }],
  }));

  return server;
}
