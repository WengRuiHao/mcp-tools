import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import path from "node:path";
import { stat } from "node:fs/promises";
import { getGitTopLevel, isFileTracked } from "./git.js";
import { lookupGitDir } from "./config-store.js";
import { jsonResult } from "./shared.js";

export function registerSpecLoadingTools(server: McpServer): void {
  server.tool(
    "load_spec",
    "判斷規格檔案類型（.docx / .md），並針對 .md 檔案解析對應的 git 版控目錄狀態。" +
      "docx 類型不需要版控檢查，md 類型會回報是否已被 git 追蹤，" +
      "若未追蹤則檢查是否已登記對應的版控目錄，都沒有的話回報需要詢問使用者。",
    {
      specPath: z.string().describe("規格檔案的絕對或相對路徑"),
    },
    async ({ specPath }) => {
      const absPath = path.resolve(specPath);
      const ext = path.extname(absPath).toLowerCase();

      try {
        await stat(absPath);
      } catch {
        return jsonResult({ error: `找不到檔案: ${absPath}` }, true);
      }

      if (ext === ".docx") {
        return jsonResult({
          fileType: "docx",
          specPath: absPath,
          needsGitCheck: false,
          instruction:
            "請先使用 word 轉 md 的工具（markitdown）將此檔案轉換為 Markdown 內容，" +
            "轉換完成後不需要執行 git 版控檢查，直接將內容交給分析師角色繼續後續流程。",
        });
      }

      if (ext !== ".md" && ext !== ".markdown") {
        return jsonResult(
          { error: `不支援的檔案類型: ${ext}，僅支援 .docx 與 .md` },
          true
        );
      }

      const specDir = path.dirname(absPath);
      let tracked: boolean;
      try {
        tracked = await isFileTracked(absPath);
      } catch (err: any) {
        return jsonResult({ error: `檢查 git 追蹤狀態失敗: ${err.message}` }, true);
      }

      if (tracked) {
        const gitDir = await getGitTopLevel(specDir);
        return jsonResult({
          fileType: "md",
          specPath: absPath,
          needsGitCheck: true,
          gitTracked: true,
          gitDir,
          instruction: "此規格目錄已被 git 追蹤，可直接呼叫 get_recent_commits 取得最新 commit 記錄。",
        });
      }

      const registeredGitDir = await lookupGitDir(specDir);
      if (registeredGitDir) {
        return jsonResult({
          fileType: "md",
          specPath: absPath,
          needsGitCheck: true,
          gitTracked: false,
          registeredGitDir,
          instruction: "此規格目錄本身未被 git 追蹤，但已登記對應的版控目錄，可用 registeredGitDir 呼叫 get_recent_commits。",
        });
      }

      return jsonResult({
        fileType: "md",
        specPath: absPath,
        specDir,
        needsGitCheck: true,
        gitTracked: false,
        registeredGitDir: null,
        needsUserInput: true,
        instruction:
          "此規格目錄未被 git 追蹤，也尚未登記對應的版控目錄。" +
          "請詢問使用者這份規格對應的 git 版控目錄在哪裡，取得回答後呼叫 register_git_dir 登記。",
      });
    }
  );
}
