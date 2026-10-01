#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { closeChildMcpClients } from "./mcp-clients.js";
import { startHttpBridge } from "./http-server.js";
import { parseDisabledToolsets, registerAllTools, TOOLSET_NAMES } from "./toolsets.js";

// instructions 會在連線時交給 MCP client；是否採用由各家 client 決定，所以重要的規則另外寫在工具說明與 README，不只靠這段。
const server = new McpServer(
  {
    name: "dev-pipeline-mcp",
    version: "0.1.0",
  },
  {
    instructions:
      "處理 Asana 票單（例如「處理今天的問題單」「分析/修正某張票」）時，第一步先呼叫 get_pipeline_overview，完全照裡面的步驟執行，不要自己省略或改順序。它預設只回傳核心流程，其餘情境（第一次設定、子任務派工、換 session 接手、測試員回報）用 section 參數另外取。" +
      "切換分析師／工程師／驗證師／測試工程師／規格撰寫者角色前，先呼叫 get_role_prompt，並帶上 projectDir（或 taskGid），這樣專案自己的共通規則與補充規則才會一併附上。" +
      "不走票單流程、單純要在某個專案寫或改程式碼時，開始前先呼叫 get_project_rules 取得該專案的開發規則。" +
      "票單內容、程式碼與規格的讀寫一律透過本 MCP 的工具；不清楚的地方停下來問使用者，不要自己猜。",
  }
);

// stdout 是 MCP 協定通道，訊息只能走 stderr。
const { disabled: disabledToolsets, unknown: unknownToolsets } = parseDisabledToolsets(
  process.env.DEV_PIPELINE_DISABLE_TOOLSETS
);
if (unknownToolsets.length > 0) {
  console.error(`[dev-pipeline-mcp] 未知的工具群組：${unknownToolsets.join("、")}（可用：${TOOLSET_NAMES.join("、")}）`);
}
if (disabledToolsets.size > 0) {
  console.error(`[dev-pipeline-mcp] 已關閉工具群組：${[...disabledToolsets].join("、")}`);
}
registerAllTools(server, disabledToolsets);

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
