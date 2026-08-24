import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asanaAttachments, asanaDownloadAttachment } from "./asana-client.js";
import { toolResult } from "./shared.js";

export function registerAttachmentTools(server: McpServer): void {
  server.tool(
    "asana_attachments",
    "【唯讀】列出任務底下的所有附件（檔名、類型、大小、下載連結），附件清單在回傳結果的 items 欄位裡。看到票單描述裡有貼圖片/檔案、或需要確認票單有沒有附件時呼叫這個。" +
      "回傳的 download_url 是短效簽章連結，容易過期——不要直接拿這個 URL 去抓，要下載內容請改用 asana_download_attachment 帶 items 裡每筆附件的 gid。" +
      "如果 truncated 是 true，代表附件超過安全上限或分頁中途失敗，這份清單不完整。",
    {
      taskGid: z.string().describe("任務 gid"),
    },
    async ({ taskGid }) => toolResult(await asanaAttachments(taskGid))
  );

  server.tool(
    "asana_download_attachment",
    "【唯讀】下載單一附件到本機暫存檔，回傳 tempFilePath（不管文字或二進位格式一律寫檔）。" +
      "docx/xlsx/pdf 等格式請改用專案既有的檔案讀取流程處理這個路徑（例如 docx 用 CLAUDE.md 裡的 python-docx 讀取流程），讀完記得清掉暫存目錄。" +
      "attachmentGid 來自 asana_attachments 回傳結果裡每筆附件的 gid。",
    {
      attachmentGid: z.string().describe("附件 gid，來自 asana_attachments"),
    },
    async ({ attachmentGid }) => toolResult(await asanaDownloadAttachment(attachmentGid))
  );
}
