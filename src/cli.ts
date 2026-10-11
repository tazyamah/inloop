// inloopコマンド（ADR-0011）。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AppRegistry, defaultName, NAME_PATTERN, uiPort } from "./server/apps.js";
import { runMcp } from "./server/mcp.js";
import { gitTopLevel } from "./server/target.js";
import { appOrigin, ensureUiServer, probeUiServer, startUiServer, stopUiServer } from "./server/ui-server.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const USAGE = `使い方: inloop <コマンド>

  mcp [--ui browser] [--repo <dir>] [--allow <dir>]  MCPサーバーを動かす（AIクライアントに登録する）
  server [start|stop|restart|status]                 画面のサーバーを管理する（引数なしは前面で動かす）
  new <dir> [--name <名前>] [--db sqlite]            新しいアプリを標準の構成（React＋Hono＋SQLite）で作る
  init [<dir>] [--name <名前>]                       リポジトリをinloopのアプリとして登録する
  apps                                               登録したアプリの一覧
  update                                             inloopを更新してビルドし直す
`;

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (!v) throw new Error(`${name} に値がない`);
  args.splice(i, 2);
  return v;
}

/** Claude Code向けに、そのリポジトリでinloopを使う登録（.mcp.json）を書く。ほかのサーバーの登録は残す。 */
function writeMcpJson(repo: string): boolean {
  const file = join(repo, ".mcp.json");
  const data = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { mcpServers?: Record<string, unknown> }) : {};
  const want = { command: "inloop", args: ["mcp", "--ui", "browser"] };
  if (JSON.stringify(data.mcpServers?.inloop) === JSON.stringify(want)) return false;
  data.mcpServers = { ...(data.mcpServers ?? {}), inloop: want };
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return true;
}

/** リポジトリを登録し、記録の置き場所とClaude Code向けの登録を用意する（ADR-0011、ADR-0013）。 */
function init(args: string[]): void {
  const name = option(args, "--name");
  if (args.length > 1) throw new Error(`知らない引数 ${args.slice(1).join(" ")}`);
  const { name: n, repo } = new AppRegistry().register(resolve(args[0] ?? "."), name);
  const dir = join(repo, ".inloop");
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, ".gitignore"))) writeFileSync(join(dir, ".gitignore"), "*\n");
  const wrote = writeMcpJson(repo);
  process.stdout.write(`登録しました: ${n} → ${repo}\n画面: ${appOrigin(n, uiPort())}/r/<依頼ID>\n${wrote ? ".mcp.json に inloop を書きました（Claude Code がこのリポジトリで inloop を使う）\n" : ""}`);
}

/** 雛形を写す。`__APP_NAME__`をアプリ名に置き換え、`gitignore`は`.gitignore`にする。 */
function copyTemplate(from: string, to: string, name: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const dest = join(to, entry.name === "gitignore" ? ".gitignore" : entry.name);
    if (entry.isDirectory()) copyTemplate(src, dest, name);
    else writeFileSync(dest, readFileSync(src, "utf8").replaceAll("__APP_NAME__", name));
  }
}

/** 新しいアプリのリポジトリを、標準の構成で作る（ADR-0011）。 */
function create(args: string[]): void {
  const name = option(args, "--name");
  const db = option(args, "--db") ?? "sqlite";
  if (args.includes("--desktop")) throw new Error("手元で動くアプリ（Tauri）の雛形は、まだない");
  if (db !== "sqlite") throw new Error(`--db ${db} の雛形は、まだない（今は sqlite だけ）`);
  if (args.length !== 1) throw new Error("作るディレクトリを1つ指定する（例: inloop new myapp）");
  const dir = resolve(args[0]!);
  const appName = name ?? defaultName(dir);
  if (!NAME_PATTERN.test(appName)) throw new Error(`アプリ名「${appName}」は使えない（英小文字・数字・-）。--name で指定する`);
  const registry = new AppRegistry();
  const taken = registry.pathOf(appName);
  if (taken) throw new Error(`アプリ名「${appName}」は ${taken} が使っている。--name で別の名前を指定する`);
  if (existsSync(dir) && readdirSync(dir).length > 0) throw new Error(`${dir} は空ではない`);
  copyTemplate(join(ROOT, "templates", "server"), dir, appName);
  execFileSync("git", ["init", "-q", dir]);
  init([dir, "--name", appName]);
  process.stdout.write(`作りました: ${dir}\n次に: cd ${basename(dir)} && npm install && npm run dev\n`);
}

/** cloneしたinloopを更新し、ビルドし直す。 */
function update(): void {
  gitTopLevel(ROOT);
  const run = (cmd: string, cmdArgs: string[]) => execFileSync(cmd, cmdArgs, { cwd: ROOT, stdio: "inherit" });
  run("git", ["pull", "--ff-only"]);
  run("npm", ["ci"]);
  run("npm", ["run", "build"]);
  process.stdout.write("更新しました。画面のサーバーは、次の依頼か inloop server restart で新しい版になります。MCPサーバーは、AIクライアントで起動し直すと新しい版になります。\n");
}

async function server(args: string[]): Promise<void> {
  const port = uiPort();
  const sub = args[0];
  if (sub === "status") {
    const running = await probeUiServer(port);
    process.stdout.write(running ? `動いています（ポート${port}、pid ${running.pid}）\n` : `動いていません（ポート${port}）\n`);
    return;
  }
  if (sub === "stop" || sub === "restart") {
    if (!(await stopUiServer(port))) throw new Error("画面のサーバーを止められない");
    if (sub === "stop") { process.stdout.write("止めました。\n"); return; }
  }
  if (sub === "start" || sub === "restart") {
    await ensureUiServer(port);
    process.stdout.write(`動いています（ポート${port}、pid ${(await probeUiServer(port))?.pid}）\n`);
    return;
  }
  if (sub !== undefined) throw new Error(`知らない引数 ${sub}`);
  const running = await probeUiServer(port);
  if (running) {
    process.stdout.write(`画面のサーバーはすでに動いています（ポート${port}、pid ${running.pid}）\n`);
    return;
  }
  const s = await startUiServer({ port });
  process.stderr.write(`[inloop] UI server on 127.0.0.1:${s.port}\n`);
}

export async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  try {
    switch (command) {
      case "mcp":
        await runMcp(args);
        return;
      case "server":
        await server(args);
        return;
      case "new":
        create(args);
        return;
      case "init":
        init(args);
        return;
      case "apps": {
        const apps = new AppRegistry().list();
        for (const [n, p] of Object.entries(apps)) process.stdout.write(`${n}\t${p}\t${appOrigin(n, uiPort())}\n`);
        return;
      }
      case "update":
        update();
        return;
      case undefined:
      case "help":
      case "--help":
        process.stdout.write(USAGE);
        return;
      default:
        throw new Error(`知らないコマンド ${command}\n\n${USAGE}`);
    }
  } catch (e) {
    process.stderr.write(`inloop: ${(e as Error).message}\n`);
    process.exit(1);
  }
}

await main(process.argv.slice(2));
