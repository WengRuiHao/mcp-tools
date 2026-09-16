#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerProjectTools } from "./project-tools.js";
import { registerBranchTools } from "./branch-tools.js";
import { registerCommitTools } from "./commit-tools.js";
import { registerFileTools } from "./file-tools.js";

const server = new McpServer({
  name: "gitlab-mcp",
  version: "0.1.0",
});

registerProjectTools(server);
registerBranchTools(server);
registerCommitTools(server);
registerFileTools(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("gitlab-mcp failed to start:", err);
  process.exit(1);
});
