#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerConnectionTools } from "./connection-tools.js";
import { registerReadTools } from "./read-tools.js";
import { registerHistoryTools } from "./history-tools.js";
import { ensureEditServer } from "./edit-autostart.js";

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
  // 順便確保 svn-edit（使用者在網頁上編輯 SVN 檔案的本機服務）在跑；失敗不影響 MCP 本身
  ensureEditServer().catch((e) => console.error("[svn-mcp] ensureEditServer failed:", e));
}

main().catch((err) => {
  console.error("svn-mcp failed to start:", err);
  process.exit(1);
});
