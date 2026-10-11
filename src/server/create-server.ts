import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { formatAnswerLine, formatAnswerMessage, logModelBound, VERDICTS } from "./format.js";
import { ReviewStore } from "./store.js";
import { answersOf } from "./wait.js";
import { TargetError, Targets } from "./target.js";

export const UI_URI = "ui://inloop/review.html";
export const UI_FILE = fileURLToPath(new URL("../ui/review.html", import.meta.url));

export const VERSION = "0.0.0";

/** get_review_resultで待てる最長の秒数 */
export const MAX_WAIT_SECONDS = 1800;

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
   * ブラウザで開く経路（ADR-0012、ADR-0013）。指定すると、request_reviewが画面のURLを返す。
   * 対象のリポジトリを受け取り、そのアプリの画面のURLの基点（http://<アプリ名>.inloop.localhost:<ポート>）を返す。
   * 画面を出せない対象なら、依頼を作る前にTargetErrorを投げる。
   */
  browserBase?: (repo: string | undefined) => Promise<string>;
}

/** 対象を決め、決まらなければAIやUIへ返すエラーにする。 */
async function storeFor(targets: Targets, repo: string | undefined): Promise<{ repo: string | undefined; store: ReviewStore } | ToolResult> {
  try {
    return await targets.resolve(repo);
  } catch (e) {
    if (e instanceof TargetError) return error(e.message);
    throw e;
  }
}

async function locate(targets: Targets, repo: string | undefined): Promise<{ repo: string | undefined } | ToolResult> {
  try {
    return await targets.locate(repo);
  } catch (e) {
    if (e instanceof TargetError) return error(e.message);
    throw e;
  }
}
const isError = (r: object): r is ToolResult => "content" in r;

/** 結果の`_meta`で、UIに対象のリポジトリを渡す。AIには渡さない（ADR-0010）。 */
export const REPO_META = "inloop/repo";

/**
 * UI専用のツール（visibility: app）。MCP AppsのホストとブラウザのホストのHTTPが同じものを使う。
 * どれも省略できる`repo`で対象のリポジトリを受け取る（ADR-0010）。
 */
export function appTools(targets: Targets) {
  return {
    inloop_get_request: {
      description: "UI only: fetch a review packet and the inbox.",
      inputSchema: z.object({ id: z.string(), repo: z.string().optional() }),
      handler: async ({ id, repo }: { id: string; repo?: string }): Promise<ToolResult> => {
        const t = await storeFor(targets, repo);
        if (isError(t)) return t;
        const { store } = t;
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
        repo: z.string().optional(),
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
      handler: async ({ answers, from, repo }: { from: string; repo?: string; answers: unknown[] }): Promise<ToolResult> => {
        const t = await storeFor(targets, repo);
        if (isError(t)) return t;
        const { store } = t;
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
      inputSchema: z.object({ from: z.string(), repo: z.string().optional(), ids: z.array(z.string()).min(1).max(50) }),
      handler: async ({ ids, from, repo }: { from: string; repo?: string; ids: string[] }): Promise<ToolResult> => {
        const t = await storeFor(targets, repo);
        if (isError(t)) return t;
        const { store } = t;
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

/**
 * MCPサーバーを作る。ReviewStoreを渡すと、対象に関係なくその記録を使う（テストと互換のため）。
 * Targetsを渡すと、依頼ごとに対象のリポジトリを決める（ADR-0010）。
 */
export function createServer(target: ReviewStore | Targets = new ReviewStore(), options: ServerOptions = {}): McpServer {
  const server = new McpServer({ name: "inloop", version: VERSION });
  const { browserBase } = options;
  const browserUrl = browserBase;
  const targets = target instanceof Targets ? target : new Targets({ store: target });
  // クライアントが作業フォルダ（roots）を知らせられるなら、対象を決めるのに使う。
  targets.useRoots(async () => {
    if (!server.server.getClientCapabilities()?.roots) return undefined;
    return (await server.server.listRoots()).roots.map((r) => r.uri);
  });
  const repoParam = z.string().max(500).optional();

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
        ? "Ask the human to review a change. Put all your current questions in one call: only reviews from the same call can be answered together. Each needs a concrete question and symbol IDs; never pass code. repo: absolute path of the git repo you work in. To re-request after a fix, pass follows: the earlier ID (viewpoint optional). Returns IDs and a url: open it in a browser for the human. To wait without blocking, run `inloop wait <ids>` as a background command; its exit brings the answers."
        : "Ask the human to review a change. Put all your current questions in one call: only reviews from the same call can be answered together. Each needs a concrete question and symbol IDs; never pass code. repo: absolute path of the git repo you work in. To re-request after a fix, pass follows: the earlier ID (viewpoint optional). Returns only IDs. Answers arrive later as a user message.",
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
        repo: repoParam,
      }),
      _meta: { ui: { resourceUri: UI_URI } },
    },
    async ({ reviews, range, repo }) => {
      const found = await locate(targets, repo);
      if (isError(found)) {
        logModelBound("request_review_error", found.content[0]!.text);
        return found;
      }
      const t = found;
      const meta = t.repo ? { _meta: { [REPO_META]: t.repo } } : {};
      let base: string | undefined;
      if (browserBase) {
        try {
          base = await browserBase(t.repo);
        } catch (e) {
          const m = (e as Error).message;
          logModelBound("request_review_error", m);
          return error(m);
        }
      }
      // 画面を出せることを確かめてから、記録の置き場所を開く。
      const { store } = targets.open(t);
      let ids: string[];
      try {
        ids = store.create(reviews, range ?? "HEAD").map((p) => p.id);
      } catch (e) {
        // 観点も元の依頼もない、元の依頼が存在しない、など。何も記録していない。
        const t = (e as Error).message;
        logModelBound("request_review_error", t);
        return error(t);
      }
      if (base !== undefined) {
        const url = `${base}/r/${ids[0]}`;
        const out = `${ids.join(" ")} pending ${url}`;
        logModelBound("request_review", out);
        return { ...text(out), structuredContent: { ids, url }, ...meta };
      }
      const out = `${ids.join(" ")} pending`;
      logModelBound("request_review", out);
      return { ...text(out), structuredContent: { ids }, ...meta };
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
      inputSchema: z.object({ ids: z.array(z.string()).min(1).max(50), wait: z.number().int().min(0).max(MAX_WAIT_SECONDS).optional(), repo: repoParam }),
      _meta: { ui: { resourceUri: UI_URI, visibility: ["model"] } },
    },
    async ({ ids, wait, repo }, extra) => {
      const t = await storeFor(targets, repo);
      if (isError(t)) return t;
      const { store } = t;
      // IDを必須にしている。絞り込みなしでは、別の会話の回答まで返してしまう。
      const out = await answersOf(store, ids, wait, (extra as { signal?: AbortSignal } | undefined)?.signal);
      logModelBound("get_review_result", out);
      return text(out);
    },
  );

  // 以下はUI専用。AIからは見えない（visibility: app）。
  const ui = appTools(targets);
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
