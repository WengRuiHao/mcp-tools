#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerSpecLoadingTools } from "./spec-loading-tools.js";
import { registerGitRegistryTools } from "./git-registry-tools.js";
import { registerRoleTools } from "./role-tools.js";

const server = new McpServer({
  name: "spec-pipeline-mcp",
  version: "0.1.0",
});

registerSpecLoadingTools(server);
registerGitRegistryTools(server);
registerRoleTools(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("spec-pipeline-mcp failed to start:", err);
  process.exit(1);
});
