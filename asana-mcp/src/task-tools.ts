import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asanaTask, asanaTaskComments, asanaTaskActivity } from "./asana-client.js";
import { toolResult } from "./shared.js";

export function registerTaskTools(server: McpServer): void {
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
    "asana_task_activity",
    "【唯讀】取得任務的完整活動時間軸——把 asana_task_comments（留言＋系統事件）跟 asana_attachments（附件清單）合併成一份依時間排序的清單，回傳在 items 欄位。" +
      "每筆項目的 kind 是 \"comment\"（使用者留言，通常含測試員回報的問題內容）、\"system_event\"（狀態變更等系統事件）或 \"attachment\"（這個時間點上傳的附件，只有 metadata，要讀內容另外帶 attachmentGid 呼叫 asana_download_attachment）。" +
      "要判斷「這張票最近有沒有人留言/上傳新東西」「測試員在哪個時間點回報了什麼問題、附了什麼截圖或紀錄檔」時，呼叫這個比分開呼叫 asana_task_comments + asana_attachments 再自己對時間更省事——不用自己猜哪個附件對應哪句留言。" +
      "attachmentsTruncated: true 代表附件清單分頁中途失敗或超過安全上限，不完整。",
    {
      taskGid: z.string().describe("任務 gid"),
    },
    async ({ taskGid }) => toolResult(await asanaTaskActivity(taskGid))
  );
}
