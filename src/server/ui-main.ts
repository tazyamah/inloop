#!/usr/bin/env node
// 画面のサーバーを前面で動かす（`inloop server`、またはMCPサーバーが別のプロセスとして起動する）。
import { uiPort } from "./apps.js";
import { startUiServer } from "./ui-server.js";

try {
  const server = await startUiServer({ port: uiPort() });
  process.stderr.write(`[inloop] UI server on 127.0.0.1:${server.port}\n`);
  // inloop server stop や、古い版の作り直しで止められる。
  process.on("SIGTERM", () => { void server.close().finally(() => process.exit(0)); });
} catch (e) {
  process.stderr.write(`[inloop] 画面のサーバーを起動できません: ${(e as Error).message}\n`);
  process.exit(1);
}
