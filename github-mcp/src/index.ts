#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerRepoTools } from "./repo-tools.js";
import { registerIssueTools } from "./issue-tools.js";
import { registerPrTools } from "./pr-tools.js";

const server = new McpServer({
  name: "github-mcp",
  version: "0.1.0",
});

registerRepoTools(server);
registerIssueTools(server);
registerPrTools(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("github-mcp failed to start:", err);
  process.exit(1);
});
