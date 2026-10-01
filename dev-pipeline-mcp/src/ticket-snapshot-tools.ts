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
import { textResult } from "./shared.js";

/**
 * 匹配業務單號，例如 "PROJ-1234"，也支援帶數字前綴的格式如 "115PROJ-48"（部分專案的票號慣例）。
 * 前面的 `\d{0,6}` 是刻意加的：純 `\b[A-Za-z]{1,8}-\d{1,8}\b` 對 "115PROJ-48" 這種格式會抓不到——
 * \b 是「word 字元／非 word 字元」的交界，但數字跟英文字母都算 word 字元，"5" 跟 "P" 之間根本沒有
 * word boundary，所以舊版正規表達式永遠比對不到緊接在數字後面的英文字母開頭。2026-08-24 因為這個 bug，
 * 某個專案好幾張新票單的自訂欄位明明填了 "115PROJ-48" 這種格式，卻偵測失敗、整批退回用 taskGid 命名，
 * 建出一堆看不懂的數字資料夾。
 */
const TICKET_NUMBER_PATTERN = /\b\d{0,6}[A-Za-z]{1,8}-\d{1,8}\b/;

function detectTicketNumber(task: any): string | null {
  for (const field of task.custom_fields ?? []) {
    const value = field.display_value;
    if (typeof value === "string" && TICKET_NUMBER_PATTERN.test(value.trim())) {
      return value.trim();
    }
  }
  return null;
}

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
    "抓取單一 Asana 票單的完整內容（描述 + 自訂欄位 + 留言串），寫入追蹤檔案 ticket.md 並回傳。" +
      "**內容雜湊沒變時不重寫、不附全文，回傳 unchanged: true**，直接沿用本機既有 ticket.md/01-analysis.md 等內容繼續處理。" +
      "**unchanged: false 且 needsReanalysis: true=這張票之前已 analyzed/implemented/verified，但 Asana 內容後來又改了**：即使原本 PASS 也視為未驗證，要重新從分析師走一遍。" +
      "追蹤目錄建在目標專案自己的目錄：<projectDir>/.asana-pipeline/<Asana 專案全名稱>/<票號>/（不在本 MCP 安裝目錄）；首次在某 projectDir 建立時會在 <projectDir>/CLAUDE.md 加一段說明。" +
      "會自動從 task.parent 判斷子任務，先確保父票（往上到頂層）都已建好追蹤目錄，再巢狀掛在 <父票號>/<子票號>/，層數不限。",
    {
      taskGid: z.string().describe("Asana 任務 gid"),
      projectDir: z.string().describe("這張票對應的程式碼專案目錄（絕對路徑，先用 resolve_project_dir/register_project_dir 拿到），追蹤目錄會建在這個目錄底下"),
      projectName: z.string().describe("這張票所屬的 Asana 專案「全名稱」，用來當作追蹤目錄裡的一層名稱（例如完整的 Asana 專案名稱，不是簡稱）"),
      ticketNumber: z
        .string()
        .nullable()
        .optional()
        .describe("這張票的業務單號（例如「PROJ-1234」），不提供的話會嘗試從自訂欄位自動偵測，偵測不到才會退回用 taskGid 命名"),
      projectGid: z
        .string()
        .nullable()
        .optional()
        .describe("這張票所屬 Asana 專案的 gid（步驟 0 已取得）。帶了會記進票單狀態，之後 get_ticket_status 的 nextAction 與 get_role_prompt 會依該專案的 SA/SD、測試設定給更精準的內容；已有 gid 時以新傳入的為準。"),
    },
    async ({ taskGid, projectDir, projectName, ticketNumber, projectGid }) => {
      let result: { ticketNumber: string | null; content: string; dir: string; unchanged: boolean; needsReanalysis: boolean };
      try {
        result = await ensureSnapshotted(taskGid, projectDir, projectName, ticketNumber, 0, projectGid ?? null);
      } catch (err: any) {
        return textResult({ success: false, message: err?.message ?? String(err) }, true);
      }

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
    "修正票追蹤資料夾的 Asana 專案名稱標籤：get_ticket_snapshot 第一次呼叫時 projectName 傳錯，就把 <projectDir>/.asana-pipeline/<舊專案名稱>/<票號>/ 連同巢狀子任務整份搬到 <newProjectName>/<票號>/。" +
      "**這不是換票所屬的 Asana 專案**（Asana 上的歸屬不會改），只是更正本機標籤。" +
      "**呼叫前務必先用 asana_projects 或 asana_task 查證 newProjectName，不要猜**，這會實際搬動磁碟上的資料夾。" +
      "**絕對不要自己用檔案總管/shell 搬**：本 MCP 的 tickets-index.json 索引不會更新，之後會找不到追蹤檔案，或在舊路徑生出空白紀錄蓋掉進度；務必只透過這個工具。" +
      "成功回傳 oldDir/newDir/movedDescendants，並局部重建新舊兩個專案資料夾的 PENDING_HUMAN_ACTIONS.html（舊專案若已無其他追蹤票，舊報告不會自動清空，需人工檢查是否刪除）。",
    {
      taskGid: z.string().describe("要修正資料夾歸屬的 Asana 任務 gid（如果它有子任務，會一併搬動）"),
      newProjectName: z.string().describe("已查證過的 Asana 專案「全名稱」（正確答案），不是簡稱或猜測值"),
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
