import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getTemplatesDir } from "./config-store.js";
import { fsReadFile, fsWriteFile } from "./fs-tools.js";
import { resolveSasdConfig } from "./project-registry.js";
import { textResult } from "./shared.js";

export function registerSdDocTools(server: McpServer): void {
  server.tool(
    "read_project_sd_doc",
    "讀取某個 Asana 專案自己維護的 SD 規格文件內容（只適用於 sdMode 是 \"self-generated\" 的專案）。從 register_sasd_config 登記的 sdOutputPath（真實本機檔案）讀取。第一次讀取如果還沒建立過，會回傳空字串。",
    { projectGid: z.string().describe("Asana 專案 gid"), projectDir: z.string().describe("這個 Asana 專案對應的程式碼專案目錄絕對路徑") },
    async ({ projectGid, projectDir }) => {
      const config = await resolveSasdConfig(projectGid);
      if (!config?.sdOutputPath) {
        return textResult(
          { success: false, message: "這個專案還沒登記 sdOutputPath——請先呼叫 register_sasd_config 補上 AI 產出 SD 規格要寫入的本機路徑（要先問使用者）。" },
          true
        );
      }
      try {
        const { content } = await fsReadFile(projectDir, config.sdOutputPath);
        return textResult({ success: true, content, sdOutputPath: config.sdOutputPath });
      } catch {
        return textResult({ success: true, content: "", sdOutputPath: config.sdOutputPath });
      }
    }
  );

  server.tool(
    "write_project_sd_doc",
    "覆寫某個 Asana 專案自己維護的 SD 規格文件內容（只適用於 sdMode 是 \"self-generated\" 的專案）。寫入 register_sasd_config 登記的 sdOutputPath（projectDir 底下的真實本機檔案，不是藏在這個 MCP 自己的安裝目錄裡），使用者可以直接把這個檔案傳到 SVN。" +
      "**呼叫這個工具之前，一定要先呼叫 get_sd_spec_template（文件是空的／第一次建立時）或 get_sd_spec_versioning_rules（文件已有內容／這次是修改既有版本時），依照裡面的規則產生內容，不要憑自己的格式直接寫。**" +
      "如果這份文件自從上次這個 MCP 寫入之後被外部改過（例如使用者手動編輯），會被擋下，回傳 externally_modified: true；確認要覆蓋就加上 acknowledgeExternalChange: true。",
    {
      projectGid: z.string().describe("Asana 專案 gid"),
      projectDir: z.string().describe("這個 Asana 專案對應的程式碼專案目錄絕對路徑"),
      content: z.string().describe("SD 規格文件的完整新內容"),
      acknowledgeExternalChange: z.boolean().optional().describe("這份文件被外部改過、確認要用這次的內容覆蓋掉時才需要帶 true"),
    },
    async ({ projectGid, projectDir, content, acknowledgeExternalChange }) => {
      const config = await resolveSasdConfig(projectGid);
      if (!config?.sdOutputPath) {
        return textResult(
          { success: false, message: "這個專案還沒登記 sdOutputPath——請先問使用者「AI 產出的 SD 規格要放在本機哪個目錄/檔案」，再呼叫 register_sasd_config 補上，才能寫入。" },
          true
        );
      }
      const outcome = await fsWriteFile(projectDir, config.sdOutputPath, content, { acknowledgeExternalChange });
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
      return textResult({ success: true, projectGid, sdOutputPath: config.sdOutputPath });
    }
  );

  server.tool(
    "get_sd_spec_template",
    "取得 SD 規格書撰寫範本（新建規格用）：撰寫原則＋可直接複製修改的檔案骨架＋Exception/TableSchema 共用子文件骨架。" +
      "sdMode 是 \"self-generated\" 且 read_project_sd_doc 回傳空字串（代表這個專案還沒建立過自維護 SD 文件）時，" +
      "在第一次呼叫 write_project_sd_doc 之前，一定要先呼叫這個工具，照裡面的骨架與規則產生內容。" +
      "這份範本目前預設沿用一份既有客戶專案的規格書撰寫慣例（版本管控歷程表格、程式代號/API說明章節結構、" +
      "巢狀 JSON 多行縮排、純 markdown 表格不用內嵌 HTML 等），套用到其他專案的票單時也一律用同一套慣例。",
    {},
    async () => {
      const content = await readFile(path.join(getTemplatesDir(), "SD_TEMPLATE.md"), "utf8");
      return textResult(content);
    }
  );

  server.tool(
    "get_sd_spec_versioning_rules",
    "取得 SD 規格書維護與版更規範（編輯既有規格用）：版次怎麼遞增、修訂說明怎麼寫、<mark>標記規則、" +
      "TableSchema 子文件版號什麼時候才要跟著動。" +
      "sdMode 是 \"self-generated\" 且 read_project_sd_doc 讀到既有內容（代表這次是修改，不是第一次建立）時，" +
      "在呼叫 write_project_sd_doc 更新內容之前，一定要先呼叫這個工具確認版更規則，不要自己憑感覺加版號或標記異動。",
    {},
    async () => {
      const content = await readFile(path.join(getTemplatesDir(), "SD_VERSIONING_RULES.md"), "utf8");
      return textResult(content);
    }
  );
}
