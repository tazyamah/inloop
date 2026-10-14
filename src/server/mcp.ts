// MCPサーバー（`inloop mcp`、および互換の`dist/server/main.js`）。
import { join, resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { AppRegistry, uiPort } from "./apps.js";
import { createServer } from "./create-server.js";
import { LOG_FILE_NAME } from "./store.js";
import { TargetError, Targets } from "./target.js";
import { appOrigin, ensureUiServer } from "./ui-server.js";

interface Args {
  /** 状態ディレクトリ。`--state-dir <dir>`が環境変数`INLOOP_STATE_DIR`より優先する。 */
  dir: string | undefined;
  /** `--ui browser`で、UIをブラウザで開く経路を使う（ADR-0012）。 */
  browser: boolean;
  /** `--repo <dir>`で、そのプロセスの対象を1つに固定する（ADR-0010）。 */
  repo: string | undefined;
  /** `--allow <dir>`（複数可）で、対象をその中に限る（ADR-0010）。 */
  allow: string[];
}

function parseArgs(argv: string[], env: NodeJS.ProcessEnv): Args {
  let dir = env.INLOOP_STATE_DIR || undefined;
  let browser = false;
  let repo: string | undefined;
  const allow: string[] = [];
  const value = (name: string, v: string | undefined) => {
    if (!v) throw new Error(`${name} にディレクトリの指定がない`);
    return v;
  };
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
    } else if (a === "--repo") {
      repo = value("--repo", argv[++i]);
    } else if (a.startsWith("--repo=")) {
      repo = value("--repo", a.slice("--repo=".length));
    } else if (a === "--allow") {
      allow.push(value("--allow", argv[++i]));
    } else if (a.startsWith("--allow=")) {
      allow.push(value("--allow", a.slice("--allow=".length)));
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
  return { dir: dir ? resolve(dir) : undefined, browser, repo, allow };
}

/** MCPサーバーをstdioで動かす。起動できなければ終了コード1で終わる。 */
export async function runMcp(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  let targets: Targets;
  let browser: { port: number; registry: AppRegistry } | undefined;
  try {
    const args = parseArgs(argv, env);
    const registry = args.browser ? new AppRegistry() : undefined;
    // ブラウザの経路では、AIが渡す repo も登録したアプリに限る（ADR-0048）。
    targets = new Targets({
      stateFile: args.dir ? join(args.dir, LOG_FILE_NAME) : undefined,
      repo: args.repo,
      allow: args.allow,
      accept: registry ? (top) => registry.nameOf(top) !== undefined : undefined,
    });
    if (registry) {
      // 画面はマシン全体で1つの画面のサーバーが配る（ADR-0013）。記録先を固定する互換の動きとは併用しない。
      if (targets.stateLocation) throw new Error("--ui browser は --state-dir と併用できない");
      browser = { port: uiPort(env), registry };
      await ensureUiServer(browser.port, env);
    }
  } catch (e) {
    // 保存先を指定されたのに使えない場合は、メモリだけで動かさずに止める。
    process.stderr.write(`[inloop] 起動できません: ${(e as Error).message}\n`);
    process.exit(1);
  }

  const server = createServer(targets, browser ? {
    browserBase: async (repo) => {
      if (repo === undefined) throw new TargetError("repo がない");
      const name = browser.registry.nameOf(repo);
      if (!name) throw new TargetError(`${repo}: inloop init で登録されていない`);
      await ensureUiServer(browser.port, env);
      return appOrigin(name, browser.port);
    },
  } : {});
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
  if (browser) process.stderr.write(`[inloop] browser UI via 127.0.0.1:${browser.port}\n`);
  process.stderr.write(
    targets.stateLocation
      ? `[inloop] MCP server started (stdio) state=${targets.stateLocation}\n`
      : `[inloop] MCP server started (stdio) state=repo（対象のリポジトリの.inloop/${LOG_FILE_NAME}${targets.fixedRepo ? `、対象は${targets.fixedRepo}` : ""}）\n`,
  );
}
