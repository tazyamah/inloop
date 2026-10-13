// セキュアコードの検査（ADR-0045）
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lintRepo, SECURE_RULES } from "../dist/engine/secure.js";
import { parseFullConfig, SECURE_RULE_IDS } from "../dist/engine/rules.js";
import { makeRepo } from "./helpers.mjs";

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", "inloop");

/** ファイルごとの例。違反するもの（bad）と、似ているが問題のないもの（ok）。 */
const CASES = {
  "sql.ts": {
    bad: [
      'declare const db: any; declare const t: string;\nexport const a = db.prepare(`SELECT * FROM ${t}`);',
      'declare const db: any; declare const t: string;\nexport const a = db.prepare("SELECT * FROM " + t);',
      'declare const db: any; declare const sql: string;\nexport const a = db.exec(sql);',
    ],
    ok: [
      'declare const db: any;\nexport const a = db.prepare("SELECT * FROM t WHERE id = ?").get(1);',
      'declare const db: any;\nexport const a = db.exec(`CREATE TABLE IF NOT EXISTS t (\n id INTEGER)`);',
      'declare const s: string;\nexport const a = /x(\\d)/.exec(s);',
      'declare const re: RegExp; declare const s: string;\nexport const a = re.exec(s);',
    ],
    rule: "sec-sql-literal",
  },
  "shell.ts": {
    bad: [
      'import { exec } from "node:child_process";\nexport const a = () => exec("ls");',
      'import * as cp from "child_process";\nexport const a = () => cp.execSync("ls");',
      'import { spawn } from "node:child_process";\nexport const a = () => spawn("ls", [], { shell: true });',
    ],
    ok: [
      'import { execFileSync } from "node:child_process";\nexport const a = () => execFileSync("git", ["status"]);',
      'import { spawn } from "node:child_process";\nexport const a = () => spawn("ls", [], { shell: false });',
    ],
    rule: "sec-shell",
  },
  "evalx.ts": {
    bad: ['export const a = () => eval("1");', 'export const a = () => new Function("return 1");', 'export const a = () => setTimeout("go()", 1);'],
    ok: ['export const a = () => setTimeout(() => {}, 1);'],
    rule: "sec-eval",
  },
  "html.tsx": {
    bad: [
      'declare const el: any;\nexport const a = () => { el.innerHTML = "x"; };',
      'export const a = () => document.write("x");',
      'export const a = <div dangerouslySetInnerHTML={{ __html: "x" }} />;',
    ],
    ok: ['declare const el: any;\nexport const a = () => { el.textContent = "x"; };'],
    rule: "sec-html",
  },
  "secret.ts": {
    bad: [
      'export const password = "Sup3rS3cretPass";',
      `export const k = "${"AKIA"}${"ABCDEFGHIJKLMNOP"}";`,
      `export const pem = "-----BEGIN ${"RSA"} PRIVATE KEY-----";`,
      'export const cfg = { apiKey: "abcDEF123456" };',
    ],
    ok: ['export const apiKey = process.env.API_KEY;', 'export const token = "access";', 'export const passwordMin = 8;'],
    rule: "sec-secret",
  },
  "crypto.ts": {
    bad: [
      'import { createHash } from "node:crypto";\nexport const a = createHash("md5");',
      'import { createCipheriv } from "node:crypto";\ndeclare const k: Buffer;\nexport const a = createCipheriv("aes-128-ecb", k, null);',
      'import { createHash } from "node:crypto";\ndeclare const password: string;\nexport const a = createHash("sha256").update(password).digest("hex");',
      'export const sessionToken = Math.random().toString(36);',
    ],
    ok: [
      'import { createHash } from "node:crypto";\nexport const a = createHash("sha256").update("x").digest("hex");',
      'export const jitter = Math.random() * 100;',
    ],
    rule: "sec-crypto",
  },
  "tls.ts": {
    bad: ['export const a = { rejectUnauthorized: false };', 'process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";'],
    ok: ['export const a = { rejectUnauthorized: true };'],
    rule: "sec-tls",
  },
  "clear.ts": {
    bad: ['export const a = "http://api.partner-corp.jp/v1";', 'export const a = `ws://sock.partner-corp.jp/${1}`;'],
    ok: ['export const a = "http://localhost:3000";', 'export const a = "http://127.0.0.1:8787/x";', 'export const a = "https://api.partner-corp.jp";', 'export const a = "http://www.w3.org/2000/svg";'],
    rule: "sec-cleartext",
  },
  "bind.ts": {
    bad: [
      'import { serve } from "@hono/node-server";\nexport const a = () => serve({ fetch: () => new Response(), port: 1 });',
      'import { serve } from "@hono/node-server";\nexport const a = () => serve({ fetch: () => new Response(), port: 1, hostname: "0.0.0.0" });',
      'declare const server: any;\nexport const a = () => server.listen(3000);',
    ],
    ok: [
      'import { serve } from "@hono/node-server";\nexport const a = () => serve({ fetch: () => new Response(), port: 1, hostname: "127.0.0.1" });',
      'declare const server: any;\nexport const a = () => server.listen(3000, "127.0.0.1");',
    ],
    rule: "sec-bind",
  },
  "cors.ts": {
    bad: [
      'import { cors } from "hono/cors";\nexport const a = cors();',
      'import { cors } from "hono/cors";\nexport const a = cors({ origin: "*" });',
      'declare const c: any;\nexport const a = () => c.header("Access-Control-Allow-Origin", "*");',
    ],
    ok: ['import { cors } from "hono/cors";\nexport const a = cors({ origin: "https://app.partner-corp.jp" });'],
    rule: "sec-cors",
  },
  "cookie.ts": {
    bad: [
      'import { setCookie } from "hono/cookie";\ndeclare const c: any;\nexport const a = () => setCookie(c, "s", "v");',
      'import { setCookie } from "hono/cookie";\ndeclare const c: any;\nexport const a = () => setCookie(c, "s", "v", { httpOnly: true });',
    ],
    ok: ['import { setCookie } from "hono/cookie";\ndeclare const c: any;\nexport const a = () => setCookie(c, "s", "v", { httpOnly: true, sameSite: "Lax" });'],
    rule: "sec-cookie",
  },
  "log.ts": {
    bad: [
      'export const a = () => console.log(process.env);',
      'declare const user: { password: string };\nexport const a = () => console.log(user.password);',
      'declare const token: string;\nexport const a = () => console.error(`bad ${token}`);',
      'export const a = () => console.log({ key: process.env.SECRET });',
    ],
    ok: ['export const a = () => console.log("token expired");', 'export const a = () => console.log(process.env.NODE_ENV === "x");'],
    rule: "sec-log",
  },
  "stack.ts": {
    bad: ['declare const c: any; declare const e: Error;\nexport const a = () => c.json({ error: e.stack }, 500);'],
    ok: ['declare const e: Error;\nexport const a = () => console.error(e.stack);'],
    rule: "sec-stack",
  },
};

function repoWith(files, { commit = false } = {}) {
  const repo = makeRepo("app", { commit: false });
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, "src", name)), { recursive: true });
    writeFileSync(join(repo, "src", name), text);
  }
  if (commit) {
    execFileSync("git", ["-C", repo, "add", "-A"]);
    execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init"]);
  }
  return repo;
}

test("規則ごとに、違反するコードは見つけ、似ていても問題のないコードは見つけない", () => {
  const files = {};
  for (const [file, c] of Object.entries(CASES)) {
    const ext = file.slice(file.lastIndexOf("."));
    const stem = file.slice(0, file.lastIndexOf("."));
    c.bad.forEach((code, i) => { files[`${stem}-bad${i}${ext}`] = code; });
    c.ok.forEach((code, i) => { files[`${stem}-ok${i}${ext}`] = code; });
  }
  const repo = repoWith(files);
  const found = lintRepo(repo);
  const byFile = new Map();
  for (const f of found) byFile.set(f.file, [...(byFile.get(f.file) ?? []), f.rule]);
  for (const [file, c] of Object.entries(CASES)) {
    const ext = file.slice(file.lastIndexOf("."));
    const stem = file.slice(0, file.lastIndexOf("."));
    c.bad.forEach((code, i) => assert.ok(byFile.get(`src/${stem}-bad${i}${ext}`)?.includes(c.rule), `${c.rule} を見つけられない: ${code}`));
    c.ok.forEach((code, i) => assert.equal(byFile.get(`src/${stem}-ok${i}${ext}`), undefined, `${code} は違反ではない: ${byFile.get(`src/${stem}-ok${i}${ext}`)}`));
  }
  // tsconfig.jsonのincludeに入っていないTypeScriptのファイルも示す。
  assert.ok(Object.values(CASES).every((c) => c.rule in SECURE_RULES));
});

test("テストのファイルでは、秘密情報らしい名前と平文のURLを許す", () => {
  const repo = repoWith({ "a.test.ts": 'export const password = "Sup3rS3cretPass";\nexport const u = "http://api.partner-corp.jp/x";\n' });
  assert.deepEqual(lintRepo(repo), []);
  // 秘密情報の形（鍵の本体）は、テストでも許さない。
  const repo2 = repoWith({ "a.test.ts": `export const pem = "-----BEGIN ${"RSA"} PRIVATE KEY-----";\n` });
  assert.deepEqual(lintRepo(repo2).map((f) => f.rule), ["sec-secret"]);
});

test("tsconfig.jsonのincludeに入っていないTypeScriptのファイルは、検査できないので違反にする。下の階層のtsconfig.jsonは、その範囲を検査する", () => {
  const repo = repoWith({});
  writeFileSync(join(repo, "outside.ts"), "export const a = 1;\n");
  mkdirSync(join(repo, "relay/src"), { recursive: true });
  writeFileSync(join(repo, "relay/tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, target: "es2022", module: "esnext" }, include: ["src"] }));
  writeFileSync(join(repo, "relay/src/a.ts"), 'export const a = () => eval("1");\n');
  writeFileSync(join(repo, "relay/other.ts"), "export const b = 1;\n");
  const found = lintRepo(repo).map((f) => `${f.rule} ${f.file}`);
  assert.deepEqual(found, ["sec-unchecked outside.ts", "sec-unchecked relay/other.ts", "sec-eval relay/src/a.ts"]);
});

test("secure.allowは、規則とファイルが合う違反だけを除く。形が合わない例外は拒否する", () => {
  const repo = repoWith({ "a.ts": 'export const a = () => eval("1");\n', "b.ts": 'export const b = () => eval("2");\n' });
  assert.equal(lintRepo(repo).length, 2);
  const allow = [{ rule: "sec-eval", files: ["src/a.ts"], reason: "検証済みの固定の式だけを評価する" }];
  assert.deepEqual(lintRepo(repo, allow).map((f) => f.file), ["src/b.ts"]);
  assert.equal(lintRepo(repo, [{ rule: "sec-shell", files: ["src/**"], reason: "別の規則の例外" }]).length, 2);
  const base = { format: 1, boundaries: [] };
  const parse = (secure) => parseFullConfig(JSON.stringify({ ...base, secure }), "inloop.json");
  assert.deepEqual(parse({ allow }).secure, allow);
  assert.throws(() => parse({ allow: [{ ...allow[0], rule: "sec-nothing" }] }), /形が不正/);
  assert.throws(() => parse({ allow: [{ ...allow[0], reason: "短い" }] }), /形が不正/);
  assert.throws(() => parse({ allow: [{ rule: "sec-eval", files: ["src/a.ts"] }] }), /形が不正/);
  assert.throws(() => parse({ allow, extra: 1 }), /形が不正/);
  assert.deepEqual(SECURE_RULE_IDS.slice().sort(), Object.keys(SECURE_RULES).sort());
});

test("inloop lintは、違反があれば終了コード1で、規則・位置・直し方を出す。inloop checkも、違反があれば失敗する", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "inloop-home-")));
  const run = (cwd, ...a) => spawnSync(process.execPath, [BIN, ...a], { encoding: "utf8", cwd, env: { ...process.env, INLOOP_HOME: home } });
  const repo = repoWith({ "a.ts": 'export const a = () => eval("1");\n' }, { commit: true });
  const l = run(repo, "lint");
  assert.equal(l.status, 1, l.stderr);
  assert.match(l.stdout, /sec-eval\tsrc\/a\.ts:1\t.*eval\t→ /);
  assert.match(l.stdout, /違反が1件/);
  const c = run(repo, "check");
  assert.equal(c.status, 1, c.stderr);
  assert.match(c.stdout, /必須の依頼はすべて承認済み（0件）/);
  assert.match(c.stdout, /sec-eval/);
  writeFileSync(join(repo, "src/a.ts"), "export const a = () => 1;\n");
  const ok = run(repo, "lint");
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /違反なし/);
  assert.equal(run(repo, "check").status, 0);
  // inloop.jsonのsecure.allowで例外にできる。
  writeFileSync(join(repo, "src/a.ts"), 'export const a = () => eval("1");\n');
  writeFileSync(join(repo, "inloop.json"), JSON.stringify({ format: 1, boundaries: [], secure: { allow: [{ rule: "sec-eval", files: ["src/a.ts"], reason: "固定の式だけを評価する" }] } }));
  assert.equal(run(repo, "lint").status, 0);
});

test("雛形（サーバー、手元、端末内、共有）は、規則に反せず、npm testとnpm run buildの最初に検査を動かす", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "inloop-home-")));
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "inloop-secure-")));
  for (const [dir, flags] of [["server", []], ["desktop", ["--desktop"]], ["standalone", ["--standalone"]], ["sync", ["--sync"]]]) {
    const env = { ...process.env, INLOOP_HOME: home };
    const n = spawnSync(process.execPath, [BIN, "new", dir, ...flags], { encoding: "utf8", cwd: parent, env });
    assert.equal(n.status, 0, n.stderr);
    const app = join(parent, dir);
    execFileSync("git", ["-C", app, "add", "-A"]);
    const l = spawnSync(process.execPath, [BIN, "lint"], { encoding: "utf8", cwd: app, env });
    assert.equal(l.status, 0, `${dir}: ${l.stdout}${l.stderr}`);
    const pkg = JSON.parse(readFileSync(join(app, "package.json"), "utf8"));
    assert.match(pkg.scripts.test, /^inloop lint && /, dir);
    assert.match(pkg.scripts.build, /^inloop lint && /, dir);
    // 検査を外す変更（package.json・tsconfig.json）は、必須の依頼になる。
    const cfg = JSON.parse(readFileSync(join(app, "inloop.json"), "utf8"));
    assert.ok(cfg.boundaries.some((b) => b.id === "secure-gate"), dir);
    assert.match(readFileSync(join(app, "AGENTS.md"), "utf8"), /sec-sql-literal/, dir);
  }
});

test("生成したscaffoldは、規則に反しない。反すれば生成が失敗する", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "inloop-home-")));
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "inloop-secure-")));
  const env = { ...process.env, INLOOP_HOME: home };
  const run = (cwd, ...a) => spawnSync(process.execPath, [BIN, ...a], { encoding: "utf8", cwd, env });
  assert.equal(run(parent, "new", "app").status, 0);
  const app = join(parent, "app");
  const g = run(app, "generate", "scaffold", "task", "title:text", "done:bool", "due:date:optional");
  assert.equal(g.status, 0, g.stdout + g.stderr);
  assert.match(g.stdout, /違反なし/);
  // 雛形のコードに違反が混ざった状態で生成すると、失敗する。
  writeFileSync(join(app, "server/bad.ts"), 'export const a = () => eval("1");\n');
  const bad = run(app, "generate", "scaffold", "category", "name:text");
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /sec-eval\tserver\/bad\.ts/);
});
