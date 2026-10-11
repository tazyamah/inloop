import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

test("実プロセスとしてstdioで起動し、依頼を受け付ける", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../dist/server/main.js", import.meta.url))],
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
  assert.match(logs.join(""), /state=memory/);
  assert.match(logs.join(""), /\[inloop\] initialize client=\{"name":"stdio-test"/);
  assert.match(logs.join(""), /\[inloop\] call tool=request_review meta=/);
});

const MAIN = fileURLToPath(new URL("../dist/server/main.js", import.meta.url));

async function requestOnce({ args = [], env = {} }) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [MAIN, ...args], env: { ...process.env, ...env }, stderr: "pipe" });
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
  ]) {
    const r = spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", input: "", timeout: 10000 });
    assert.equal(r.status, 1, args.join(" "));
    assert.match(r.stderr, expected);
    assert.equal(r.stdout, "");
  }
});

test("--ui browserで、画面のURLを返し、接続が切れたら終了する", async () => {
  const { text, logs } = await requestOnce({ args: ["--ui", "browser"] });
  const m = text.match(/^R1 pending (http:\/\/127\.0\.0\.1:(\d+)\/r\/R1\?t=[\w-]+)$/);
  assert.ok(m, text);
  assert.match(logs.join(""), new RegExp(`browser UI on 127\\.0\\.0\\.1:${m[2]}`));
  assert.ok(!logs.join("").includes(new URL(m[1]).searchParams.get("t")), "鍵はログに出さない");
  // 標準入力が閉じたら、HTTPを開いていても終わる。
  const r = spawnSync(process.execPath, [MAIN, "--ui=browser"], { encoding: "utf8", input: "", timeout: 10000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /browser UI on/);
});
