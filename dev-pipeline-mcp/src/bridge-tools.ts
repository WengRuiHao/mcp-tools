import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import path from "node:path";
import { callAsanaTool, callSvnTool } from "./mcp-clients.js";
import { getRecentCommits, isGitRepoRoot } from "./git-utils.js";
import { textResult } from "./shared.js";

/**
 * 這裡集中放「純轉發呼叫給兄弟 MCP 子行程」的工具（svn-mcp / asana-mcp），
 * 讓驅動 pipeline 的 AI 不用另外接這幾個 MCP 的連線。之後要新增其他「轉發給兄弟 MCP」的工具，
 * 加在這個檔案就好，不用散落到別的分類檔案裡。
 */
export function registerBridgeTools(server: McpServer): void {
  server.tool(
    "svn_list_connections",
    "【唯讀】列出 svn-mcp 所有 SVN 連線（每個 repo 一筆：id/name/url/aliases/nickname/starred/folders，不含帳密）。" +
      "**知道專案名稱時改用 svn_find_repo**；不確定有哪些專案或找不到時才用本工具列完整清單。",
    {},
    async () => {
      const result = await callSvnTool("svn_list_connections", {});
      return textResult(result, result?.success === false);
    }
  );

  server.tool(
    "svn_find_repo",
    "【唯讀】依關鍵字找 SVN 專案庫（repo），回答「這個專案在哪個連線、規格大概在哪個目錄」。" +
      "比對 repo 名稱、舊名稱、簡稱，以及常用目錄的暱稱與路徑（如「後端規格」）；" +
      "多個關鍵字用空白隔開、須全部符合；留空＝列出常用專案（星星在前、其次最近開過的）。" +
      "回傳每個專案的 connectionId（填給 svn_browse／svn_cat／svn_test_connection／sasd_config 的 svnConnectionId）與常用目錄（folders[].path 可當 path 或 saRoot／sdRoot 起點）。" +
      "**使用者提到專案名稱、或要找規格存放位置時，先呼叫這個，不要自己猜連線或路徑。**",
    {
      query: z.string().describe("關鍵字（repo 名稱、簡稱、舊名稱、常用目錄暱稱的全部或一部分），空白隔開；留空列常用專案"),
      limit: z.number().int().min(1).max(50).default(10).describe("最多回傳幾個專案，預設 10"),
    },
    async ({ query, limit }) => {
      const result = await callSvnTool("svn_find_repo", { query, limit });
      return textResult(result, result?.success === false);
    }
  );

  server.tool(
    "svn_test_connection",
    "【唯讀】實際測試 SVN 連線能否連上（svn info）。**硬性把關**：sasd_config register 在 external/self 時會自動呼叫，連不上直接拒絕登記。",
    { connectionId: z.string().describe("svn_find_repo／svn_list_connections 回傳的 connectionId、id 或 name") },
    async ({ connectionId }) => {
      const result = await callSvnTool("svn_test_connection", { connectionId });
      return textResult(result, result?.success === false);
    }
  );

  server.tool(
    "svn_browse",
    "【唯讀】瀏覽 SVN 路徑下的檔案/子目錄，用來在 SA/SD 規格位置找與票相關的規格文件。",
    { path: z.string().default("").describe("要瀏覽的 SVN 路徑（相對 repo 根）"), connectionId: z.string().nullable().optional().describe("連線 id 或 name（svn_list_connections）") },
    async ({ path, connectionId }) => {
      const result = await callSvnTool("svn_browse", { path, connectionId: connectionId ?? undefined });
      return textResult(result, result?.success === false);
    }
  );

  server.tool(
    "svn_cat",
    "【唯讀】讀取 SVN 檔案內容（純文字直接回傳；docx/xlsx/pdf 等二進位寫入本機暫存檔並回傳 tempFilePath，改用專案既有流程處理）。",
    {
      path: z.string().describe("SVN 檔案路徑（相對 repo 根）"),
      rev: z.string().default("HEAD").describe("版本號，預設 HEAD"),
      connectionId: z.string().nullable().optional().describe("連線 id 或 name（svn_list_connections）"),
    },
    async ({ path, rev, connectionId }) => {
      const result = await callSvnTool("svn_cat", { path, rev, connectionId: connectionId ?? undefined });
      return textResult(result, result?.success === false);
    }
  );

  server.tool(
    "svn_doc_images",
    "【唯讀】把 SVN 上的 Word/Excel 寫入本機暫存檔並回傳 tempFilePath——圖片抽取用專案既有的 python-docx 流程。讀取 docx 規格時務必一起呼叫，流程圖/畫面設計常只在圖片裡。",
    {
      path: z.string().describe("docx 檔案在 SVN 上的路徑（相對 repo 根）"),
      rev: z.string().default("HEAD").describe("版本號，預設 HEAD"),
      connectionId: z.string().nullable().optional().describe("連線 id 或 name（svn_list_connections）"),
    },
    async ({ path, rev, connectionId }) => {
      const result = await callSvnTool("svn_doc_images", { path, rev, connectionId: connectionId ?? undefined });
      return textResult(result, result?.success === false);
    }
  );

  server.tool(
    "svn_log",
    "【唯讀】查詢某個 SVN 路徑的修訂記錄。",
    {
      path: z.string().describe("SVN 路徑（相對 repo 根）"),
      limit: z.number().int().positive().max(200).default(30),
      connectionId: z.string().nullable().optional().describe("連線 id 或 name（svn_list_connections）"),
    },
    async ({ path, limit, connectionId }) => {
      const result = await callSvnTool("svn_log", { path, limit, connectionId: connectionId ?? undefined });
      return textResult(result, result?.success === false);
    }
  );

  server.tool(
    "svn_diff",
    "【唯讀】比較某個 SVN 路徑在兩個版本之間的差異。",
    {
      path: z.string().describe("SVN 路徑（相對 repo 根）"),
      r1: z.string().describe("舊版本號"),
      r2: z.string().describe("新版本號"),
      connectionId: z.string().nullable().optional().describe("連線 id 或 name（svn_list_connections）"),
    },
    async ({ path, r1, r2, connectionId }) => {
      const result = await callSvnTool("svn_diff", { path, r1, r2, connectionId: connectionId ?? undefined });
      return textResult(result, result?.success === false);
    }
  );

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
