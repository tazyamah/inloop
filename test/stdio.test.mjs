import { test } from "node:test";
import assert from "node:assert/strict";
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
    const r = await client.callTool({ name: "request_review", arguments: { viewpoint: "q" } });
    assert.equal(r.content[0].text, "R1 pending");
  } finally {
    await client.close();
  }
  assert.match(logs.join(""), /model-bound kind=request_review chars=10 bytes=10/);
});
