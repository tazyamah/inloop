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
  registerAppTool(
    server,
    "request_review",
    {
      title: "Request human review",
      description:
        "Ask the human to review a change. Pass a concrete question, symbol IDs and a commit range; never pass code. Returns only an ID. Answers arrive later as a user message.",
      inputSchema: z.object({
        viewpoint: z.string().min(1).max(500),
        symbols: z.array(z.string().max(200)).max(50).optional(),
        range: z.string().max(100).optional(),
      }),
      _meta: { ui: { resourceUri: UI_URI } },
    },
    async ({ viewpoint, symbols, range }) => {
      const packet = store.create(viewpoint, symbols ?? [], range ?? "HEAD");
      const t = `${packet.id} pending`;
      logModelBound("request_review", t);
      return { ...text(t), structuredContent: { id: packet.id } };
    },
  );

  // 回答の取得。sendMessageを使えないホスト向けの代替経路。
  registerAppTool(
    server,
    "get_review_result",
    {
      title: "Get review answers",
      description: "Get answered reviews as one line each: <id> ok|fix|ask|hold [ref] [\"comment\"]. Usually not needed.",
      inputSchema: z.object({ ids: z.array(z.string()).max(50).optional() }),
      _meta: { ui: { resourceUri: UI_URI, visibility: ["model"] } },
    },
    async ({ ids }) => {
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
        structuredContent: { packet, status: store.statusOf(id), inbox: store.inbox() },
      };
    },
  );

  registerAppTool(
    server,
    "inloop_submit",
    {
      description: "UI only: record answers and return the message to send.",
      inputSchema: z.object({
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
    async ({ answers }) => {
      try {
        const recorded = store.submit(answers as Parameters<ReviewStore["submit"]>[0]);
        const message = formatAnswerMessage(recorded);
        logModelBound("answer_message", message);
        return { ...text("recorded"), structuredContent: { message, inbox: store.inbox() } };
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
