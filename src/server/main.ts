#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createServer } from "./create-server.js";

const server = createServer();
await server.connect(new StdioServerTransport());
process.stderr.write("[inloop] MCP server started (stdio)\n");
