#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerDiscoveryTools } from "./discovery-tools.js";
import { registerTaskTools } from "./task-tools.js";
import { registerAttachmentTools } from "./attachment-tools.js";

const server = new McpServer({
  name: "asana-mcp",
  version: "0.1.0",
});

registerDiscoveryTools(server);
registerTaskTools(server);
registerAttachmentTools(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("asana-mcp failed to start:", err);
  process.exit(1);
});
