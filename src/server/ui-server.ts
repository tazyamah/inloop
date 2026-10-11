// 画面のサーバー（ADR-0013）。マシン全体で1つ、決まったポートで動き、
// `http://<アプリ名>.inloop.localhost:<ポート>/r/<依頼ID>`で画面を配る。
// ブラウザ側の小さなホスト（src/ui/browser-host.ts）がMCP Appsのホストの役を務め（ADR-0012）、
// UI専用のツールだけをHTTPで呼ぶ。鍵は使わず、HostとOriginを確かめる。
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { AppRegistry } from "./apps.js";
import { type AppTools, appTools, UI_FILE, VERSION } from "./create-server.js";
import { Targets } from "./target.js";

const HOST_FILE = fileURLToPath(new URL("../ui/browser.html", import.meta.url));
const UI_MAIN = fileURLToPath(new URL("./ui-main.js", import.meta.url));
const MAX_BODY = 256 * 1024;
const SELF = fileURLToPath(import.meta.url);

/** ビルドの印。このファイルの更新時刻。動いている画面のサーバーが古い版かを見分ける。 */
function currentBuild(): number {
  return Math.floor(statSync(SELF).mtimeMs);
}
/** このプロセスが読み込んだビルド。 */
const LOADED_BUILD = currentBuild();
export const HEALTH_PATH = "/_inloop/health";

export interface UiServer {
  readonly port: number;
  close(): Promise<void>;
}

/** 画面のURLの基点。例: http://appa.inloop.localhost:4656 */
export function appOrigin(name: string, port: number): string {
  return `http://${name}.inloop.localhost:${port}`;
}

export async function startUiServer(options: { port: number; registry?: AppRegistry }): Promise<UiServer> {
  const registry = options.registry ?? new AppRegistry();
  let port = options.port;
  // リポジトリごとのUI専用のツール。対象はそのリポジトリに固定する（ADR-0010の--repoと同じ）。
  const tools = new Map<string, AppTools>();
  const toolsOf = (repo: string) => {
    let t = tools.get(repo);
    if (!t) { t = appTools(new Targets({ repo })); tools.set(repo, t); }
    return t;
  };

  const send = (res: ServerResponse, status: number, type: string, body: string) => {
    res.writeHead(status, {
      "content-type": type,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      // ほかのサイトに埋め込ませない。CORSの許可は出さない。
      "content-security-policy": "frame-ancestors 'self'",
    });
    res.end(body);
  };
  const text = (res: ServerResponse, status: number, body: string) => send(res, status, "text/plain; charset=utf-8", body);

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const host = req.headers.host ?? "";
    if (url.pathname === HEALTH_PATH && req.method === "GET") {
      // ほかのinloopのプロセスが、このサーバーが動いているかを確かめるため。記録の中身は返さない。
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}` && host !== `[::1]:${port}`) return text(res, 403, "forbidden");
      return send(res, 200, "application/json; charset=utf-8", JSON.stringify({ inloop: VERSION, pid: process.pid, build: LOADED_BUILD }));
    }
    // 宛先の名前が、登録したアプリの<名前>.inloop.localhost:<ポート>であること（DNS rebinding対策）。
    const m = /^([a-z0-9-]+)\.inloop\.localhost:(\d+)$/.exec(host);
    if (!m || Number(m[2]) !== port) return text(res, 403, "forbidden");
    const repo = registry.pathOf(m[1]!);
    if (!repo) return text(res, 404, "unknown app");

    if (req.method === "GET" && /^\/r\/R\d+(-\d+)?$/.test(url.pathname)) {
      return send(res, 200, "text/html; charset=utf-8", await readFile(HOST_FILE, "utf8"));
    }
    if (req.method === "GET" && url.pathname === "/ui/review.html") {
      return send(res, 200, "text/html; charset=utf-8", await readFile(UI_FILE, "utf8"));
    }
    if (req.method === "POST" && url.pathname === "/api/call") {
      // 書き込みは、同じアプリの画面からだけ受け付ける（鍵の代わり）。
      if (req.headers.origin !== `http://${host}`) return text(res, 403, "forbidden origin");
      if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return text(res, 415, "json only");
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > MAX_BODY) return text(res, 413, "too large");
      }
      let call: { name?: unknown; arguments?: unknown };
      try {
        call = JSON.parse(body);
      } catch {
        return text(res, 400, "bad json");
      }
      const appTools_ = toolsOf(repo);
      const tool = typeof call.name === "string" && Object.hasOwn(appTools_, call.name) ? appTools_[call.name as keyof AppTools] : undefined;
      if (!tool) return text(res, 404, "unknown tool");
      // 対象はHostのアプリ名で決める。画面が渡した値は使わない。
      const given = { ...((call.arguments as object | undefined) ?? {}) } as Record<string, unknown>;
      delete given.repo;
      const args = tool.inputSchema.safeParse(given);
      const result = args.success
        ? await (tool.handler as (a: unknown) => Promise<unknown>)(args.data)
        : { isError: true, content: [{ type: "text", text: "invalid arguments" }] };
      return send(res, 200, "application/json; charset=utf-8", JSON.stringify(result));
    }
    return text(res, 404, "not found");
  };

  const listener = (req: IncomingMessage, res: ServerResponse) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) text(res, 500, String((e as Error).message ?? e));
    });
  };
  const listen = (server: Server, address: string, p: number) =>
    new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(p, address, () => resolve());
    });

  const v4 = createHttpServer(listener);
  await listen(v4, "127.0.0.1", port);
  port = (v4.address() as { port: number }).port;
  // *.localhostは::1に向くこともあるので、IPv6でも待ち受ける。使えない環境では諦める。
  const v6 = createHttpServer(listener);
  const v6ok = await listen(v6, "::1", port).then(() => true, () => false);

  return {
    port,
    close: async () => {
      await new Promise<void>((resolve) => v4.close(() => resolve()));
      if (v6ok) await new Promise<void>((resolve) => v6.close(() => resolve()));
    },
  };
}

export interface RunningUiServer { inloop: string; pid: number; build?: number }

/** 画面のサーバーが動いていれば、そのプロセスの情報を返す。 */
export async function probeUiServer(port: number): Promise<RunningUiServer | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${HEALTH_PATH}`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { inloop?: unknown; pid?: unknown; build?: unknown };
    if (typeof data.inloop !== "string" || typeof data.pid !== "number") return undefined;
    return { inloop: data.inloop, pid: data.pid, ...(typeof data.build === "number" ? { build: data.build } : {}) };
  } catch {
    return undefined;
  }
}

/** 動いている画面のサーバーを止める。止まったら（もともと動いていなければ）trueを返す。 */
export async function stopUiServer(port: number): Promise<boolean> {
  const running = await probeUiServer(port);
  if (!running) return true;
  try {
    process.kill(running.pid, "SIGTERM");
  } catch {
    return false;
  }
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (!(await probeUiServer(port))) return true;
  }
  return false;
}

/**
 * 画面のサーバーが動いていなければ、別のプロセスとして起動する（MCPサーバーが終わっても残る）。
 * 動いているのが今のビルドより古い版なら、止めて起動し直す（inloop updateやビルドの後）。
 * ポートをinloop以外が使っていれば、エラーにする。
 */
export async function ensureUiServer(port: number, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const running = await probeUiServer(port);
  if (running && (running.build ?? 0) >= currentBuild()) return;
  if (running && !(await stopUiServer(port))) throw new Error(`古い版の画面のサーバー（pid ${running.pid}）を止められない`);
  const child = spawn(process.execPath, [UI_MAIN], { detached: true, stdio: "ignore", env: { ...env, INLOOP_PORT: String(port) } });
  child.unref();
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (await probeUiServer(port)) return;
  }
  throw new Error(`画面のサーバーを起動できない（ポート${port}をほかのソフトが使っているかもしれない。INLOOP_PORTで変えられる）`);
}
