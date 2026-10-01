import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { OVERVIEW_PROMPT, getRolePrompt } from "./prompts.js";
import { COMMON_RULES_FILE_CANDIDATES, GATES_FILE_CANDIDATES, ROLE_FILE_CANDIDATES, readFirstExisting, resolveProjectDir } from "./project-rule-files.js";
import { textResult } from "./shared.js";

const ALL_ROLES = ["analyst", "spec-writer", "engineer", "verifier", "tester"] as const;

async function readRuleFile(projectDir: string, candidates: string[]): Promise<{ relPath: string; content: string } | null> {
  try {
    const found = await readFirstExisting(projectDir, candidates);
    return found && found.content.trim() ? found : null;
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
          "**一律帶上這個 Asana 專案的 projectDir**（或改帶 taskGid 讓工具自己反查）：如果 <projectDir>/.pipeline/roles/all.md（所有角色共通）或 <role>.md（這個角色專屬）存在（舊位置 .claude/pipeline-roles/ 也讀得到），" +
            "內容會附加在通用角色說明後面，是這個專案自己的規則（專案專屬的開發步驟、要先讀的規範檔、路徑慣例、驗證方式），衝突時以專案規則為準。沒有這些檔案就只回傳通用說明。"
        ),
      taskGid: z
        .string()
        .nullable()
        .optional()
        .describe("正在處理的票單 gid。沒帶 projectDir 時用這張票記錄的 project_dir 反查，避免漏帶 projectDir 導致專案補充規則被靜默略過。"),
    },
    async ({ role, projectDir, taskGid }) => {
      const base = getRolePrompt(role);
      const dir = await resolveProjectDir(projectDir, taskGid);
      if (!dir) return textResult(base);
      const common = await readRuleFile(dir, COMMON_RULES_FILE_CANDIDATES);
      const addendum = await readRuleFile(dir, ROLE_FILE_CANDIDATES(role));
      const sections = [base];
      if (common) sections.push(`# 這個專案的所有角色共通規則（${common.relPath}，與上面通用說明衝突時以這裡為準）\n\n${common.content}`);
      if (addendum) sections.push(`# 這個專案對「${role}」的補充規則（${addendum.relPath}，與上面通用說明衝突時以這裡為準）\n\n${addendum.content}`);
      return textResult(sections.join("\n\n---\n\n"));
    }
  );

  server.tool(
    "get_project_rules",
    "取得這個專案自己定義的開發規則（共通規則＋各角色補充規則的清單＋分析關卡是否存在）。**不走 Asana 票單流程、單純要在這個專案寫或改程式碼時，開始前也先呼叫這個**，才知道專案要求先讀哪些規範檔；" +
      "走票單流程時，這些規則已經由 get_role_prompt 自動附上，不用另外呼叫。projectDir 與 taskGid 擇一帶即可，沒有專案規則檔時會明確回報「沒有」。",
    {
      projectDir: z.string().nullable().optional().describe("專案目錄的絕對路徑"),
      taskGid: z.string().nullable().optional().describe("沒帶 projectDir 時，用這張票記錄的 project_dir 反查"),
    },
    async ({ projectDir, taskGid }) => {
      const dir = await resolveProjectDir(projectDir, taskGid);
      if (!dir) {
        return textResult({ success: false, message: "請帶 projectDir，或帶已經處理過（記錄過 project_dir）的 taskGid。" }, true);
      }
      const common = await readRuleFile(dir, COMMON_RULES_FILE_CANDIDATES);
      const roleFiles: string[] = [];
      for (const role of ALL_ROLES) {
        const found = await readRuleFile(dir, ROLE_FILE_CANDIDATES(role));
        if (found) roleFiles.push(found.relPath);
      }
      const gates = await readRuleFile(dir, GATES_FILE_CANDIDATES);
      return textResult({
        success: true,
        projectDir: dir,
        commonRules: common ? { file: common.relPath, content: common.content } : null,
        roleRuleFiles: roleFiles,
        analysisGatesFile: gates?.relPath ?? null,
        note: common || roleFiles.length || gates ? undefined : "這個專案沒有定義任何專案規則檔，依通用慣例進行即可。",
      });
    }
  );
}
