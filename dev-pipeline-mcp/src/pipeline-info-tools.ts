import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { OVERVIEW_PROMPT, getRolePrompt } from "./prompts.js";
import { fsReadFile } from "./fs-tools.js";
import { textResult } from "./shared.js";

const PROJECT_ROLE_ADDENDUM_DIR = ".claude/pipeline-roles";

async function readProjectRoleAddendum(projectDir: string, role: string): Promise<string | null> {
  try {
    const { content } = await fsReadFile(projectDir, `${PROJECT_ROLE_ADDENDUM_DIR}/${role}.md`);
    return content.trim() ? content : null;
  } catch {
    return null;
  }
}

export function registerPipelineInfoTools(server: McpServer): void {
  server.tool(
    "get_pipeline_overview",
    "取得整條 Asana 票單自動處理 pipeline 的流程說明（步驟、要呼叫哪些工具、安全限制）。任何要驅動這條 pipeline 的 AI，第一步都應該先呼叫這個工具讀懂整體流程。",
    {},
    async () => textResult(OVERVIEW_PROMPT)
  );

  server.tool(
    "get_role_prompt",
    "取得「分析師 / 規格撰寫者 / 工程師 / 驗證師 / 測試工程師」其中一個角色的職責說明、可用工具、輸出格式。驅動 pipeline 的 AI 在切換角色前應該先呼叫這個工具讀懂該角色的說明。" +
      "**\"spec-writer\" 只有 sdMode 為 \"self-generated\" 的專案才需要**，其他 sdMode 分析師完成後直接取得 \"engineer\" 說明即可，不用呼叫 \"spec-writer\"。" +
      "**\"tester\" 是 \"verifier\" 判 PASS 之後、人類最終確認之前的新角色（每張票都會經過）**，負責依《測試工程師說明書》（\`get_test_engineer_guide\`）跑情境測試。",
    {
      role: z.enum(["analyst", "spec-writer", "engineer", "verifier", "tester"]).describe("要取得說明的角色"),
      projectDir: z
        .string()
        .nullable()
        .optional()
        .describe(
          `**一律帶上這個 Asana 專案的 projectDir**：如果 <projectDir>/${PROJECT_ROLE_ADDENDUM_DIR}/<role>.md 存在，內容會附加在通用角色說明後面，` +
            "是這個專案自己的補充規則（專案專屬的開發步驟、路徑慣例、驗證方式），衝突時以補充規則為準。沒有這個檔案就只回傳通用說明。"
        ),
    },
    async ({ role, projectDir }) => {
      const base = getRolePrompt(role);
      const addendum = projectDir ? await readProjectRoleAddendum(projectDir, role) : null;
      if (!addendum) return textResult(base);
      return textResult(
        `${base}\n\n---\n\n# 這個專案的補充規則（${PROJECT_ROLE_ADDENDUM_DIR}/${role}.md，與上面通用說明衝突時以這裡為準）\n\n${addendum}`
      );
    }
  );
}
