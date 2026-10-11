import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { request } from "node:http";
import { createServer as createNetServer } from "node:net";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

function gitRepo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "inloop-repo-")));
  execFileSync("git", ["init", "-q", dir]);
  return dir;
}

test("実プロセスとしてstdioで起動し、依頼を受け付ける", async () => {
  const repo = gitRepo();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../dist/server/main.js", import.meta.url)), "--repo", repo],
    stderr: "pipe",
  });
  const logs = [];
  transport.stderr?.on("data", (d) => logs.push(String(d)));
  const client = new Client({ name: "stdio-test", version: "0" });
  await client.connect(transport);
  try {
    const r = await client.callTool({ name: "request_review", arguments: { reviews: [{ viewpoint: "q" }] } });
    assert.equal(r.content[0].text, "R1 pending");
  } finally {
    await client.close();
  }
  assert.match(logs.join(""), /model-bound kind=request_review chars=10 bytes=10/);
  assert.match(logs.join(""), /state=repo/);
  // 記録は対象のリポジトリの.inloop/に置き、中に自分用の.gitignoreを置く（ADR-0010）。
  assert.equal(readFileSync(join(repo, ".inloop", "reviews.jsonl"), "utf8").trimEnd().split("\n").length, 1);
  assert.equal(readFileSync(join(repo, ".inloop", ".gitignore"), "utf8"), "*\n");
  assert.match(logs.join(""), /\[inloop\] initialize client=\{"name":"stdio-test"/);
  assert.match(logs.join(""), /\[inloop\] call tool=request_review meta=/);
});

const MAIN = fileURLToPath(new URL("../dist/server/main.js", import.meta.url));
const BIN = fileURLToPath(new URL("../bin/inloop", import.meta.url));
const UI_SERVER_JS = fileURLToPath(new URL("../dist/server/ui-server.js", import.meta.url));

function freePort() {
  return new Promise((resolve) => {
    const s = createNetServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function httpGet(port, path, host) {
  return new Promise((resolve, reject) => {
    request({ host: "127.0.0.1", port, path, headers: { host } }, (res) => { res.resume(); res.on("end", () => resolve({ status: res.statusCode })); }).on("error", reject).end();
  });
}

async function requestOnce({ args = [], env = {}, cwdRepo }) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [MAIN, ...args], env: { ...process.env, ...env }, stderr: "pipe", ...(cwdRepo ? { cwd: cwdRepo } : {}) });
  const logs = [];
  transport.stderr?.on("data", (d) => logs.push(String(d)));
  const client = new Client({ name: "stdio-test", version: "0" });
  await client.connect(transport);
  try {
    const r = await client.callTool({ name: "request_review", arguments: { reviews: [{ viewpoint: "q" }] } });
    return { text: r.content[0].text, logs };
  } finally {
    await client.close();
  }
}

test("--state-dirを指定すると、プロセスを起動し直しても依頼が残る", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "inloop-stdio-")), ".inloop");
  const first = await requestOnce({ args: ["--state-dir", dir] });
  assert.equal(first.text, "R1 pending");
  assert.ok(first.logs.join("").includes(`state=${join(dir, "reviews.jsonl")}`), first.logs.join(""));
  const second = await requestOnce({ args: [`--state-dir=${dir}`] });
  assert.equal(second.text, "R2 pending");
  // 環境変数でも指定でき、引数が優先する。
  const third = await requestOnce({ env: { INLOOP_STATE_DIR: dir } });
  assert.equal(third.text, "R3 pending");
  const other = join(mkdtempSync(join(tmpdir(), "inloop-stdio-")), ".inloop");
  const fourth = await requestOnce({ args: ["--state-dir", other], env: { INLOOP_STATE_DIR: dir } });
  assert.equal(fourth.text, "R1 pending");
  assert.equal(readFileSync(join(dir, "reviews.jsonl"), "utf8").trimEnd().split("\n").length, 3);
});

test("保存先を使えない場合や引数が不正な場合は、メモリで動かさずに終了する", () => {
  const dir = mkdtempSync(join(tmpdir(), "inloop-stdio-"));
  writeFileSync(join(dir, "reviews.jsonl"), "{broken\n");
  const blocked = join(dir, "file");
  writeFileSync(blocked, "");
  for (const [args, expected] of [
    [["--state-dir", dir], /起動できません: .*reviews\.jsonl:1: JSONとして読めない/],
    [["--state-dir", join(blocked, "sub")], /起動できません/],
    [["--state-dir"], /起動できません: --state-dir にディレクトリの指定がない/],
    [["--unknown"], /起動できません: 知らない引数 --unknown/],
    [["--ui", "web"], /起動できません: --ui は browser か mcp-apps/],
    [["--repo", dir], /起動できません: .*gitの作業ツリーではない/],
    [["--ui", "browser", "--state-dir", mkdtempSync(join(tmpdir(), "inloop-stdio-"))], /起動できません: --ui browser は --state-dir と併用できない/],
  ]) {
    const r = spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", input: "", timeout: 10000 });
    assert.equal(r.status, 1, args.join(" "));
    assert.match(r.stderr, expected);
    assert.equal(r.stdout, "");
  }
});

test("--ui browserで、画面のサーバーを起動し、MCPサーバーが起動し直しても同じURLを返す", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "inloop-home-")));
  const port = await freePort();
  const env = { INLOOP_HOME: home, INLOOP_PORT: String(port) };
  const repo = gitRepo();
  const init = spawnSync(process.execPath, [BIN, "init", repo, "--name", "appa"], { encoding: "utf8", env: { ...process.env, ...env } });
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stdout, new RegExp(`登録しました: appa → ${repo}`));
  let pid;
  try {
    const first = await requestOnce({ args: ["--ui", "browser", "--repo", repo], env: { ...env } });
    assert.equal(first.text, `R1 pending http://appa.inloop.localhost:${port}/r/R1`, first.logs.join(""));
    // MCPサーバーが終わっても、画面のサーバーは残り、同じURLで画面を開ける。
    const health = await (await fetch(`http://127.0.0.1:${port}/_inloop/health`)).json();
    pid = health.pid;
    const page = await httpGet(port, "/r/R1", `appa.inloop.localhost:${port}`);
    assert.equal(page.status, 200);
    const second = await requestOnce({ args: ["--ui", "browser", "--repo", repo], env: { ...env } });
    assert.equal(second.text, `R2 pending http://appa.inloop.localhost:${port}/r/R2`);
    const again = await (await fetch(`http://127.0.0.1:${port}/_inloop/health`)).json();
    assert.equal(again.pid, pid, "2つ目のMCPサーバーは、動いている画面のサーバーを使う");

    // ビルドし直した後（inloop update など）は、次の依頼で新しい版に作り直す。
    const later = new Date(Date.now() + 5000);
    utimesSync(UI_SERVER_JS, later, later);
    const third = await requestOnce({ args: ["--ui", "browser", "--repo", repo], env: { ...env } });
    assert.equal(third.text, `R3 pending http://appa.inloop.localhost:${port}/r/R3`);
    const rebuilt = await (await fetch(`http://127.0.0.1:${port}/_inloop/health`)).json();
    assert.notEqual(rebuilt.pid, pid, "古い版の画面のサーバーは作り直す");
    pid = rebuilt.pid;

    // inloop server で状態を見て、止めて、起動し直せる。
    const cli = (...a) => spawnSync(process.execPath, [BIN, "server", ...a], { encoding: "utf8", env: { ...process.env, ...env } });
    assert.match(cli("status").stdout, new RegExp(`動いています（ポート${port}、pid ${pid}）`));
    assert.match(cli("stop").stdout, /止めました/);
    pid = undefined;
    assert.match(cli("status").stdout, /動いていません/);
    assert.match(cli("start").stdout, /動いています/);
    pid = (await (await fetch(`http://127.0.0.1:${port}/_inloop/health`)).json()).pid;
    assert.equal((await httpGet(port, "/r/R3", `appa.inloop.localhost:${port}`)).status, 200, "起動し直しても同じURLで開ける");
  } finally {
    if (pid) process.kill(pid);
  }
});

test("対象を決められない依頼は、記録せずに拒否する", async () => {
  const { text, logs } = await requestOnce({ args: [] });
  assert.equal(text, "repo がない");
  assert.match(logs.join(""), /state=repo/);
});
