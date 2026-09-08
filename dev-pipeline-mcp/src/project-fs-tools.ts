import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fsReadFile, fsWriteFile, fsListDir, fsSearchText, PathEscapeError } from "./fs-tools.js";
import { runShell, isGitCommand, hasLeadingDirectoryChange } from "./shell-tools.js";
import { resolveGitRoots } from "./git-roots-store.js";
import { textResult } from "./shared.js";

function fsErrorResult(e: unknown) {
  if (e instanceof PathEscapeError) return textResult({ success: false, message: e.message }, true);
  return textResult({ success: false, message: e instanceof Error ? e.message : String(e) }, true);
}

export function registerProjectFsTools(server: McpServer): void {
  server.tool(
    "read_project_file",
    "讀取指定專案目錄底下某個相對路徑檔案的完整內容。路徑一律限制在 projectDir 範圍內。" +
      "如果這個檔案自從這個 MCP 上次寫入之後，被外部工具/使用者手動編輯/別的 AI 改過，回傳裡會附上 externally_modified_since_last_write: true 跟 lastWrittenAt——" +
      "**這是提早示警，不會阻擋讀取**：代表你等一下要編輯的內容，已經不是你（或前一輪）上次認知的樣子了，動手改之前最好先確認清楚現在這份是不是你要的版本。",
    { projectDir: z.string().describe("專案目錄絕對路徑"), path: z.string().describe("相對於 projectDir 的檔案路徑") },
    async ({ projectDir, path: relPath }) => {
      try {
        const { content, externallyModifiedSinceLastWrite, lastWrittenAt } = await fsReadFile(projectDir, relPath);
        return textResult({
          success: true,
          content,
          ...(externallyModifiedSinceLastWrite ? { externally_modified_since_last_write: true, lastWrittenAt } : {}),
        });
      } catch (e) {
        return fsErrorResult(e);
      }
    }
  );

  server.tool(
    "write_project_file",
    "覆寫（或建立）指定專案目錄底下某個相對路徑檔案的完整內容。路徑一律限制在 projectDir 範圍內。" +
      "**如果這個檔案自從這個 MCP 上次寫入之後被外部改過（GUI 工具、使用者手動編輯、別的 AI……），預設會擋下這次寫入**，回傳 externally_modified: true、目前磁碟上的實際內容（currentContent）、以及一份自動備份的路徑。" +
      "先讀 currentContent 比對差異，確認要保留哪個版本；確定要用這次的內容覆蓋掉現有變更，再呼叫一次並加上 acknowledgeExternalChange: true（被蓋掉的內容一樣會先備份，不會真的遺失，但預設行為是不要在不知情的狀況下悄悄覆蓋）。" +
      "第一次寫某個路徑（這個 MCP 之前沒寫過）不會做這個比對，直接寫入。",
    {
      projectDir: z.string().describe("專案目錄絕對路徑"),
      path: z.string().describe("相對於 projectDir 的檔案路徑"),
      content: z.string().describe("檔案的完整新內容（整份覆寫，不是附加）"),
      taskGid: z.string().nullable().optional().describe("這次修改關聯的 Asana 任務 gid（有的話帶上，純粹記錄用，不影響行為）"),
      acknowledgeExternalChange: z.boolean().optional().describe("偵測到外部修改、確認要用這次內容覆蓋掉時才需要帶 true"),
    },
    async ({ projectDir, path: relPath, content, taskGid, acknowledgeExternalChange }) => {
      try {
        const outcome = await fsWriteFile(projectDir, relPath, content, { taskGid, acknowledgeExternalChange });
        if (outcome.blocked) {
          return textResult(
            {
              success: false,
              externally_modified: true,
              message:
                "這個檔案自從你（這個 MCP）上次寫入之後，已經被其他程式修改過（可能是設計工具或使用者手動編輯），為避免覆蓋掉別人的修改，這次寫入已經被擋下。" +
                "請先讀取目前實際內容比對差異，確認你要保留哪個版本；如果確定要用你這次的內容覆蓋掉現有變更，呼叫時加上 acknowledgeExternalChange: true。" +
                (outcome.backupPath ? `已將目前磁碟上的內容備份到：${outcome.backupPath}` : "（原檔案在磁碟上已經不存在，無法備份）"),
              currentContent: outcome.currentContent,
              lastWrittenAt: outcome.lastWrittenAt,
            },
            true
          );
        }
        return textResult({ success: true, path: relPath });
      } catch (e) {
        return fsErrorResult(e);
      }
    }
  );

  server.tool(
    "list_project_dir",
    "列出指定專案目錄底下某個相對路徑的檔案與子目錄（不含 node_modules/.git）。",
    { projectDir: z.string().describe("專案目錄絕對路徑"), path: z.string().default(".").describe("相對於 projectDir 的目錄路徑") },
    async ({ projectDir, path: relPath }) => {
      try {
        const entries = await fsListDir(projectDir, relPath);
        return textResult({ success: true, entries });
      } catch (e) {
        return fsErrorResult(e);
      }
    }
  );

  server.tool(
    "search_project_text",
    "在專案目錄底下的原始碼檔案裡搜尋字串或正規表示式（類似 grep），最多回傳 200 筆符合結果。",
    {
      projectDir: z.string().describe("專案目錄絕對路徑"),
      pattern: z.string().describe("要搜尋的字串或正規表示式"),
      useRegex: z.boolean().default(false).describe("pattern 是否當作正規表示式解析"),
    },
    async ({ projectDir, pattern, useRegex }) => {
      try {
        const matches = await fsSearchText(projectDir, pattern, useRegex);
        return textResult({ success: true, matches });
      } catch (e) {
        return fsErrorResult(e);
      }
    }
  );

  server.tool(
    "run_project_shell",
    "在指定專案目錄下執行一個 shell 指令（例如編譯、跑測試、git diff/status/add/commit）。" +
      "禁止 git push、--force/-f、reset --hard、clean、checkout --/checkout .、restore、branch -D 這類會推到遠端或強制覆蓋/丟棄內容的指令，違反會被拒絕執行。" +
      "**任何 git 指令執行前都會先驗證**：這個專案必須先呼叫過 register_git_roots 登記過 git 版控根目錄，而且指令實際解析到的 repo root（`git rev-parse --show-toplevel`）必須跟登記的根目錄對得起來，對不起來（例如子目錄底下根本沒有 .git、git 往上找到不相干的 repo）會直接拒絕執行——避免在沒有真正 git 版控的目錄裡誤跑 add/commit。",
    { projectDir: z.string().describe("專案目錄絕對路徑"), command: z.string().describe("要執行的 shell 指令") },
    async ({ projectDir, command }) => {
      const gitRoots = await resolveGitRoots(projectDir);
      // projectDir 常常不是 git root 本身（例如前後端分開、或 git root 在更深一層子目錄）。過去唯一的
      // 解法是要求呼叫端自己在 command 開頭寫 `cd <相對路徑>;`，一旦漏寫，git 指令會從 projectDir 往上
      // 層層尋找 .git，很容易誤連到不相干的祖先 repo（見 verifyGitRoot 的偵測），被擋下來但很難第一次
      //就猜到原因。只有唯一登記一個 git root、且呼叫端沒有自己下 cd/Set-Location 的情況下才能安全代勞
      // 自動決定——多個 git root（前後端分開）時無從得知這句 git 指令該對哪一個跑，仍然交由呼叫端自己
      // 用 cd 指定，維持原行為不變。
      const execCwd =
        gitRoots && gitRoots.length === 1 && isGitCommand(command) && !hasLeadingDirectoryChange(command)
          ? gitRoots[0].path
          : projectDir;
      const result = await runShell(execCwd, command, gitRoots);
      return textResult(result, result.blocked === true);
    }
  );
}
