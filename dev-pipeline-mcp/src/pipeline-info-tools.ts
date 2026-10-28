import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getRolePrompt, type RoleName } from "./prompts.js";
import { OVERVIEW_SECTIONS, getOverview } from "./overview-prompts.js";
import { COMMON_RULES_FILE_CANDIDATES, GATES_FILE_CANDIDATES, ROLE_FILE_CANDIDATES, readFirstExisting, resolveProjectDir } from "./project-rule-files.js";
import { bridgeDisabledNote } from "./toolset-config.js";
import { textResult } from "./shared.js";
import { resolveSasdConfig, resolveTestCapability, resolveUniformTestCapabilityMode } from "./project-registry.js";
import { getAssignedDir, peekStatus } from "./pipeline-store.js";
import { computeNextAction } from "./next-action.js";
import { buildSubagentBrief } from "./subagent-brief.js";
import path from "node:path";

const ALL_ROLES = ["analyst", "spec-writer", "engineer", "verifier", "tester"] as const;

async function readRuleFile(projectDir: string, candidates: string[]): Promise<{ relPath: string; content: string } | null> {
  try {
    const found = await readFirstExisting(projectDir, candidates);
    return found && found.content.trim() ? found : null;
  } catch {
    return null;
  }
}

async function buildBriefForTicket(
  role: RoleName,
  taskGid: string | null | undefined,
  projectDirParam: string | null | undefined
): Promise<string | { success: false; message: string }> {
  if (!taskGid) return { success: false, message: "forSubagent 需要帶 taskGid，才能自動帶入票單資訊。" };
  const ticketDir = await getAssignedDir(taskGid);
  if (!ticketDir) {
    return { success: false, message: `查不到 taskGid ${taskGid} 的票單追蹤紀錄；請先對這張票呼叫 get_ticket_snapshot，或確認 taskGid 正確。` };
  }
  const status = await peekStatus(taskGid);
  const sasd = status.project_gid ? await resolveSasdConfig(status.project_gid) : null;
  const next = computeNextAction(status, { sasd: sasd ? { sdMode: sasd.sdMode, specOrder: sasd.specOrder ?? null } : null });
  return buildSubagentBrief({
    role,
    taskGid,
    ticketNumber: path.basename(ticketDir),
    projectName: status.project_name,
    projectGid: status.project_gid,
    projectDir: projectDirParam || status.project_dir,
    stage: status.stage,
    verdict: status.verdict,
    sdMode: sasd?.sdMode ?? null,
    specOrder: sasd?.sdMode === "self-generated" ? (sasd.specOrder ?? null) : null,
    nextActionSummary: next.summary,
    blockedBy: next.blockedBy,
  });
}

export function registerPipelineInfoTools(server: McpServer): void {
  server.tool(
    "get_pipeline_overview",
    "票單 pipeline 的流程說明；驅動這條 pipeline 的 AI 第一步先呼叫（預設核心）。section 取其他章節：setup、appendix-a（子任務派工）、appendix-b、appendix-c、all。子代理人不必呼叫。",
    {
      section: z
        .enum(OVERVIEW_SECTIONS)
        .optional()
        .describe("要取得的章節，預設 core（硬性規則＋主流程＋安全限制）；all 回傳全部章節。"),
    },
    async ({ section }) => {
      const note = bridgeDisabledNote();
      const overview = getOverview(section ?? "core");
      return textResult(note ? `${overview}\n\n${note}` : overview);
    }
  );

  server.tool(
    "get_role_prompt",
    "取得角色（analyst／spec-writer／engineer／verifier／tester）的職責、工具與輸出格式，末端附一次載入工具的 ToolSearch 查詢；切換角色前先呼叫，並帶 projectDir 或 taskGid 以附上專案補充規則。" +
      "派給子代理人時帶 taskGid＋forSubagent:true，會在最前面加上派工簡報（票單資訊、寫入目標、環境陷阱、回報格式），整段當子代理人 prompt。spec-writer 只用於 sdMode 為 self-generated 的專案。",
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
      forSubagent: z
        .boolean()
        .optional()
        .describe("true（需帶 taskGid）：在角色說明前附上派工簡報，內容由票單狀態自動帶入。查不到票單時回傳 success:false。"),
    },
    async ({ role, projectDir, taskGid, forSubagent }) => {
      let brief: string | null = null;
      if (forSubagent) {
        const built = await buildBriefForTicket(role, taskGid, projectDir);
        if (typeof built !== "string") return textResult(built, true);
        brief = built;
      }
      const dir = await resolveProjectDir(projectDir, taskGid);
      // 票單有記錄 project_gid 時用它精準查專案設定；沒有就退回 projectDir 反查。查不到一律維持完整說明，不誤省略。
      const projectGid = taskGid ? (await peekStatus(taskGid)).project_gid : null;
      const sasd = projectGid ? await resolveSasdConfig(projectGid) : null;
      const testCapabilityMode =
        role !== "engineer"
          ? null
          : projectGid
            ? ((await resolveTestCapability(projectGid))?.mode ?? null)
            : dir
              ? await resolveUniformTestCapabilityMode(dir)
              : null;
      const base = getRolePrompt(role, { testCapabilityMode, sdMode: sasd?.sdMode ?? null, specOrder: sasd?.specOrder ?? null });
      const note = bridgeDisabledNote();
      const sections = brief ? [brief, base] : [base];
      if (dir) {
        const common = await readRuleFile(dir, COMMON_RULES_FILE_CANDIDATES);
        const addendum = await readRuleFile(dir, ROLE_FILE_CANDIDATES(role));
        if (common) sections.push(`# 這個專案的所有角色共通規則（${common.relPath}，與上面通用說明衝突時以這裡為準）\n\n${common.content}`);
        if (addendum) sections.push(`# 這個專案對「${role}」的補充規則（${addendum.relPath}，與上面通用說明衝突時以這裡為準）\n\n${addendum.content}`);
      }
      if (note) sections.push(note);
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
