// inloopコマンド（ADR-0011）。
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AppRegistry, defaultName, NAME_PATTERN, uiPort } from "./server/apps.js";
import { runMcp } from "./server/mcp.js";
import { LOG_FILE_NAME, ReviewStore } from "./server/store.js";
import { gitTopLevel } from "./server/target.js";
import { answersOf } from "./server/wait.js";
import { loadConfig } from "./engine/boundaries.js";
import { runEvidence } from "./engine/evidence.js";
import { formatFinding, lintRepo } from "./engine/secure.js";
import { checkRequired } from "./server/check.js";
import { defineResource, plan as scaffoldPlan, write as scaffoldWrite } from "./scaffold.js";
import { appOrigin, ensureUiServer, probeUiServer, startUiServer, stopUiServer } from "./server/ui-server.js";

/** 文字として読み書きすると壊れるファイル。そのままコピーする。 */
const BINARY_FILES = /\.(png|icns|ico|jpg|jpeg|gif|woff2?)$/i;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const USAGE = `使い方: inloop <コマンド>

  mcp [--ui browser] [--repo <dir>] [--allow <dir>]  MCPサーバーを動かす（AIクライアントに登録する）
  server [start|stop|restart|status]                 画面のサーバーを管理する（引数なしは前面で動かす）
  new <dir> [--name <名前>] [--db sqlite] [--desktop | --standalone | --sync] 新しいアプリを標準の構成（React＋Hono＋SQLite）で作る。--desktop はTauriの外枠を足す。--standalone はサーバーなしで端末内（ブラウザ・PWA）で動く構成にする。--sync は、それに端末どうしの共有（承認方式、暗号化、中継つき）を足す
  generate scaffold <名前> <列>... [--plural <名前>] [--label <表示名>]  資源（表・API・テスト・画面）を決まった形で作る。列は 名前:型（text・int・real・bool・date）、省略可は 名前:型:optional
  init [<dir>] [--name <名前>]                       リポジトリをinloopのアプリとして登録する
  apps                                               登録したアプリの一覧
  wait <依頼ID>... [--repo <dir>] [--timeout <秒>]   回答が記録されるまで待ち、回答を1行ずつ出す
  check [--repo <dir>] [--range <範囲>]              信頼境界ルールが求める必須の依頼が、すべて承認済みかを確かめる
  lint [--repo <dir>]                                セキュアコードの規則（IPAの注意喚起から導いたもの）に反するコードがないかを検査する。反するものがあれば終了コード1
  evidence run [<id>...] [--repo <dir>]              inloop.jsonに書いた検査（テストなど）を実行し、結果を依頼票の証拠にする
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
    else if (BINARY_FILES.test(entry.name)) copyFileSync(src, dest);
    else writeFileSync(dest, readFileSync(src, "utf8").replaceAll("__APP_NAME__", name));
  }
}

/** Chrome拡張の鍵とID。公開鍵を manifest の key に入れると、読み込む場所によらず、IDが決まる（秘密鍵は要らない）。 */
export function extensionKey(): { key: string; id: string } {
  const der = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "der" });
  const id = [...createHash("sha256").update(der).digest().subarray(0, 16)].map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15))).join("");
  return { key: der.toString("base64"), id };
}

/** 新しいアプリのリポジトリを、標準の構成で作る（ADR-0011）。 */
function create(args: string[]): void {
  const name = option(args, "--name");
  const db = option(args, "--db") ?? "sqlite";
  const desktop = args.includes("--desktop");
  if (desktop) args.splice(args.indexOf("--desktop"), 1);
  const sync = args.includes("--sync");
  if (sync) args.splice(args.indexOf("--sync"), 1);
  // --sync は、端末内で動く構成（--standalone）に共有を足したもの。
  const standalone = args.includes("--standalone") || sync;
  if (args.includes("--standalone")) args.splice(args.indexOf("--standalone"), 1);
  if (desktop && standalone) throw new Error("--desktop と、--standalone・--sync は、同時に指定できない");
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
  // 手元で動くアプリは、サーバー向けの雛形の上に、Tauriの外枠と同梱の仕組みを重ねる（ADR-0019）。
  if (desktop) copyTemplate(join(ROOT, "templates", "desktop"), dir, appName);
  // 端末の中だけで動くアプリ（ADR-0039）は、サーバー向けの雛形のうち、Nodeのサーバーの起動を外し、
  // Web WorkerでHonoを動かす仕組みを重ねる。
  if (standalone) {
    copyTemplate(join(ROOT, "templates", "standalone"), dir, appName);
    // 共有（ADR-0041）: 同期の仕組みと、中継（relay/）、共有の画面を重ねる。
    if (sync) copyTemplate(join(ROOT, "templates", "sync"), dir, appName);
    rmSync(join(dir, "server", "index.ts"));
    rmSync(join(dir, "scripts"), { recursive: true });
    // Chrome拡張（npm run build:extension）。アプリごとに固定の鍵を作り、拡張のIDを決める。中継は、そのオリジンを許す。
    const ext = extensionKey();
    const manifest = join(dir, "web", "extension", "manifest.json");
    writeFileSync(manifest, readFileSync(manifest, "utf8").replace("__EXTENSION_KEY__", ext.key));
    const wrangler = join(dir, "relay", "wrangler.jsonc");
    if (existsSync(wrangler)) {
      writeFileSync(wrangler, readFileSync(wrangler, "utf8").replace(/("ALLOWED_ORIGINS": ")([^"]*)"/, `$1$2,chrome-extension://${ext.id}"`));
    }
  }
  execFileSync("git", ["init", "-q", dir]);
  init([dir, "--name", appName]);
  process.stdout.write(`作りました: ${dir}\n次に: cd ${basename(dir)} && npm install && npm run dev\n`);
}

/** 資源の雛形を作る（ADR-0038）。今いるディレクトリのリポジトリに作る。 */
function generate(args: string[]): void {
  const kind = args.shift();
  if (kind !== "scaffold") throw new Error(`知らない生成の種類「${kind ?? ""}」（scaffold）`);
  const plural = option(args, "--plural");
  const label = option(args, "--label");
  const name = args.shift();
  if (!name) throw new Error("資源の名前を指定する（例: inloop generate scaffold task title:text done:bool）");
  const resource = defineResource(name, args, { plural, label });
  const repo = gitTopLevel(process.cwd());
  const p = scaffoldPlan(repo, resource);
  scaffoldWrite(repo, p);
  process.stdout.write([...p.create.map((f) => `作りました: ${f.path}`), ...p.edit.map((f) => `書き換えました: ${f.path}`), "次に: npm test && npm run dev（画面の「" + resource.label + "」から使える）", ""].join("\n"));
  // 生成したコードが、セキュアコードの規則（ADR-0045）に反していないかを確かめる。
  if (!lint(["--repo", repo])) process.exitCode = 1;
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

/**
 * 回答が記録されるまで待つ（ADR-0016）。AIがバックグラウンドで動かし、終わったときに続きを始める。
 * 対象は--repo、なければ今いるディレクトリのリポジトリ。
 */
async function wait(args: string[]): Promise<void> {
  const repoArg = option(args, "--repo");
  const timeout = Number(option(args, "--timeout") ?? 86400);
  if (!Number.isInteger(timeout) || timeout <= 0) throw new Error("--timeout は1以上の秒数");
  const ids = args;
  if (ids.length === 0 || ids.some((id) => !/^R\d+(-\d+)?$/.test(id))) throw new Error("依頼IDを1つ以上指定する（例: inloop wait R4 R5）");
  const repo = gitTopLevel(resolve(repoArg ?? "."));
  const file = join(repo, ".inloop", LOG_FILE_NAME);
  if (!existsSync(file)) throw new Error(`${repo}: 依頼の記録がない`);
  const store = new ReviewStore({ file });
  const unknown = ids.filter((id) => !store.get(id));
  if (unknown.length > 0) throw new Error(`${unknown.join(" ")}: 存在しない依頼`);
  process.stdout.write(`${await answersOf(store, ids, timeout)}\n`);
}

/**
 * 信頼境界ルールが求める必須の依頼が、すべて承認済みかを確かめる（ADR-0022）。マージの前に、取り込む先を範囲に渡す。
 * 1つでも承認されていなければ終了コード1。記録は書かない。
 */
function check(args: string[]): void {
  const repoArg = option(args, "--repo");
  const range = option(args, "--range") ?? "HEAD";
  if (args.length > 0) throw new Error(`知らない引数 ${args.join(" ")}`);
  const repo = gitTopLevel(resolve(repoArg ?? "."));
  const file = join(repo, ".inloop", LOG_FILE_NAME);
  // 記録がなければ、作らずに空の記録として確かめる。
  const lines = checkRequired(repo, range, new ReviewStore(existsSync(file) ? { file } : {}));
  for (const l of lines) process.stdout.write(`${l.state}\t${l.id ?? "-"}\t${l.symbol}\t${l.rules.join(",")}\n`);
  const bad = lines.filter((l) => l.state !== "ok").length;
  if (bad === 0) process.stdout.write(`必須の依頼はすべて承認済み（${lines.length}件）\n`);
  else {
    process.stdout.write(`承認されていない必須の依頼がある（${bad}/${lines.length}件）。request_review を呼ぶと、必須の依頼が加わる\n`);
    process.exitCode = 1;
  }
  // セキュアコードの検査（ADR-0045）も、マージの条件に含める。
  if (!lint([...(repoArg ? ["--repo", repoArg] : [])])) process.exitCode = 1;
}

/** セキュアコードの規則に反するコードを検査する（ADR-0045）。反するものがなければtrue。 */
function lint(args: string[]): boolean {
  const repoArg = option(args, "--repo");
  if (args.length > 0) throw new Error(`知らない引数 ${args.join(" ")}`);
  const repo = gitTopLevel(resolve(repoArg ?? "."));
  const findings = lintRepo(repo, loadConfig(repo, "HEAD").secure);
  for (const f of findings) process.stdout.write(`${formatFinding(f)}\n`);
  process.stdout.write(findings.length === 0 ? "セキュアコードの検査: 違反なし\n" : `セキュアコードの検査: 違反が${findings.length}件ある\n`);
  return findings.length === 0;
}

/** inloop.jsonの`evidence`の検査を実行して記録する（ADR-0024）。1つでもfailなら終了コード1。 */
function evidence(args: string[]): void {
  const sub = args.shift();
  if (sub !== "run") throw new Error("使い方: inloop evidence run [<id>...] [--repo <dir>]");
  const repoArg = option(args, "--repo");
  const repo = gitTopLevel(resolve(repoArg ?? "."));
  const specs = loadConfig(repo, "HEAD").evidence;
  if (specs.length === 0) throw new Error("inloop.json に evidence がない");
  const results = runEvidence(repo, specs, args.length > 0 ? args : undefined);
  for (const r of results) process.stdout.write(`${r.status}\t${r.spec.id}\t${r.spec.name}\n`);
  if (results.some((r) => r.status !== "pass")) process.exitCode = 1;
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
      case "generate":
        generate(args);
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
      case "wait":
        await wait(args);
        return;
      case "check":
        check(args);
        return;
      case "lint":
        if (!lint(args)) process.exitCode = 1;
        return;
      case "evidence":
        evidence(args);
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
