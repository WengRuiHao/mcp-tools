#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerDocxTools } from "./docx-tools.js";
import { registerXlsxTools } from "./xlsx-tools.js";
import { registerPdfTools } from "./pdf-tools.js";
import { registerCsvTools } from "./csv-tools.js";
import { registerFileTools } from "./file-tools.js";

const server = new McpServer({
  name: "office-docs-mcp",
  version: "0.1.0",
});

registerDocxTools(server);
registerXlsxTools(server);
registerPdfTools(server);
registerCsvTools(server);
registerFileTools(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("office-docs-mcp failed to start:", err);
  process.exit(1);
});
