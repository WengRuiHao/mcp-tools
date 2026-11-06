import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import path from "node:path";
import { callAsanaTool } from "./mcp-clients.js";
import { getRecentCommits, isGitRepoRoot } from "./git-utils.js";
import { textResult } from "./shared.js";

/**
 * 這裡集中放「純轉發給 asana-mcp 子行程」的工具與一個 git 唯讀查詢。
 * SVN 讀取（svn_browse／svn_cat／svn_doc_images／svn_log／svn_diff／svn_find_repo…）不在這裡：
 * 一律由驅動 pipeline 的 AI 直接連 svn-mcp 使用（本 MCP 內部驗證 SVN 連線仍透過 mcp-clients 的 callSvnTool）。
 */
export function registerBridgeTools(server: McpServer): void {
  server.tool(
    "get_ticket_activity",
    "【唯讀】取得票單在 Asana 的完整活動時間軸（留言＋系統事件＋附件，依時間排序）。" +
      "**使用者說「查看測試員回報的測試狀況」這類話時呼叫**：測試員已把問題寫進留言（可能附截圖/log），要讀懂並修好。" +
      "items.kind：comment（通常是測試員回報）、system_event、attachment（只有 metadata；相關時用 attachmentGid 呼叫 download_ticket_attachment，不要憑檔名猜）。" +
      "**修好、確認根因後要寫回追蹤系統**：票通常已 verified 且 PASS，呼叫 record_confirmation({ taskGid, confirmed: false, note: <回報摘要> }) 走 humanRejected 根因分流，不要另創口頭回報流程；票還沒到 verified 就有留言則以目前角色繼續，不必呼叫。",
    { taskGid: z.string().describe("任務 gid") },
    async ({ taskGid }) => {
      const result = await callAsanaTool("asana_task_activity", { taskGid });
      return textResult(result, result?.success === false);
    }
  );

  server.tool(
    "download_ticket_attachment",
    "【唯讀】下載附件到本機暫存檔並回傳 tempFilePath。" +
      "attachmentGid 來自 `get_ticket_activity`（kind:\"attachment\"）或 `asana_attachments`。" +
      "docx/xlsx/pdf 用專案既有檔案讀取流程處理，讀完清掉暫存目錄。",
    { attachmentGid: z.string().describe("附件 gid") },
    async ({ attachmentGid }) => {
      const result = await callAsanaTool("asana_download_attachment", { attachmentGid });
      return textResult(result, result?.success === false);
    }
  );

  server.tool(
    "get_recent_commits",
    "查詢目錄最近的 git commit 記錄，供分析師參考最新異動。",
    {
      gitDir: z.string().describe("git 版控目錄"),
      limit: z.number().int().positive().max(100).default(10).describe("commit 數量，預設 10"),
    },
    async ({ gitDir, limit }) => {
      const absGitDir = path.resolve(gitDir);
      if (!(await isGitRepoRoot(absGitDir))) {
        return textResult({ success: false, message: `提供的目錄不是有效的 git 版控目錄: ${absGitDir}` }, true);
      }
      try {
        const commits = await getRecentCommits(absGitDir, limit);
        return textResult({ success: true, gitDir: absGitDir, commits });
      } catch (err: any) {
        return textResult({ success: false, message: `讀取 commit 記錄失敗: ${err.message}` }, true);
      }
    }
  );
}
