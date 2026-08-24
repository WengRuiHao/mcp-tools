import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getRolePrompt } from "./prompts.js";

export function registerRoleTools(server: McpServer): void {
  server.tool(
    "get_role_prompt",
    "取得「分析師」／「工程師」／「驗證師」角色的完整說明（任務內容、硬性規則、輸出格式）。" +
      "這個 MCP 本身不跑 LLM、不替你分析或寫程式碼，這三個角色都是由呼叫端的 AI 自己扮演——" +
      "這個工具只負責提供固定的角色說明文字，讓任何連上這個 MCP 的 AI host 都能拿到同一套流程定義，不用各自維護一份可能兜不起來的版本。",
    {
      role: z.enum(["analyst", "engineer", "verifier"]).describe(
        "analyst：對照規格判斷需求實作程度；engineer：依分析結論實際修改程式碼；verifier：核對修改是否真的符合規格需求"
      ),
    },
    async ({ role }) => {
      return {
        content: [
          {
            type: "text",
            text: getRolePrompt(role),
          },
        ],
      };
    }
  );
}
