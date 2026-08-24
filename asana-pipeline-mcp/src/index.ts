#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { closeChildMcpClients } from "./mcp-clients.js";
import { registerPipelineInfoTools } from "./pipeline-info-tools.js";
import { registerTicketSnapshotTools } from "./ticket-snapshot-tools.js";
import { registerProjectConfigTools } from "./project-config-tools.js";
import { registerSdDocTools } from "./sd-doc-tools.js";
import { registerBridgeTools } from "./bridge-tools.js";
import { registerProjectFsTools } from "./project-fs-tools.js";
import { registerTicketLifecycleTools } from "./ticket-lifecycle-tools.js";
import { registerTicketArtifactTools } from "./ticket-artifact-tools.js";

const server = new McpServer({
  name: "asana-pipeline-mcp",
  version: "0.1.0",
});

registerPipelineInfoTools(server);
registerTicketSnapshotTools(server);
registerProjectConfigTools(server);
registerSdDocTools(server);
registerBridgeTools(server);
registerProjectFsTools(server);
registerTicketLifecycleTools(server);
registerTicketArtifactTools(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

process.on("exit", () => {
  void closeChildMcpClients();
});

main().catch((err) => {
  console.error("asana-pipeline-mcp failed to start:", err);
  process.exit(1);
});
