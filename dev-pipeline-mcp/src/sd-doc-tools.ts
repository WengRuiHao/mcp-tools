import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getTemplatesDir } from "./config-store.js";
import { fsReadFile, fsWriteFile } from "./fs-tools.js";
import { resolveSasdConfig } from "./project-registry.js";
import { SD_TEMPLATE_CANDIDATES, SD_VERSIONING_CANDIDATES, readFirstExisting, resolveProjectDir } from "./project-rule-files.js";
import { textResult } from "./shared.js";

const FILE_NAME_PARAM_DESCRIPTION =
  "sdOutputPath 登記的是「目錄」（一支功能/報表一份規格檔）時必帶，例如 \"SPEC_a_report_28_預算科目餘額表.md\"，只能是檔名、不可含路徑分隔符號；" +
  "sdOutputPath 登記的是單一檔案時不要帶。";

/** sdOutputPath is a directory when a fileName is given (one SD file per feature/report); otherwise it is the single SD file itself. */
function resolveSdFilePath(sdOutputPath: string, fileName?: string | null): { path: string } | { error: string } {
  if (!fileName) return { path: sdOutputPath };
  if (fileName !== path.basename(fileName) || fileName.includes("/") || fileName.includes("\\") || fileName === "..") {
    return { error: `fileName "${fileName}" 只能是檔名，不可含路徑分隔符號或 ..` };
  }
  return { path: path.join(sdOutputPath, fileName) };
}

const PROJECT_RULES_PARAMS = {
  projectDir: z.string().nullable().optional().describe("專案目錄絕對路徑；帶了而且專案有自己的版本（.pipeline/templates/）就回傳專案版，否則回傳內建通用版。只會回傳其中一份，不會兩份都給"),
  taskGid: z.string().nullable().optional().describe("沒帶 projectDir 時，用這張票記錄的 project_dir 反查"),
};

/** Project's own copy replaces the built-in one entirely (never both), so the AI isn't handed two overlapping versions of the same rules. */
async function loadSdRules(params: { projectDir?: string | null; taskGid?: string | null }, candidates: string[], builtInFile: string): Promise<string> {
  const dir = await resolveProjectDir(params.projectDir, params.taskGid);
  if (dir) {
    try {
      const found = await readFirstExisting(dir, candidates);
      if (found && found.content.trim()) return found.content;
    } catch {
      // unreadable project copy: fall through to the built-in version
    }
  }
  return readFile(path.join(getTemplatesDir(), builtInFile), "utf8");
}

export function registerSdDocTools(server: McpServer): void {
  server.tool(
    "read_project_sd_doc",
    "讀取某個 Asana 專案自己維護的 SD 規格文件內容（只適用於 sdMode 是 \"self-generated\" 的專案）。從 register_sasd_config 登記的 sdOutputPath（真實本機檔案；登記的是目錄時搭配 fileName 讀目錄底下那一份）讀取。第一次讀取如果還沒建立過，會回傳空字串。",
    {
      projectGid: z.string().describe("Asana 專案 gid"),
      projectDir: z.string().describe("這個 Asana 專案對應的程式碼專案目錄絕對路徑"),
      fileName: z.string().nullable().optional().describe(FILE_NAME_PARAM_DESCRIPTION),
    },
    async ({ projectGid, projectDir, fileName }) => {
      const config = await resolveSasdConfig(projectGid);
      if (!config?.sdOutputPath) {
        return textResult(
          { success: false, message: "這個專案還沒登記 sdOutputPath——請先呼叫 register_sasd_config 補上 AI 產出 SD 規格要寫入的本機路徑（要先問使用者）。" },
          true
        );
      }
      const target = resolveSdFilePath(config.sdOutputPath, fileName);
      if ("error" in target) return textResult({ success: false, message: target.error }, true);
      try {
        const { content } = await fsReadFile(projectDir, target.path);
        return textResult({ success: true, content, sdOutputPath: target.path });
      } catch (err: any) {
        if (err?.code === "ENOENT") return textResult({ success: true, content: "", sdOutputPath: target.path });
        return textResult(
          {
            success: false,
            message: `讀取 SD 規格失敗（${err?.code ?? err?.message}）。如果 sdOutputPath 登記的是目錄，請帶 fileName 指定要讀哪一份。`,
          },
          true
        );
      }
    }
  );

  server.tool(
    "write_project_sd_doc",
    "覆寫 Asana 專案自維護的 SD 規格文件（只適用 sdMode \"self-generated\"），寫入 register_sasd_config 登記的 sdOutputPath（projectDir 底下的真實本機檔案，使用者可直接傳到 SVN）。" +
      "**呼叫前一定要先呼叫 get_sd_spec_template（文件為空／第一次建立）或 get_sd_spec_versioning_rules（文件已有內容／修改既有版本），照規則產生內容，不要自己決定格式。**" +
      "文件自上次本 MCP 寫入後若被外部改過會被擋下並回傳 externally_modified: true；確認要覆蓋再加 acknowledgeExternalChange: true。",
    {
      projectGid: z.string().describe("Asana 專案 gid"),
      projectDir: z.string().describe("這個 Asana 專案對應的程式碼專案目錄絕對路徑"),
      content: z.string().describe("SD 規格文件的完整新內容"),
      fileName: z.string().nullable().optional().describe(FILE_NAME_PARAM_DESCRIPTION),
      acknowledgeExternalChange: z.boolean().optional().describe("這份文件被外部改過、確認要用這次的內容覆蓋掉時才需要帶 true"),
    },
    async ({ projectGid, projectDir, content, fileName, acknowledgeExternalChange }) => {
      const config = await resolveSasdConfig(projectGid);
      if (!config?.sdOutputPath) {
        return textResult(
          { success: false, message: "這個專案還沒登記 sdOutputPath——請先問使用者「AI 產出的 SD 規格要放在本機哪個目錄/檔案」，再呼叫 register_sasd_config 補上，才能寫入。" },
          true
        );
      }
      const target = resolveSdFilePath(config.sdOutputPath, fileName);
      if ("error" in target) return textResult({ success: false, message: target.error }, true);
      const outcome = await fsWriteFile(projectDir, target.path, content, { acknowledgeExternalChange });
      if (outcome.blocked) {
        return textResult(
          {
            success: false,
            externally_modified: true,
            message:
              "這份 SD 規格文件自從上次這個 MCP 寫入之後，已經被其他方式修改過（例如使用者手動編輯）。為避免覆蓋掉別人的修改，這次寫入已經被擋下。" +
              "請先比對 currentContent 確認要保留哪個版本；確定要用這次的內容覆蓋，呼叫時加上 acknowledgeExternalChange: true。" +
              (outcome.backupPath ? `目前磁碟上的內容已備份到：${outcome.backupPath}` : ""),
            currentContent: outcome.currentContent,
            lastWrittenAt: outcome.lastWrittenAt,
          },
          true
        );
      }
      return textResult({ success: true, projectGid, sdOutputPath: target.path });
    }
  );

  server.tool(
    "get_sd_spec_template",
    "取得 SD 規格書撰寫範本（新建規格用）：撰寫原則＋檔案骨架＋Exception/TableSchema 共用子文件骨架。帶 projectDir/taskGid 時，專案在 .pipeline/templates/SD_TEMPLATE.md 有自己的版本就回傳專案版取代內建版。" +
      "sdMode 為 \"self-generated\" 且 read_project_sd_doc 回傳空字串時，第一次 write_project_sd_doc 之前一定要先呼叫這個。內建範本沿用一份既有客戶專案的撰寫慣例（版本管控歷程表格、程式代號/API 章節結構、巢狀 JSON 多行縮排、純 markdown 表格），其他專案也一律用同一套。",
    PROJECT_RULES_PARAMS,
    async (params) => textResult(await loadSdRules(params, SD_TEMPLATE_CANDIDATES, "SD_TEMPLATE.md"))
  );

  server.tool(
    "get_sd_spec_versioning_rules",
    "取得 SD 規格書維護與版更規範（編輯既有規格用）：版次遞增、修訂說明寫法、<mark>標記規則、TableSchema 子文件版號何時要跟著動。帶 projectDir/taskGid 時，專案在 .pipeline/templates/SD_VERSIONING_RULES.md 有自己的版本就回傳專案版取代內建版。" +
      "sdMode 為 \"self-generated\" 且 read_project_sd_doc 讀到既有內容時，write_project_sd_doc 更新前一定要先呼叫這個，不要自己加版號或標記異動。",
    PROJECT_RULES_PARAMS,
    async (params) => textResult(await loadSdRules(params, SD_VERSIONING_CANDIDATES, "SD_VERSIONING_RULES.md"))
  );
}
