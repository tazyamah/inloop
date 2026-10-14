import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import { makeRepo } from "./helpers.mjs";
import { CODEX_MCP, planCodexConfig } from "../dist/client-config.js";

test("Codexの設定に既存のコメント・他のサーバーを残し、繰り返しても変更しない", () => {
  const repo = makeRepo();
  const { file, content } = planCodexConfig(repo);
  assert.equal(content, CODEX_MCP);
  mkdirSync(join(repo, ".codex"));
  const source = '# 利用者の設定\nmodel = "example"\n[mcp_servers.other]\ncommand = "other"';
  writeFileSync(file, source);
  const planned = planCodexConfig(repo);
  assert.ok(planned.content.startsWith(source));
  assert.equal(parse(planned.content).mcp_servers.other.command, "other");
  writeFileSync(file, planned.content);
  assert.deepEqual(planCodexConfig(repo), { file, preserved: true });
  assert.equal(readFileSync(file, "utf8"), planned.content);
});

test("Codexの既存のinloop登録は、引用キー・ドットキー・インライン形式でも上書きしない", () => {
  for (const source of [
    '[mcp_servers."inloop"]\ncommand = "custom"\nenabled = false\n',
    'mcp_servers.inloop.command = "custom"\n',
    'mcp_servers = { inloop = { command = "custom" } }\n',
  ]) {
    const repo = makeRepo();
    mkdirSync(join(repo, ".codex"));
    const file = join(repo, ".codex", "config.toml");
    writeFileSync(file, source);
    const planned = planCodexConfig(repo);
    assert.equal(planned.preserved, true);
    assert.equal(planned.content, undefined);
    assert.equal(readFileSync(file, "utf8"), source);
  }
});

test("壊れたTOMLと追記できない形式は、initの登録・書き込み前に拒否し、設定本文を出さない", () => {
  const bin = fileURLToPath(new URL("../bin/inloop", import.meta.url));
  for (const source of ['token = "private-example"\nbroken = [', 'mcp_servers = "private-example"', 'mcp_servers = { other = { command = "x" } }']) {
    const repo = makeRepo();
    const home = join(repo, "test-home");
    mkdirSync(join(repo, ".codex"));
    const file = join(repo, ".codex", "config.toml");
    writeFileSync(file, source);
    const r = spawnSync(process.execPath, [bin, "init", repo], { encoding: "utf8", env: { ...process.env, INLOOP_HOME: home } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /TOMLの構文/);
    assert.doesNotMatch(r.stderr, /private-example/);
    assert.equal(readFileSync(file, "utf8"), source);
    assert.ok(!existsSync(join(home, "apps.json")));
    assert.ok(!existsSync(join(repo, ".mcp.json")));
  }
});

test("維持した既存のinloop登録が無効、または別のcommandなら警告する（書き換えない）", () => {
  for (const [source, warned] of [
    ['[mcp_servers.inloop]\ncommand = "inloop"\nenabled = false\n', /enabled = false/],
    ['[mcp_servers.inloop]\ncommand = "custom"\n', /command/],
    ['[mcp_servers.inloop]\ncommand = "inloop"\nargs = ["mcp"]\n', undefined],
  ]) {
    const repo = makeRepo();
    mkdirSync(join(repo, ".codex"));
    const file = join(repo, ".codex", "config.toml");
    writeFileSync(file, source);
    const planned = planCodexConfig(repo);
    assert.equal(planned.preserved, true);
    if (warned) assert.match(planned.warning, warned);
    else assert.equal(planned.warning, undefined);
    assert.equal(readFileSync(file, "utf8"), source);
  }
});

test("壊れた.mcp.jsonは、initの登録・Codex設定の書き込み前に拒否する", () => {
  const bin = fileURLToPath(new URL("../bin/inloop", import.meta.url));
  const repo = makeRepo();
  const home = join(repo, "test-home");
  writeFileSync(join(repo, ".mcp.json"), "{ broken");
  const r = spawnSync(process.execPath, [bin, "init", repo], { encoding: "utf8", env: { ...process.env, INLOOP_HOME: home } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\.mcp\.json/);
  assert.ok(!existsSync(join(home, "apps.json")));
  assert.ok(!existsSync(join(repo, ".codex", "config.toml")));
});

test("本体と標準の雛形の信頼境界ルールに、クライアント設定の変更を必須にするルールがある", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  for (const file of ["inloop.json", ...["server", "desktop", "standalone", "sync"].map((t) => `templates/${t}/inloop.json`)]) {
    const rule = JSON.parse(readFileSync(join(root, file), "utf8")).boundaries.find((b) => b.id === "client-config");
    assert.deepEqual(rule?.match, [{ files: [".mcp.json", ".codex/config.toml"] }], file);
  }
});
