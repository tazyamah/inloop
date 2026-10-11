#!/usr/bin/env node
import { join, resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { type BrowserUi, startBrowserUi } from "./browser.js";
import { appTools, createServer } from "./create-server.js";
import { LOG_FILE_NAME, ReviewStore } from "./store.js";

interface Args {
  /** 状態ディレクトリ。`--state-dir <dir>`が環境変数`INLOOP_STATE_DIR`より優先する。 */
  dir: string | undefined;
  /** `--ui browser`で、UIをブラウザで開く経路を使う（ADR-0010）。 */
  browser: boolean;
}

function parseArgs(argv: string[], env: NodeJS.ProcessEnv): Args {
  let dir = env.INLOOP_STATE_DIR || undefined;
  let browser = false;
  const ui = (v: string | undefined) => {
    if (v === "browser") browser = true;
    else if (v !== "mcp-apps") throw new Error(`--ui は browser か mcp-apps（${v ?? "指定なし"}）`);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--ui") {
      ui(argv[++i]);
    } else if (a.startsWith("--ui=")) {
      ui(a.slice("--ui=".length));
    } else if (a === "--state-dir") {
      const v = argv[++i];
      if (!v) throw new Error("--state-dir にディレクトリの指定がない");
      dir = v;
    } else if (a.startsWith("--state-dir=")) {
      dir = a.slice("--state-dir=".length);
      if (!dir) throw new Error("--state-dir にディレクトリの指定がない");
    } else {
      throw new Error(`知らない引数 ${a}`);
    }
  }
  return { dir: dir ? resolve(dir) : undefined, browser };
}

let store: ReviewStore;
let browser: BrowserUi | undefined;
try {
  const args = parseArgs(process.argv.slice(2), process.env);
  store = new ReviewStore(args.dir ? { file: join(args.dir, LOG_FILE_NAME) } : {});
  if (args.browser) browser = await startBrowserUi(appTools(store));
} catch (e) {
  // 保存先を指定されたのに使えない場合は、メモリだけで動かさずに止める。
  process.stderr.write(`[inloop] 起動できません: ${(e as Error).message}\n`);
  process.exit(1);
}

const server = createServer(store, browser ? { browserUrl: (id) => browser.urlFor(id) } : {});
// HTTPを開いているとプロセスが残るので、クライアントとの接続が切れたら終わる。
const stop = () => { void browser?.close().finally(() => process.exit(0)); };
if (browser) {
  process.stdin.on("end", stop);
  process.stdin.on("close", stop);
}
const transport = new StdioServerTransport();
await server.connect(transport);

// ホストがツール呼び出しに付ける情報（会話を区別できるものがあるか）を調べるための記録。
// 引数やコードは記録しない。
const deliver = transport.onmessage;
transport.onmessage = (message) => {
  try {
    const m = message as { method?: string; params?: { name?: string; _meta?: unknown; clientInfo?: unknown; capabilities?: object } };
    if (m.method === "tools/call") {
      process.stderr.write(`[inloop] call tool=${m.params?.name} meta=${JSON.stringify(m.params?._meta ?? null).slice(0, 600)}\n`);
    } else if (m.method === "initialize") {
      process.stderr.write(`[inloop] initialize client=${JSON.stringify(m.params?.clientInfo ?? null).slice(0, 300)}\n`);
      // クライアントが作業フォルダ（roots）を知らせられるかを調べるための記録（ADR-0010）。
      process.stderr.write(`[inloop] initialize capabilities=${JSON.stringify(m.params?.capabilities ?? null).slice(0, 300)}\n`);
    }
  } catch {
    // 記録の失敗で通信を止めない。
  }
  deliver?.call(transport, message);
};
if (browser) process.stderr.write(`[inloop] browser UI on 127.0.0.1:${browser.port}\n`);
process.stderr.write(
  store.location
    ? `[inloop] MCP server started (stdio) state=${store.location}\n`
    : "[inloop] MCP server started (stdio) state=memory（--state-dir または INLOOP_STATE_DIR の指定がないため、依頼と回答は終了時に消えます）\n",
);
