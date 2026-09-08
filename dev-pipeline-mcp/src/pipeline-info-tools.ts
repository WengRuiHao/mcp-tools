import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { OVERVIEW_PROMPT, getRolePrompt } from "./prompts.js";
import { textResult } from "./shared.js";

export function registerPipelineInfoTools(server: McpServer): void {
  server.tool(
    "get_pipeline_overview",
    "取得整條 Asana 票單自動處理 pipeline 的流程說明（步驟、要呼叫哪些工具、安全限制）。任何要驅動這條 pipeline 的 AI，第一步都應該先呼叫這個工具讀懂整體流程。",
    {},
    async () => textResult(OVERVIEW_PROMPT)
  );

  server.tool(
    "get_role_prompt",
    "取得「分析師 / 工程師 / 驗證師」其中一個角色的職責說明、可用工具、輸出格式。驅動 pipeline 的 AI 在切換角色前應該先呼叫這個工具讀懂該角色的說明。",
    { role: z.enum(["analyst", "engineer", "verifier"]).describe("要取得說明的角色") },
    async ({ role }) => textResult(getRolePrompt(role))
  );
}
