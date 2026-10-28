import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callAsanaTool } from "./mcp-clients.js";
import {
  assignTicketDir,
  getAssignedDir,
  listTicketsUnderProject,
  readStatus,
  recordProjectContext,
  recordSnapshotContent,
  relocateTicketDir,
  writeArtifact,
} from "./pipeline-store.js";
import { syncPendingActionsReport } from "./pending-actions-sync.js";
import { detectTicketNumber } from "./ticket-list-filter.js";
import { textResult } from "./shared.js";

const MAX_ANCESTOR_DEPTH = 10;

/**
 * Fetches one task's detail + comments from Asana, writes its ticket.md, and returns
 * the resolved ticket number + content. Does NOT touch the tracking directory —
 * callers assign the directory themselves once the full ancestor chain is known.
 */
async function fetchAndWriteTicketSnapshot(
  taskGid: string,
  ticketNumberOverride?: string | null
): Promise<{ task: any; ticketNumber: string | null; content: string }> {
  const [taskRes, commentsRes] = await Promise.all([
    callAsanaTool("asana_task", { taskGid }),
    callAsanaTool("asana_task_comments", { taskGid }),
  ]);
  if (!taskRes?.success) {
    throw new Error(taskRes?.message ?? `抓取任務 ${taskGid} 失敗`);
  }

  const task = taskRes.data as any;
  const comments: any[] = commentsRes?.success && Array.isArray(commentsRes.data) ? commentsRes.data : [];
  const userComments = comments.filter((c) => c.resource_subtype === "comment_added");

  const customFieldsText = (task.custom_fields ?? [])
    .filter((f: any) => f.display_value)
    .map((f: any) => `- ${f.name}: ${f.display_value}`)
    .join("\n");

  const commentsText = userComments
    .map((c) => `- [${c.created_at}] ${c.created_by?.name ?? "?"}: ${c.text}`)
    .join("\n");

  const content = [
    `# ${task.name}`,
    "",
    "## 描述",
    task.notes || "(無)",
    "",
    "## 自訂欄位",
    customFieldsText || "(無)",
    "",
    "## 留言串",
    commentsText || "(無留言)",
  ].join("\n");

  const ticketNumber = ticketNumberOverride ?? detectTicketNumber(task);
  return { task, ticketNumber, content };
}

/**
 * Ensures a ticket (and every one of its Asana ancestors, walking up via task.parent)
 * has a tracking directory + ticket.md, nesting child under parent automatically.
 * This is what fixes the "subtask created as if top-level" bug: the caller no longer
 * has to already know/pass parentTaskGid — it's read straight from Asana's own data.
 */
async function ensureSnapshotted(
  taskGid: string,
  projectDir: string,
  projectName: string,
  ticketNumberOverride: string | null | undefined,
  depth: number,
  projectGid: string | null = null
): Promise<{ ticketNumber: string | null; content: string; dir: string; unchanged: boolean; needsReanalysis: boolean }> {
  if (depth > MAX_ANCESTOR_DEPTH) {
    throw new Error(`任務 ${taskGid} 的父子關係層數超過 ${MAX_ANCESTOR_DEPTH} 層，可能有循環，已中止。`);
  }

  const { task, ticketNumber, content } = await fetchAndWriteTicketSnapshot(taskGid, ticketNumberOverride);

  const parentGid: string | null = task.parent?.gid ?? null;
  let parentTaskGid: string | null = null;
  if (parentGid) {
    const parentAlreadyAssigned = await getAssignedDir(parentGid);
    if (!parentAlreadyAssigned) {
      await ensureSnapshotted(parentGid, projectDir, projectName, null, depth + 1, projectGid);
    }
    parentTaskGid = parentGid;
  }

  const dir = await assignTicketDir(projectDir, taskGid, projectName, ticketNumber, parentTaskGid, task.name ?? null);
  // 記錄 project_dir/project_name/name/指派人，讓之後這張票任何一次狀態異動都能局部重建 PENDING_HUMAN_ACTIONS.html
  // （見 syncPendingActionsReport），不用每次都額外傳 projectGid/projectName 或重新查一次 Asana。
  await recordProjectContext(
    taskGid,
    projectDir,
    projectName,
    task.name ?? taskGid,
    task.assignee?.gid ?? null,
    task.completed === true,
    projectGid
  );
  // 內容雜湊沒變就不重寫 ticket.md、也不把全文塞回這次回應——省掉留言串很長的票單重複佔用 token 的成本。
  const { changed, needsReanalysis } = await recordSnapshotContent(taskGid, content, task.modified_at ?? null);
  if (changed) {
    await writeArtifact(taskGid, "ticket.md", content);
  }
  return { ticketNumber, content, dir, unchanged: !changed, needsReanalysis };
}

export function registerTicketSnapshotTools(server: McpServer): void {
  server.tool(
    "get_ticket_snapshot",
    "抓取 Asana 票單完整內容（描述＋自訂欄位＋留言串），寫入追蹤檔 ticket.md 並回傳。" +
      "**內容雜湊沒變時不重寫、不附全文，回傳 unchanged: true**，沿用本機既有檔案繼續。" +
      "**unchanged: false 且 needsReanalysis: true=票之前已 analyzed/implemented/verified，但 Asana 內容後來又改了**：即使原本 PASS 也視為未驗證，要從分析師重走。" +
      "追蹤目錄建在 <projectDir>/.asana-pipeline/<Asana 專案全名稱>/<票號>/。" +
      "子任務依 task.parent 自動先建父票，巢狀掛在 <父票號>/<子票號>/。",
    {
      taskGid: z.string().describe("任務 gid"),
      projectDir: z.string().describe("程式碼專案目錄絕對路徑（先用 project_config(kind='project_dir') 取得），追蹤目錄建在其下"),
      projectName: z.string().describe("票所屬 Asana 專案「全名稱」（非簡稱），當追蹤目錄的一層名稱"),
      ticketNumber: z
        .string()
        .nullable()
        .optional()
        .describe("業務單號（如「PROJ-1234」）；不提供會從自訂欄位偵測，偵測不到用 taskGid"),
      projectGid: z
        .string()
        .nullable()
        .optional()
        .describe("票所屬 Asana 專案 gid；會記進狀態，nextAction 與 get_role_prompt 依此給更精準內容"),
    },
    async ({ taskGid, projectDir, projectName, ticketNumber, projectGid }) => {
      let result: { ticketNumber: string | null; content: string; dir: string; unchanged: boolean; needsReanalysis: boolean };
      try {
        result = await ensureSnapshotted(taskGid, projectDir, projectName, ticketNumber, 0, projectGid ?? null);
      } catch (err: any) {
        return textResult({ success: false, message: err?.message ?? String(err) }, true);
      }

      // 這次抓取可能清掉了「請 AI 優先處理」旗標、或更新了 needs_reanalysis——報告不跟著重建的話，網頁會一直停在舊的「已標記」畫面。
      await syncPendingActionsReport(taskGid);

      if (result.unchanged) {
        return textResult({
          success: true,
          taskGid,
          ticketNumber: result.ticketNumber,
          unchanged: true,
          needsReanalysis: result.needsReanalysis,
          message: result.needsReanalysis
            ? "這次抓取跟上次比沒有再變——但這張票先前已經偵測到 Asana 內容變過、needs_reanalysis 還沒清掉（要等分析師重新寫過 01-analysis.md 才會清），代表分析仍然是舊版本的，不能沿用舊結論，要重新走一次分析師角色。"
            : "票單內容跟上次抓的一樣，未變更——沿用本機既有的追蹤檔案繼續處理即可，不用重新分析。",
        });
      }

      return textResult({
        success: true,
        taskGid,
        ticketNumber: result.ticketNumber,
        unchanged: false,
        needsReanalysis: result.needsReanalysis,
        content: result.content,
      });
    }
  );

  server.tool(
    "relocate_ticket_project",
    "修正追蹤資料夾的專案名稱標籤：get_ticket_snapshot 首次 projectName 傳錯時，把 .asana-pipeline/<舊專案名稱>/<票號>/ 連同子任務整份搬到 <newProjectName>/<票號>/。" +
      "**這不是換票所屬的 Asana 專案**，只更正本機標籤。**呼叫前務必先用 asana_projects 或 asana_task 查證 newProjectName，不要猜**，這會實際搬動磁碟資料夾。" +
      "**絕對不要自己用檔案總管/shell 搬**：索引不會更新，之後會找不到追蹤檔案或在舊路徑生出空白紀錄蓋掉進度；只透過本工具。回傳 oldDir/newDir/movedDescendants；舊專案若已無追蹤票，舊報告需人工檢查是否刪除。",
    {
      taskGid: z.string().describe("要修正的任務 gid（子任務一併搬）"),
      newProjectName: z.string().describe("已查證的 Asana 專案「全名稱」，非簡稱或猜測值"),
    },
    async ({ taskGid, newProjectName }) => {
      const before = await readStatus(taskGid).catch(() => null);
      let result: Awaited<ReturnType<typeof relocateTicketDir>>;
      try {
        result = await relocateTicketDir(taskGid, newProjectName);
      } catch (err: any) {
        return textResult({ success: false, message: err?.message ?? String(err) }, true);
      }

      await syncPendingActionsReport(taskGid);

      let oldProjectReportRefreshed = false;
      if (before?.project_dir && result.oldProjectName && result.oldProjectName !== newProjectName) {
        const remaining = await listTicketsUnderProject(before.project_dir, result.oldProjectName);
        if (remaining.length > 0) {
          await syncPendingActionsReport(remaining[0]);
          oldProjectReportRefreshed = true;
        }
      }

      return textResult({
        success: true,
        taskGid,
        oldDir: result.oldDir,
        newDir: result.newDir,
        oldProjectName: result.oldProjectName,
        newProjectName,
        movedDescendants: result.movedDescendants,
        oldProjectReportRefreshed,
        message: oldProjectReportRefreshed
          ? "搬移完成，新舊兩個專案的 PENDING_HUMAN_ACTIONS.html 都已更新。"
          : "搬移完成。舊專案底下已經沒有其他已追蹤票單，它的 PENDING_HUMAN_ACTIONS.html 沒有自動更新（可能需要人工檢查是否要一併清理那份檔案）。",
      });
    }
  );
}
