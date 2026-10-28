import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fsReadFile, fsWriteFile, fsReplaceInFile, fsListDir, fsSearchText, SEARCH_LIMITS, PathEscapeError } from "./fs-tools.js";
import { runShell, isGitCommand, hasLeadingDirectoryChange } from "./shell-tools.js";
import { resolveGitRoots } from "./git-roots-store.js";
import { textResult } from "./shared.js";
import { sliceFileContent } from "./output-limit.js";

function fsErrorResult(e: unknown) {
  if (e instanceof PathEscapeError) return textResult({ success: false, message: e.message }, true);
  return textResult({ success: false, message: e instanceof Error ? e.message : String(e) }, true);
}

const WHY_PREFIX = "相較內建 Read/Edit/Grep/Bash，";

function blockedWriteResult(outcome: { currentContent: string; lastWrittenAt: string; backupPath: string | null }) {
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

const REPLACE_FAIL_MESSAGES: Record<string, (n: number) => string> = {
  not_found: () => "mode:replace 失敗：檔案中找不到 oldString，未寫入。請先重新讀取檔案確認現有內容。換行已自動配合檔案（CRLF/LF）正規化後仍找不到，請檢查縮排與空白（空格/Tab）是否完全一致。",
  multiple_matches: (n) => `mode:replace 失敗：oldString 在檔案中出現 ${n} 次，必須唯一匹配，未寫入。請在 oldString 加入更多前後文使其唯一。`,
  file_missing: () => "mode:replace 失敗：檔案不存在（replace 只能改既有檔案；要建立新檔請用預設的整份覆寫）。",
  empty_old: () => "mode:replace 失敗：oldString 不可為空字串。",
};

export function registerProjectFsTools(server: McpServer): void {
  server.tool(
    "read_project_file",
    "讀取專案目錄下的檔案，路徑限制在 projectDir 內。" +
      WHY_PREFIX + "用這個才有外部修改偵測（externally_modified_since_last_write 示警）。" +
      "可用 startLine/endLine 讀部分行；沒指定且超過 40000 字會截斷並回傳 truncated: true——被截斷時不可據此整份覆寫檔案，要先讀完整內容。" +
      "檔案自本 MCP 上次寫入後被外部改過，會附 externally_modified_since_last_write: true 與 lastWrittenAt（只示警、不阻擋讀取），改之前先確認版本。",
    {
      projectDir: z.string().describe("專案目錄絕對路徑"),
      path: z.string().describe("相對於 projectDir 的檔案路徑"),
      startLine: z.number().optional().describe("起始行（1 起算、含）"),
      endLine: z.number().optional().describe("結束行（1 起算、含）"),
    },
    async ({ projectDir, path: relPath, startLine, endLine }) => {
      try {
        const { content, externallyModifiedSinceLastWrite, lastWrittenAt } = await fsReadFile(projectDir, relPath);
        const sliced = sliceFileContent(content, { startLine, endLine });
        if (!sliced.ok) return textResult({ success: false, message: sliced.message }, true);
        const rangeInfo =
          sliced.ranged || sliced.truncated
            ? { startLine: sliced.startLine, endLine: sliced.endLine, totalLines: sliced.totalLines }
            : {};
        const truncInfo = sliced.truncated
          ? {
              truncated: true,
              totalChars: sliced.totalChars,
              returnedLines: sliced.returnedLines,
              truncatedNote: `內容已被截斷（共 ${sliced.totalLines} 行、${sliced.totalChars} 字，這次只回傳第 ${sliced.startLine}-${sliced.endLine} 行）。請用 startLine/endLine 取其餘部分；不要據此整份覆寫檔案。`,
            }
          : {};
        return textResult({
          success: true,
          content: sliced.content,
          ...rangeInfo,
          ...truncInfo,
          ...(externallyModifiedSinceLastWrite ? { externally_modified_since_last_write: true, lastWrittenAt } : {}),
        });
      } catch (e) {
        return fsErrorResult(e);
      }
    }
  );

  server.tool(
    "write_project_file",
    "覆寫（或建立）專案目錄下相對路徑檔案的完整內容，路徑限制在 projectDir 內。" +
      WHY_PREFIX + "用這個才有外部修改偵測。" +
      "小改動用 mode:\"replace\" 帶 oldString/newString：oldString 須唯一匹配，找不到或多處匹配回錯誤且不寫入（檔案須已存在）；不帶 mode 是整份覆寫。replace 換行自動配合檔案（CRLF/LF）。" +
      "**檔案自本 MCP 上次寫入後若被外部改過，預設擋下寫入**，回傳 externally_modified: true、currentContent 與備份路徑；確定要覆蓋再呼叫一次並加 acknowledgeExternalChange: true（被蓋掉的內容仍會備份）。第一次寫某路徑不比對。",
    {
      projectDir: z.string().describe("專案目錄絕對路徑"),
      path: z.string().describe("相對於 projectDir 的檔案路徑"),
      content: z.string().optional().describe("檔案完整新內容（整份覆寫，非附加）；overwrite 時必填"),
      mode: z.enum(["overwrite", "replace"]).optional().describe("overwrite（預設）整份覆寫；replace 以 oldString/newString 唯一匹配局部替換"),
      oldString: z.string().optional().describe("replace：被替換的原文，須恰好出現一次"),
      newString: z.string().optional().describe("replace：替換後內容"),
      taskGid: z.string().nullable().optional().describe("關聯的 Asana 任務 gid（僅記錄，不影響行為）"),
      acknowledgeExternalChange: z.boolean().optional().describe("偵測到外部修改且確認要覆蓋時才帶 true"),
    },
    async ({ projectDir, path: relPath, content, mode, oldString, newString, taskGid, acknowledgeExternalChange }) => {
      try {
        const opts = { taskGid, acknowledgeExternalChange };
        if (mode === "replace") {
          if (oldString === undefined || newString === undefined) {
            return textResult({ success: false, message: "mode:replace 需要同時提供 oldString 與 newString。" }, true);
          }
          const r = await fsReplaceInFile(projectDir, relPath, oldString, newString, opts);
          if ("replaced" in r) return textResult({ success: false, message: REPLACE_FAIL_MESSAGES[r.reason](r.matchCount), matchCount: r.matchCount }, true);
          if (r.blocked) return blockedWriteResult(r);
          return textResult({ success: true, path: relPath, mode: "replace" });
        }
        if (content === undefined) {
          return textResult({ success: false, message: "整份覆寫需要提供 content（或改用 mode:replace 搭配 oldString/newString）。" }, true);
        }
        const outcome = await fsWriteFile(projectDir, relPath, content, opts);
        if (outcome.blocked) return blockedWriteResult(outcome);
        return textResult({ success: true, path: relPath });
      } catch (e) {
        return fsErrorResult(e);
      }
    }
  );

  server.tool(
    "list_project_dir",
    "列出專案目錄下相對路徑的檔案與子目錄（不含 node_modules/.git）。" + WHY_PREFIX + "路徑受 projectDir 沙箱限制（含 symlink 逃逸檢查），回應附跨 worktree 檔案重疊示警（activeWarnings）。",
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
    "在專案原始碼搜尋字串或正規表示式（類似 grep，不分大小寫）。" +
      `只搜這些副檔名：${SEARCH_LIMITS.extensions.join(" ")}；略過目錄：${SEARCH_LIMITS.skipDirs.join("/")}；最多 ${SEARCH_LIMITS.maxMatches} 筆、${SEARCH_LIMITS.maxFiles} 個檔案、${SEARCH_LIMITS.timeBudgetMs}ms 時間預算。` +
      "超限時回傳 truncated/timedOut/limit/note，truncated:true 不代表結果是全部；可用 path（子目錄）或 fileExtensions 縮小範圍。" +
      WHY_PREFIX + "用這個受 projectDir 沙箱限制，正規表示式有長度與巢狀量詞防護。",
    {
      projectDir: z.string().describe("專案目錄絕對路徑"),
      pattern: z.string().describe("要搜尋的字串或正規表示式"),
      useRegex: z.boolean().default(false).describe("pattern 是否當作正規表示式解析"),
      path: z.string().optional().describe("只搜這個子目錄（相對 projectDir）"),
      fileExtensions: z.array(z.string()).optional().describe("只搜這些副檔名（不含點，如 [\"ts\",\"tsx\"]）；沒帶用預設白名單"),
    },
    async ({ projectDir, pattern, useRegex, path: searchPath, fileExtensions }) => {
      try {
        const result = await fsSearchText(projectDir, pattern, useRegex, { path: searchPath, fileExtensions });
        return textResult({ success: true, ...result });
      } catch (e) {
        return fsErrorResult(e);
      }
    }
  );

  server.tool(
    "run_project_shell",
    "在專案目錄下執行 shell 指令（編譯、跑測試、git diff/status/add/commit 等）。" +
      WHY_PREFIX + "用這個才有 git 根目錄驗證與危險指令封鎖。" +
      "禁止 git push、--force/-f、reset --hard、clean、checkout --/checkout .、restore、branch -D 這類推到遠端或強制覆蓋/丟棄內容的指令，會被拒絕。" +
      "**git 指令會先驗證**：專案必須已登記 git_roots，且指令實際的 repo root（`git rev-parse --show-toplevel`）要與登記一致，否則拒絕。輸出過長會截斷（truncated/originalChars）。" +
      "環境是 Windows PowerShell 5.1（-NoProfile）：不支援 && / ||，用 `;` 串接；原生指令別用 `2>&1`（會讓 $? 為 false）；輸出很長請導到檔案再讀；無 BOM 的 .ps1 內中文會亂碼，改用 UTF-8 資料檔由 .NET 讀取或存成含 BOM。" +
      "git 指令以 `Set-Location <目錄>;` 開頭（驗證只看最開頭的目錄切換）。" +
      "預設逾時 60000 ms，可用 timeoutMs 調高（上限 600000）；失敗（非零結束碼/逾時/輸出過大）回傳已收集的 stdout/stderr 與 exitCode，逾時另帶 timedOut:true。",
    {
      projectDir: z.string().describe("專案目錄絕對路徑"),
      command: z.string().describe("要執行的 shell 指令"),
      timeoutMs: z.number().int().min(1).max(600000).optional().describe("逾時毫秒數，預設 60000，上限 600000"),
    },
    async ({ projectDir, command, timeoutMs }) => {
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
      const result = await runShell(execCwd, command, gitRoots, timeoutMs);
      return textResult(result, result.blocked === true);
    }
  );
}
