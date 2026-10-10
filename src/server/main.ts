#!/usr/bin/env node
import { join, resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createServer } from "./create-server.js";
import { LOG_FILE_NAME, ReviewStore } from "./store.js";

/** 状態ディレクトリ。`--state-dir <dir>`が環境変数`INLOOP_STATE_DIR`より優先する。 */
function stateDir(argv: string[], env: NodeJS.ProcessEnv): string | undefined {
  let dir = env.INLOOP_STATE_DIR || undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--state-dir") {
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
  return dir ? resolve(dir) : undefined;
}

let store: ReviewStore;
try {
  const dir = stateDir(process.argv.slice(2), process.env);
  store = new ReviewStore(dir ? { file: join(dir, LOG_FILE_NAME) } : {});
} catch (e) {
  // 保存先を指定されたのに使えない場合は、メモリだけで動かさずに止める。
  process.stderr.write(`[inloop] 起動できません: ${(e as Error).message}\n`);
  process.exit(1);
}

const server = createServer(store);
const transport = new StdioServerTransport();
await server.connect(transport);

// ホストがツール呼び出しに付ける情報（会話を区別できるものがあるか）を調べるための記録。
// 引数やコードは記録しない。
const deliver = transport.onmessage;
transport.onmessage = (message) => {
  try {
    const m = message as { method?: string; params?: { name?: string; _meta?: unknown; clientInfo?: unknown } };
    if (m.method === "tools/call") {
      process.stderr.write(`[inloop] call tool=${m.params?.name} meta=${JSON.stringify(m.params?._meta ?? null).slice(0, 600)}\n`);
    } else if (m.method === "initialize") {
      process.stderr.write(`[inloop] initialize client=${JSON.stringify(m.params?.clientInfo ?? null).slice(0, 300)}\n`);
    }
  } catch {
    // 記録の失敗で通信を止めない。
  }
  deliver?.call(transport, message);
};
process.stderr.write(
  store.location
    ? `[inloop] MCP server started (stdio) state=${store.location}\n`
    : "[inloop] MCP server started (stdio) state=memory（--state-dir または INLOOP_STATE_DIR の指定がないため、依頼と回答は終了時に消えます）\n",
);
