#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { closeChildMcpClients } from "./mcp-clients.js";
import { registerPipelineInfoTools } from "./pipeline-info-tools.js";
import { registerTicketSnapshotTools } from "./ticket-snapshot-tools.js";
import { registerProjectConfigTools } from "./project-config-tools.js";
import { registerSdDocTools } from "./sd-doc-tools.js";
import { registerTestGuideTools } from "./test-guide-tools.js";
import { registerBridgeTools } from "./bridge-tools.js";
import { registerProjectFsTools } from "./project-fs-tools.js";
import { registerTicketLifecycleTools } from "./ticket-lifecycle-tools.js";
import { registerTicketArtifactTools } from "./ticket-artifact-tools.js";
import { registerWorktreeTools } from "./worktree-tools.js";
import { registerGitHookTools } from "./git-hooks-tools.js";
import { installActiveWarnings } from "./active-warnings.js";
import { startHttpBridge } from "./http-server.js";

const server = new McpServer({
  name: "dev-pipeline-mcp",
  version: "0.1.0",
});

// 必須在任何 registerXxxTools 之前安裝——它攔截 server.tool 本身，讓之後註冊的每一個工具回應都自動
// 附加 activeWarnings（跨 worktree 檔案重疊示警），見 active-warnings.ts 開頭說明。
installActiveWarnings(server);

registerPipelineInfoTools(server);
registerTicketSnapshotTools(server);
registerProjectConfigTools(server);
registerSdDocTools(server);
registerTestGuideTools(server);
registerBridgeTools(server);
registerProjectFsTools(server);
registerTicketLifecycleTools(server);
registerTicketArtifactTools(server);
registerWorktreeTools(server);
registerGitHookTools(server);

async function main() {
  // 跟著這個 MCP 行程一起帶起 PENDING_HUMAN_ACTIONS.html 用的 HTTP bridge（2026-09-17 起，見
  // http-server.ts 開頭說明的取捨）。同一台機器上通常會有好幾個 Claude Code session 各自啟動一份
  // index.js，只有第一個搶到 port 的會真的提供服務，其餘的 exitOnConflict:false 讓它們安靜略過、
  // 不影響這個 session 自己的 MCP 功能。
  startHttpBridge({ exitOnConflict: false });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

process.on("exit", () => {
  void closeChildMcpClients();
});

main().catch((err) => {
  console.error("dev-pipeline-mcp failed to start:", err);
  process.exit(1);
});
