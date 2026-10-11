// inloopコマンド（ADR-0011）。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AppRegistry, uiPort } from "./server/apps.js";
import { runMcp } from "./server/mcp.js";
import { gitTopLevel } from "./server/target.js";
import { appOrigin, probeUiServer, startUiServer } from "./server/ui-server.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const USAGE = `使い方: inloop <コマンド>

  mcp [--ui browser] [--repo <dir>] [--allow <dir>]  MCPサーバーを動かす（AIクライアントに登録する）
  server                                             画面のサーバーを前面で動かす
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

/** リポジトリを登録し、記録の置き場所を用意する（ADR-0011、ADR-0013）。 */
function init(args: string[]): void {
  const name = option(args, "--name");
  if (args.length > 1) throw new Error(`知らない引数 ${args.slice(1).join(" ")}`);
  const { name: n, repo } = new AppRegistry().register(resolve(args[0] ?? "."), name);
  const dir = join(repo, ".inloop");
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, ".gitignore"))) writeFileSync(join(dir, ".gitignore"), "*\n");
  process.stdout.write(`登録しました: ${n} → ${repo}\n画面: ${appOrigin(n, uiPort())}/r/<依頼ID>\n`);
}

/** cloneしたinloopを更新し、ビルドし直す。 */
function update(): void {
  gitTopLevel(ROOT);
  const run = (cmd: string, cmdArgs: string[]) => execFileSync(cmd, cmdArgs, { cwd: ROOT, stdio: "inherit" });
  run("git", ["pull", "--ff-only"]);
  run("npm", ["ci"]);
  run("npm", ["run", "build"]);
  process.stdout.write("更新しました。動いている画面のサーバーとMCPサーバーは、起動し直すと新しい版になります。\n");
}

async function server(): Promise<void> {
  const port = uiPort();
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
        await server();
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
