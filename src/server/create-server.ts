import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { formatAnswerLine, formatAnswerMessage, logModelBound, VERDICTS } from "./format.js";
import { ReviewStore } from "./store.js";
import { answersOf } from "./wait.js";
import { userConfig } from "./apps.js";
import { TargetError, Targets } from "./target.js";

export const UI_URI = "ui://inloop/review.html";
export const UI_FILE = fileURLToPath(new URL("../ui/review.html", import.meta.url));

export const VERSION = "0.0.0";

/** 画面でファイル全体を開けるファイルの大きさの上限 */
const MAX_FILE_BYTES = 1_000_000;

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
    // 依頼票のファイルの全体（行番号つきのコメントのための、3段目の表示）。依頼票に出ているファイルだけ読む。
    inloop_get_file: {
      description: "UI only: fetch a whole file shown in a review packet.",
      inputSchema: z.object({ id: z.string(), file: z.string().max(500), repo: z.string().optional() }),
      handler: async ({ id, file, repo }: { id: string; file: string; repo?: string }): Promise<ToolResult> => {
        const t = await storeFor(targets, repo);
        if (isError(t)) return t;
        const packet = t.store.get(id);
        if (!packet) return error(`unknown review ${id}`);
        const steps = packet.steps.filter((s) => s.file === file);
        if (steps.length === 0) return error(`${file}: 依頼票に出ていないファイル`);
        if (packet.fixture || t.repo === undefined) return error("固定データの依頼票は、ファイルの全体を読めない");
        const abs = resolve(t.repo, file);
        if (!existsSync(abs)) return error(`${file}: 読めないファイル`);
        const rel = relative(realpathSync(t.repo), realpathSync(abs));
        if (rel.startsWith("..") || isAbsolute(rel)) return error(`${file}: リポジトリの外`);
        const size = statSync(abs).size;
        if (size > MAX_FILE_BYTES) return error(`${file}: ${MAX_FILE_BYTES}バイトを超えるため、全体は出せない`);
        const body = readFileSync(abs, "utf8");
        const lines = body.split("\n");
        // 依頼のあとにファイルが変わっていれば、行番号が依頼票とずれる。
        const stale = steps.some((s) => !s.symbol.startsWith("HEAD:") && lines.slice(s.startLine - 1, s.startLine - 1 + s.code.split("\n").length).join("\n") !== s.code);
        return { ...text(file), structuredContent: { file, text: body, stale } };
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
  // 信頼境界ルールに当たった変更の必須の依頼は、エンジンが同じ呼び出しに加え、末尾に`required:`で示す（ADR-0022）。
  registerAppTool(
    server,
    "request_review",
    {
      title: "Request human review",
      description: browserUrl
        ? "Ask the human to review a change. Put all your current questions in one call: only reviews from the same call can be answered together. Each needs a concrete question and symbol IDs; never pass code. repo: absolute path of the git repo you work in. To re-request after a fix, pass follows: the earlier ID (viewpoint optional). Rule-required reviews are added automatically (required:); reviews may be empty to get only those. Returns IDs and a url: open it in a browser for the human, then end your turn and continue in chat."
        : "Ask the human to review a change. Put all your current questions in one call: only reviews from the same call can be answered together. Each needs a concrete question and symbol IDs; never pass code. repo: absolute path of the git repo you work in. To re-request after a fix, pass follows: the earlier ID (viewpoint optional). Rule-required reviews are added automatically (required:); reviews may be empty to get only those. Returns only IDs. Answers arrive later as a user message.",
      inputSchema: z.object({
        reviews: z
          .array(
            z.object({
              viewpoint: z.string().min(1).max(500).optional(),
              symbols: z.array(z.string().max(200)).max(50).optional(),
              follows: z.string().max(30).optional(),
            }),
          )
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
      let required: string[];
      try {
        const packets = store.create(reviews, range ?? "HEAD");
        ids = packets.map((p) => p.id);
        required = packets.filter((p) => p.kind === "required" && !p.fixture).map((p) => p.id);
      } catch (e) {
        // 観点も元の依頼もない、元の依頼が存在しない、など。何も記録していない。
        const t = (e as Error).message;
        logModelBound("request_review_error", t);
        return error(t);
      }
      const req = required.length > 0 ? ` required:${required.join(",")}` : "";
      const reqContent = required.length > 0 ? { required } : {};
      if (base !== undefined) {
        const url = `${base}/r/${ids[0]}`;
        const out = `${ids.join(" ")} pending ${url}${req}`;
        logModelBound("request_review", out);
        return { ...text(out), structuredContent: { ids, url, ...reqContent }, ...meta };
      }
      const out = `${ids.join(" ")} pending${req}`;
      logModelBound("request_review", out);
      return { ...text(out), structuredContent: { ids, ...reqContent }, ...meta };
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

  // 会話での人の指示を受けて、AIが承認・保留を記録する（ADR-0017）。人が言った言葉を渡させ、
  // 設定の言葉と一致するときだけ記録する。画面のボタンも引き続き使える。必須の依頼は記録しない。
  registerAppTool(
    server,
    "answer_review",
    {
      title: "Record the human's approval or hold",
      description: "Only when the human explicitly says the configured word in chat, record ok/hold for reviews. said: the human's exact word.",
      inputSchema: z.object({
        ids: z.array(z.string()).min(1).max(10),
        verdict: z.enum(["ok", "hold"]),
        said: z.string().max(100),
        repo: repoParam,
      }),
      _meta: { ui: { resourceUri: UI_URI, visibility: ["model"] } },
    },
    async ({ ids, verdict, said, repo }) => {
      const t = await storeFor(targets, repo);
      if (isError(t)) return t;
      let phrases: string[];
      try {
        const config = userConfig();
        phrases = verdict === "ok" ? config.approvePhrases : config.holdPhrases;
      } catch (e) {
        return error((e as Error).message);
      }
      if (!phrases.includes(said.trim())) {
        logModelBound("answer_review_error", "phrase mismatch");
        return error("said does not match the configured word; not recorded");
      }
      try {
        t.store.submit(ids.map((id) => ({ id, verdict })), ids[0]!, { by: "chat" });
      } catch (e) {
        const m = (e as Error).message;
        logModelBound("answer_review_error", m);
        return error(m);
      }
      const out = `${ids.join(" ")} ${verdict} recorded`;
      logModelBound("answer_review", out);
      return text(out);
    },
  );

  // 以下はUI専用。AIからは見えない（visibility: app）。
  const ui = appTools(targets);
  const appOnly = { ui: { resourceUri: UI_URI, visibility: ["app" as const] } };
  const get = ui.inloop_get_request;
  registerAppTool(server, "inloop_get_request", { description: get.description, inputSchema: get.inputSchema, _meta: appOnly }, get.handler);
  const getFile = ui.inloop_get_file;
  registerAppTool(server, "inloop_get_file", { description: getFile.description, inputSchema: getFile.inputSchema, _meta: appOnly }, getFile.handler);
  const submit = ui.inloop_submit;
  registerAppTool(server, "inloop_submit", { description: submit.description, inputSchema: submit.inputSchema, _meta: appOnly }, submit.handler);
  const reopen = ui.inloop_reopen;
  registerAppTool(server, "inloop_reopen", { description: reopen.description, inputSchema: reopen.inputSchema, _meta: appOnly }, reopen.handler);

  registerAppResource(server, "inloop review", UI_URI, { description: "inloop review request UI" }, async () => ({
    contents: [{ uri: UI_URI, mimeType: RESOURCE_MIME_TYPE, text: await readFile(UI_FILE, "utf8") }],
  }));

  return server;
}
