// ブラウザで開く経路（ADR-0010）。MCP AppsのUIを表示できないクライアント向けに、
// 同じUIをローカルのHTTPで配る。ブラウザ側の小さなホスト（src/ui/browser-host.ts）が
// MCP Appsのホストの役を務め、UI専用のツールだけをHTTPで呼ぶ。
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { type AppTools, UI_FILE } from "./create-server.js";

const HOST_FILE = fileURLToPath(new URL("../ui/browser.html", import.meta.url));
const MAX_BODY = 256 * 1024;

export interface BrowserUi {
  /** 依頼のまとまりを開くURL。鍵を含む。 */
  urlFor(id: string): string;
  readonly port: number;
  close(): Promise<void>;
}

/**
 * 127.0.0.1だけで待ち受ける。すべての要求に、起動ごとに作る鍵（URLの`t`）を求め、
 * Hostヘッダーが127.0.0.1かlocalhostであることを確かめる（DNS rebinding対策）。
 * 呼べるのはUI専用のツールだけで、AIが呼ぶツール（request_reviewなど）は呼べない。
 */
export async function startBrowserUi(tools: AppTools, options: { port?: number } = {}): Promise<BrowserUi> {
  const token = randomBytes(18).toString("base64url");
  let port = 0;

  const authorized = (req: IncomingMessage, url: URL): boolean => {
    const host = req.headers.host ?? "";
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
    const t = Buffer.from(url.searchParams.get("t") ?? "");
    const want = Buffer.from(token);
    return t.length === want.length && timingSafeEqual(t, want);
  };

  const send = (res: ServerResponse, status: number, type: string, body: string) => {
    res.writeHead(status, {
      "content-type": type,
      "cache-control": "no-store",
      // URLに鍵が入るので、ほかのサイトへ送らない。ほかのサイトに埋め込ませない。
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "content-security-policy": "frame-ancestors 'self'",
    });
    res.end(body);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (!authorized(req, url)) return send(res, 403, "text/plain; charset=utf-8", "forbidden");
    if (req.method === "GET" && /^\/r\/R\d+(-\d+)?$/.test(url.pathname)) {
      return send(res, 200, "text/html; charset=utf-8", await readFile(HOST_FILE, "utf8"));
    }
    if (req.method === "GET" && url.pathname === "/ui/review.html") {
      return send(res, 200, "text/html; charset=utf-8", await readFile(UI_FILE, "utf8"));
    }
    if (req.method === "POST" && url.pathname === "/api/call") {
      // 単純なフォーム送信では送れない形式だけを受け付ける。
      if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) {
        return send(res, 415, "text/plain; charset=utf-8", "json only");
      }
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > MAX_BODY) return send(res, 413, "text/plain; charset=utf-8", "too large");
      }
      let call: { name?: unknown; arguments?: unknown };
      try {
        call = JSON.parse(body);
      } catch {
        return send(res, 400, "text/plain; charset=utf-8", "bad json");
      }
      const tool = typeof call.name === "string" && Object.hasOwn(tools, call.name) ? tools[call.name as keyof AppTools] : undefined;
      if (!tool) return send(res, 404, "text/plain; charset=utf-8", "unknown tool");
      const args = tool.inputSchema.safeParse(call.arguments ?? {});
      const result = args.success
        ? await (tool.handler as (a: unknown) => Promise<unknown>)(args.data)
        : { isError: true, content: [{ type: "text", text: "invalid arguments" }] };
      return send(res, 200, "application/json; charset=utf-8", JSON.stringify(result));
    }
    return send(res, 404, "text/plain; charset=utf-8", "not found");
  };

  const server: Server = createHttpServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) send(res, 500, "text/plain; charset=utf-8", String((e as Error).message ?? e));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => resolve());
  });
  port = (server.address() as { port: number }).port;

  return {
    port,
    urlFor: (id) => `http://127.0.0.1:${port}/r/${id}?t=${token}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
