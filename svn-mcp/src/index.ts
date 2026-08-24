#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerConnectionTools } from "./connection-tools.js";
import { registerReadTools } from "./read-tools.js";
import { registerHistoryTools } from "./history-tools.js";

const server = new McpServer({
  name: "svn-mcp",
  version: "0.2.0",
});

registerConnectionTools(server);
registerReadTools(server);
registerHistoryTools(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("svn-mcp failed to start:", err);
  process.exit(1);
});
