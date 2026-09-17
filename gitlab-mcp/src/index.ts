#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerConnectionTools } from "./connection-tools.js";
import { registerProjectTools } from "./project-tools.js";
import { registerBranchTools } from "./branch-tools.js";
import { registerCommitTools } from "./commit-tools.js";
import { registerFileTools } from "./file-tools.js";
import { registerMergeRequestTools } from "./merge-request-tools.js";
import { registerIssueTools } from "./issue-tools.js";
import { registerPipelineTools } from "./pipeline-tools.js";
import { registerBranchRoleTools } from "./branch-role-tools.js";

const server = new McpServer({
  name: "gitlab-mcp",
  version: "0.4.1",
});

registerConnectionTools(server);
registerProjectTools(server);
registerBranchTools(server);
registerCommitTools(server);
registerFileTools(server);
registerMergeRequestTools(server);
registerIssueTools(server);
registerPipelineTools(server);
registerBranchRoleTools(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("gitlab-mcp failed to start:", err);
  process.exit(1);
});
