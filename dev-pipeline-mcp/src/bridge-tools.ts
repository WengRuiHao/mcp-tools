import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callAsanaTool, callSpecPipelineTool, callSvnTool } from "./mcp-clients.js";
import { textResult } from "./shared.js";

/**
 * 這裡集中放「純轉發呼叫給兄弟 MCP 子行程」的工具（svn-mcp / asana-mcp / spec-pipeline-mcp），
 * 讓驅動 pipeline 的 AI 不用另外接這幾個 MCP 的連線。之後要新增其他「轉發給兄弟 MCP」的工具，
 * 加在這個檔案就好，不用散落到別的分類檔案裡。
 */
export function registerBridgeTools(server: McpServer): void {
  server.tool(
    "svn_list_connections",
    "【唯讀】列出 svn-mcp 登記的所有 SVN 連線（id/name/url，不含帳密）。登記某個 Asana 專案的 SA/SD 規格是 SVN 路徑之前，先呼叫這個確認可用的連線有哪些、該用哪一個。",
    {},
    async () => {
      const result = await callSvnTool("svn_list_connections", {});
      return textResult(result, result?.success === false);
    }
  );

  server.tool(
    "svn_test_connection",
    "【唯讀】實際測試某個 SVN 連線能不能連上（真的執行一次 svn info）。**這是硬性把關**：register_sasd_config 在 sdMode 是 external/self 時會自動呼叫這個驗證，連不上會直接拒絕註冊；也可以在那之前自己先呼叫確認。",
    { connectionId: z.string().describe("svn_list_connections 回傳的 id 或 name") },
    async ({ connectionId }) => {
      const result = await callSvnTool("svn_test_connection", { connectionId });
      return textResult(result, result?.success === false);
    }
  );

  server.tool(
    "svn_browse",
    "【唯讀】瀏覽 SVN 上某個路徑底下的檔案/子目錄清單，用來在 SA/SD 規格存放位置底下搜尋跟某張票相關的規格文件。",
    { path: z.string().default("").describe("要瀏覽的 SVN 路徑（相對於連線的 repo 根目錄）"), connectionId: z.string().nullable().optional().describe("svn_list_connections 回傳的 id 或 name") },
    async ({ path, connectionId }) => {
      const result = await callSvnTool("svn_browse", { path, connectionId: connectionId ?? undefined });
      return textResult(result, result?.success === false);
    }
  );

  server.tool(
    "svn_cat",
    "【唯讀】讀取 SVN 上某個檔案的內容（純文字直接回傳；docx/xlsx/pdf 等二進位格式會寫入本機暫存檔，回傳 tempFilePath，改用專案既有流程處理）。",
    {
      path: z.string().describe("SVN 檔案路徑（相對於連線的 repo 根目錄）"),
      rev: z.string().default("HEAD").describe("版本號，預設 HEAD"),
      connectionId: z.string().nullable().optional().describe("svn_list_connections 回傳的 id 或 name"),
    },
    async ({ path, rev, connectionId }) => {
      const result = await callSvnTool("svn_cat", { path, rev, connectionId: connectionId ?? undefined });
      return textResult(result, result?.success === false);
    }
  );

  server.tool(
    "svn_doc_images",
    "【唯讀】把 SVN 上的 Word/Excel 文件寫入本機暫存檔，回傳 tempFilePath——實際圖片抽取請用專案既有的 python-docx 流程處理。讀取 docx 規格文件時務必連這個一起呼叫，規格書的流程圖/畫面設計常常只在圖片裡。",
    {
      path: z.string().describe("docx 檔案在 SVN 上的路徑（相對於連線的 repo 根目錄）"),
      rev: z.string().default("HEAD").describe("版本號，預設 HEAD"),
      connectionId: z.string().nullable().optional().describe("svn_list_connections 回傳的 id 或 name"),
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
      path: z.string().describe("SVN 路徑（相對於連線的 repo 根目錄）"),
      limit: z.number().int().positive().max(200).default(30),
      connectionId: z.string().nullable().optional().describe("svn_list_connections 回傳的 id 或 name"),
    },
    async ({ path, limit, connectionId }) => {
      const result = await callSvnTool("svn_log", { path, limit, connectionId: connectionId ?? undefined });
      return textResult(result, result?.success === false);
    }
  );

  server.tool(
    "get_ticket_activity",
    "【唯讀】取得某張票單在 Asana 上的完整活動時間軸（留言＋系統事件＋附件，依時間排序），橋接 asana-mcp 的 asana_task_activity。" +
      "**使用者說類似「查看測試員回報的測試狀況」時要呼叫這個**——代表使用者已經在 Asana 上看到測試員把測出來的問題寫進留言（可能還附了截圖/紀錄檔），要你去讀懂問題、修好程式碼。" +
      "回傳的 items 每筆 kind 是 \"comment\"（使用者留言，通常是測試員回報的問題內容）、\"system_event\"（狀態變更等系統事件）或 \"attachment\"（該時間點上傳的附件，只有 metadata）。" +
      "看到 kind:\"attachment\" 而且判斷跟問題有關（例如錯誤截圖、log 檔）時，帶它的 attachmentGid 呼叫 `download_ticket_attachment` 把內容抓下來讀，不要只看檔名猜內容。" +
      "**讀完、修好程式碼、確認根因之後，要把這次結果正式寫回本地追蹤系統**：這張票通常已經是 `verified` 且 `PASS`（AI 驗證師判過、正在等 `record_confirmation`）——呼叫 `record_confirmation({ taskGid, confirmed: false, note: <引用測試員回報的問題摘要> })`，讓它套用跟一般人類打回完全一樣的 `humanRejected`/根因分流機制（見 `advance_ticket_stage` 的 `rootCause` 說明），不要另外發明一套「口頭回報」流程。如果這張票還沒到 `verified` 階段就已經有測試員留言（少見），直接以目前角色繼續往下走，不需要呼叫 `record_confirmation`。",
    { taskGid: z.string().describe("Asana 任務 gid") },
    async ({ taskGid }) => {
      const result = await callAsanaTool("asana_task_activity", { taskGid });
      return textResult(result, result?.success === false);
    }
  );

  server.tool(
    "download_ticket_attachment",
    "【唯讀】下載某個附件到本機暫存檔，回傳 tempFilePath，橋接 asana-mcp 的 asana_download_attachment。" +
      "attachmentGid 來自 `get_ticket_activity`（kind:\"attachment\" 項目）或 `asana_attachments`。" +
      "docx/xlsx/pdf 等格式請改用專案既有的檔案讀取流程處理這個路徑，讀完記得清掉暫存目錄。",
    { attachmentGid: z.string().describe("附件 gid") },
    async ({ attachmentGid }) => {
      const result = await callAsanaTool("asana_download_attachment", { attachmentGid });
      return textResult(result, result?.success === false);
    }
  );

  server.tool(
    "get_recent_commits",
    "查詢指定目錄的最近 git commit 記錄（透過 spec-pipeline-mcp），供分析師階段參考最新異動脈絡。",
    {
      gitDir: z.string().describe("git 版控目錄"),
      limit: z.number().int().positive().max(100).default(10).describe("要抓取的 commit 數量，預設 10"),
    },
    async ({ gitDir, limit }) => {
      const result = await callSpecPipelineTool("get_recent_commits", { gitDir, limit });
      return textResult(result);
    }
  );
}
