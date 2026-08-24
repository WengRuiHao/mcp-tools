#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerProjectTools } from "./project-tools.js";
import { registerConnectionTools } from "./connection-tools.js";
import { registerSchemaTools } from "./schema-tools.js";
import { registerQueryTools } from "./query-tools.js";

const server = new McpServer({
  name: "db-mcp",
  version: "0.1.0",
});

registerProjectTools(server);
registerConnectionTools(server);
registerSchemaTools(server);
registerQueryTools(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("db-mcp failed to start:", err);
  process.exit(1);
});
