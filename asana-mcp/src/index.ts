#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  asanaWorkspaces,
  asanaProjects,
  asanaBoard,
  asanaTask,
  asanaTaskComments,
  asanaAttachments,
  asanaDownloadAttachment,
  asanaMe,
  type AsanaResult,
} from "./asana-client.js";

const server = new McpServer({
  name: "asana-mcp",
  version: "0.1.0",
});

function toolResult(result: AsanaResult | { success: boolean; [key: string]: unknown }) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(result),
      },
    ],
    isError: result.success !== true,
  };
}

server.tool(
  "asana_me",
  "【唯讀】取得這組共用帳號 token 對應的 Asana 使用者身份（gid/name/email）。" +
    "用來判斷「某張任務的指派人是不是這個 pipeline 帳號本人」這類條件（例如 asana-pipeline-mcp 用來過濾『內容變動但沒有指派給這個帳號』的票單），不需要使用者自己去 Asana 網頁查 gid 貼過來。",
  {},
  async () => toolResult(await asanaMe())
);

server.tool(
  "asana_workspaces",
  "【唯讀】列出共用 Asana 帳號可見的所有工作區（workspace），用來找 workspaceGid。",
  {},
  async () => toolResult(await asanaWorkspaces())
);

server.tool(
  "asana_projects",
  "【唯讀】列出指定工作區底下的所有未封存專案，用來找 projectGid。",
  {
    workspaceGid: z.string().describe("工作區 gid，來自 asana_workspaces"),
  },
  async ({ workspaceGid }) => toolResult(await asanaProjects(workspaceGid))
);

server.tool(
  "asana_board",
  "【唯讀】取得專案完整看板：區段（sections）+ 全部任務（含負責人、到期日、自訂欄位、完成度）。" +
    "並行拉取 + 5 分鐘記憶體快取，refresh=true 可略過快取重新抓取。",
  {
    projectGid: z.string().describe("專案 gid，來自 asana_projects"),
    refresh: z.boolean().default(false).describe("是否略過快取重新抓取"),
  },
  async ({ projectGid, refresh }) => toolResult(await asanaBoard(projectGid, refresh))
);

server.tool(
  "asana_task",
  "【唯讀】取得單一任務的完整詳情，包含描述（notes）、自訂欄位、與子任務清單（subtasks）——這些都不在 asana_board 的結果裡。" +
    "要理解任務的具體問題內容時必須呼叫這個。" +
    "回傳的 subtasks 陣列只含每個子任務的基本欄位（name/gid/completed/assignee/due_on/num_subtasks）；" +
    "若某個子任務的 num_subtasks > 0（代表它底下還有孫任務）或需要子任務的完整內容（notes/自訂欄位），" +
    "把該子任務的 gid 當作 taskGid 再呼叫一次 asana_task 即可逐層往下查。",
  {
    taskGid: z.string().describe("任務 gid（母任務或子任務皆可，取子任務詳情時把子任務 gid 傳進來即可）"),
  },
  async ({ taskGid }) => toolResult(await asanaTask(taskGid))
);

server.tool(
  "asana_task_comments",
  "【唯讀】取得任務的完整活動流（stories），包含使用者留言與系統事件。" +
    "回傳項目的 resource_subtype 為 \"comment_added\" 的才是使用者留言，其餘為狀態變更等系統事件。" +
    "要瞭解任務目前的討論進度、他人分析或提出的解法時呼叫這個。",
  {
    taskGid: z.string().describe("任務 gid"),
  },
  async ({ taskGid }) => toolResult(await asanaTaskComments(taskGid))
);

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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("asana-mcp failed to start:", err);
  process.exit(1);
});
