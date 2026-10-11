#!/usr/bin/env node
// 互換の入口。`inloop mcp`と同じMCPサーバーを動かす。
import { runMcp } from "./mcp.js";

await runMcp(process.argv.slice(2));
