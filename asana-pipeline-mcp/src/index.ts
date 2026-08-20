#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { getTemplatesDir } from "./config-store.js";
import { callAsanaTool, callSpecPipelineTool, callSvnTool, closeChildMcpClients } from "./mcp-clients.js";
import { fsReadFile, fsWriteFile, fsListDir, fsSearchText, PathEscapeError } from "./fs-tools.js";
import { runShell } from "./shell-tools.js";
import { resolveGitRoots, registerGitRoots, type GitRootEntry } from "./git-roots-store.js";
import {
  readStatus,
  peekStatus,
  advanceStage,
  advanceStageIfForward,
  writeArtifact,
  readArtifact,
  assignTicketDir,
  getAssignedDir,
  recordSnapshotContent,
  recordArtifactSummary,
  recordArtifactHash,
  recordStageSync,
  computeSyncFlags,
  detectExternalChanges,
  recordSelfConfirmation,
  recordTesterConfirmation,
  needsHumanReview,
  recordManualActions,
  writePendingActionsReport,
  NO_SYNC_NEEDED,
  type TicketStatus,
} from "./pipeline-store.js";
import {
  resolveSasdConfig,
  registerSasdConfig,
  resolveDefaultProject,
  registerDefaultProject,
  resolveProjectDir,
  registerProjectDir,
} from "./project-registry.js";
import { OVERVIEW_PROMPT, getRolePrompt } from "./prompts.js";

const server = new McpServer({
  name: "asana-pipeline-mcp",
  version: "0.1.0",
});

function textResult(payload: unknown, isError = false) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  return { content: [{ type: "text" as const, text }], isError };
}

// ---------------------------------------------------------------------------
// Pipeline / role documentation
// ---------------------------------------------------------------------------

server.tool(
  "get_pipeline_overview",
  "取得整條 Asana 票單自動處理 pipeline 的流程說明（步驟、要呼叫哪些工具、安全限制）。任何要驅動這條 pipeline 的 AI，第一步都應該先呼叫這個工具讀懂整體流程。",
  {},
  async () => textResult(OVERVIEW_PROMPT)
);

server.tool(
  "get_role_prompt",
  "取得「分析師 / 工程師 / 驗證師」其中一個角色的職責說明、可用工具、輸出格式。驅動 pipeline 的 AI 在切換角色前應該先呼叫這個工具讀懂該角色的說明。",
  { role: z.enum(["analyst", "engineer", "verifier"]).describe("要取得說明的角色") },
  async ({ role }) => textResult(getRolePrompt(role))
);

// ---------------------------------------------------------------------------
// Asana ticket access (bridged to asana-mcp)
// ---------------------------------------------------------------------------

server.tool(
  "list_pending_tickets",
  "列出指定 Asana 專案裡尚未完成、且尚未驗證通過（PASS）的票單清單。透過 asana-mcp 取得看板資料，並依本地追蹤紀錄過濾掉已經處理完成的票。" +
    "**已經 PASS 的票單如果 Asana 上的內容後來又被改過（用 modified_at 便宜初篩），一樣會重新列進 tickets，並標記 contentChanged: true**——代表這張票不能因為之前 PASS 就跳過，下一步呼叫 get_ticket_snapshot 會確認內容是否真的變了、需不需要重新分析。" +
    "**結案前還有兩關人類確認，回傳額外附上這兩關各自待處理的清單：**" +
    "**awaitingSelfConfirmation（第一關）**：AI 驗證師判過 PASS、Asana 內容也沒再變過，但『使用者自己』還沒實際測過＋審視過程式碼品質的票單。" +
    "**awaitingTesterConfirmation（第二關／最終關）**：第一關已經 confirmed:true，但『另一位獨立測試員』的情境測試還沒表態的票單——只有這關也 confirmed:true，票單才算真正結案。" +
    "AI 自己判定 PASS 不等於這張票真的結案，呼叫端每次執行這個工具都必須把這兩份清單完整秀給使用者看（不能因為這次是來處理別的新票就略過），直到每一張都依序走完 record_self_confirmation 再 record_tester_confirmation 為止，才會從清單消失。" +
    "**`tickets`（一般待處理清單）裡如果某張票標記 `humanRejected: true`，代表這不是一張全新沒驗證過的票，而是使用者或測試員事後回報有問題、被重新丟回來的票**（`record_self_confirmation`/`record_tester_confirmation` 帶 `confirmed:false` 時會把這張票的 verdict 重設回 null，讓它重新出現在這裡）——處理這種票要當作跟 AI 驗證師自己判 FAIL 完全一樣的情況，套用同一套根因分流機制（見 get_role_prompt({role:\"verifier\"})/advance_ticket_stage 的 rootCause 說明），不要另外發明一套「人工打回」流程。" +
    "**帶 `projectName` 時，這次算出來的四類「需要人工處理」項目（待你確認／待測試員確認／卡住需要介入／需要你手動處理的事項）會整份覆寫進一份持久化的 `PENDING_HUMAN_ACTIONS.md`**（放在 `<projectDir>/.asana-pipeline/<projectName>/` 底下，跟每張票自己的追蹤目錄同一層）——這是為了取代「只在聊天視窗提醒一次，換個 session 就找不到」的做法，不需要任何人記得手動維護。強烈建議每次呼叫都帶上 `projectName`（跟步驟 0 拿到的 Asana 專案全名稱一致）。",
  {
    projectGid: z.string().describe("Asana 專案 gid"),
    sectionFilter: z.string().nullable().optional().describe("只取這個 section 名稱底下的任務，不指定就取全部"),
    projectName: z
      .string()
      .nullable()
      .optional()
      .describe("這個 Asana 專案的「全名稱」。有帶的話會把這次算出的待處理項目寫進 PENDING_HUMAN_ACTIONS.md；不帶就只回傳 JSON，不寫檔案。"),
  },
  async ({ projectGid, sectionFilter, projectName }) => {
    const board = await callAsanaTool("asana_board", { projectGid, refresh: true });
    if (!board?.success) return textResult(board, true);

    const tasks: any[] = Array.isArray(board.tasks) ? board.tasks : [];
    const pending = [];
    const awaitingSelfConfirmation = [];
    const awaitingTesterConfirmation = [];
    const needsHumanReviewList = [];
    const manualActionsList = [];
    for (const task of tasks) {
      if (task.completed === true) continue;
      if (sectionFilter) {
        const sectionNames = (task.memberships ?? []).map((m: any) => m.section?.name);
        if (!sectionNames.includes(sectionFilter)) continue;
      }
      const status = await peekStatus(task.gid);

      // 人工手動待辦跟連續 FAIL 安全閥，不管這張票目前卡在哪個分流，都要獨立檢查一次——不能只在某個分支裡順便處理。
      const manualActions = [...status.implementation_manual_actions, ...status.verification_manual_actions];
      if (manualActions.length > 0) {
        manualActionsList.push({ taskGid: task.gid, name: task.name, actions: manualActions });
      }
      if (status.stage === "verified" && status.verdict === "FAIL" && needsHumanReview(status)) {
        needsHumanReviewList.push({ taskGid: task.gid, name: task.name, consecutiveFailCount: status.consecutive_fail_count });
      }

      const isVerifiedPass = status.stage === "verified" && status.verdict === "PASS";
      const boardModifiedAt: string | null = task.modified_at ?? null;
      const contentChanged =
        isVerifiedPass &&
        !!boardModifiedAt &&
        !!status.last_seen_modified_at &&
        boardModifiedAt !== status.last_seen_modified_at;

      if (isVerifiedPass && !contentChanged) {
        // AI 已判 PASS 且內容沒再變——但這不等於「真正結案」，要依兩關人類確認狀態分流，不能直接略過不管。
        if (status.tester_confirmation?.confirmed === true) continue; // 兩關都確認沒問題，才算真的結案
        if (status.self_confirmation?.confirmed === true) {
          // 第一關（自己測+審視 code）已過，卡在第二關（獨立測試員的情境測試）
          awaitingTesterConfirmation.push({
            taskGid: task.gid,
            name: task.name,
            dueOn: task.due_on,
            selfConfirmation: status.self_confirmation,
            testerConfirmation: status.tester_confirmation,
          });
        } else {
          // 還沒過第一關，不能跳過去問第二關
          awaitingSelfConfirmation.push({
            taskGid: task.gid,
            name: task.name,
            dueOn: task.due_on,
            selfConfirmation: status.self_confirmation,
          });
        }
        continue;
      }

      pending.push({
        taskGid: task.gid,
        name: task.name,
        dueOn: task.due_on,
        stage: status.stage,
        ...(contentChanged || status.needs_reanalysis ? { contentChanged: true } : {}),
        ...(status.self_confirmation?.confirmed === false || status.tester_confirmation?.confirmed === false
          ? { humanRejected: true }
          : {}),
      });
    }

    let pendingActionsReportPath: string | null = null;
    if (projectName) {
      const projectDir = await resolveProjectDir(projectGid);
      if (projectDir) {
        pendingActionsReportPath = await writePendingActionsReport(projectDir, projectName, {
          awaitingSelfConfirmation,
          awaitingTesterConfirmation,
          needsHumanReview: needsHumanReviewList,
          manualActions: manualActionsList,
        });
      }
    }

    return textResult({
      success: true,
      projectGid,
      count: pending.length,
      tickets: pending,
      awaitingSelfConfirmationCount: awaitingSelfConfirmation.length,
      awaitingSelfConfirmation,
      awaitingTesterConfirmationCount: awaitingTesterConfirmation.length,
      awaitingTesterConfirmation,
      needsHumanReviewCount: needsHumanReviewList.length,
      needsHumanReview: needsHumanReviewList,
      manualActionsCount: manualActionsList.length,
      manualActions: manualActionsList,
      ...(pendingActionsReportPath ? { pendingActionsReportPath } : {}),
    });
  }
);

const TICKET_NUMBER_PATTERN = /\b[A-Za-z]{1,8}-\d{1,8}\b/;

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
  depth: number
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
      await ensureSnapshotted(parentGid, projectDir, projectName, null, depth + 1);
    }
    parentTaskGid = parentGid;
  }

  const dir = await assignTicketDir(projectDir, taskGid, projectName, ticketNumber, parentTaskGid);
  // 內容雜湊沒變就不重寫 ticket.md、也不把全文塞回這次回應——省掉留言串很長的票單重複佔用 token 的成本。
  const { changed, needsReanalysis } = await recordSnapshotContent(taskGid, content, task.modified_at ?? null);
  if (changed) {
    await writeArtifact(taskGid, "ticket.md", content);
  }
  return { ticketNumber, content, dir, unchanged: !changed, needsReanalysis };
}

server.tool(
  "get_ticket_snapshot",
  "抓取單一 Asana 票單的完整內容（描述 + 自訂欄位 + 留言串），寫入追蹤檔案 ticket.md 並回傳內容。" +
    "**內容雜湊沒變的話（跟上次抓的一樣），不會重寫檔案，回傳的是 unchanged: true 加簡短訊息，不會附上全文**——代表可以直接沿用本機既有的 ticket.md/01-analysis.md 等既有內容繼續處理，不用把票單全文重新讀進對話裡。" +
    "**如果偵測到內容真的變了（unchanged: false）、而且 needsReanalysis: true，代表這張票之前已經 analyzed/implemented/verified 過，但 Asana 上的內容後來又被改了**——即使原本驗證是 PASS，也要當作還沒驗證過，重新從分析師角色走一遍，不能沿用舊的分析/實作結論。" +
    "追蹤目錄建立在**目標程式碼專案自己的目錄裡**（不是這個 MCP 自己的安裝目錄），路徑是 <projectDir>/.asana-pipeline/<Asana 專案全名稱>/<票號>/，這樣分享/交接這個 MCP 工具本身時，不會夾帶任何客戶票單的實際內容。" +
    "第一次在某個 projectDir 底下建立追蹤目錄時，會順便在 <projectDir>/CLAUDE.md 加一段說明，告訴之後接手的 AI/工程師這個 .asana-pipeline 目錄是做什麼用的。" +
    "會自動偵測這張票是不是某張票的子任務（讀 Asana 的 task.parent，不需要呼叫端自己判斷/傳遞），如果是，會先確保父票單（以及父票單的父票單……往上一路到頂層）都已經建好追蹤目錄，再把這張票巢狀掛在正確的父票單底下（<父票號>/<子票號>/），層數不限。",
  {
    taskGid: z.string().describe("Asana 任務 gid"),
    projectDir: z.string().describe("這張票對應的程式碼專案目錄（絕對路徑，先用 resolve_project_dir/register_project_dir 拿到），追蹤目錄會建在這個目錄底下"),
    projectName: z.string().describe("這張票所屬的 Asana 專案「全名稱」，用來當作追蹤目錄裡的一層名稱（例如完整的 Asana 專案名稱，不是簡稱）"),
    ticketNumber: z
      .string()
      .nullable()
      .optional()
      .describe("這張票的業務單號（例如「PROJ-1234」），不提供的話會嘗試從自訂欄位自動偵測，偵測不到才會退回用 taskGid 命名"),
  },
  async ({ taskGid, projectDir, projectName, ticketNumber }) => {
    let result: { ticketNumber: string | null; content: string; dir: string; unchanged: boolean; needsReanalysis: boolean };
    try {
      result = await ensureSnapshotted(taskGid, projectDir, projectName, ticketNumber, 0);
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
        message: "票單內容跟上次抓的一樣，未變更——沿用本機既有的追蹤檔案繼續處理即可，不用重新分析。",
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

// ---------------------------------------------------------------------------
// Project directory resolution (this MCP's own registry — independent from
// git-roots-store.ts, which separately tracks the actual .git root(s) *inside*
// this directory; see resolve_git_roots/register_git_roots below)
// ---------------------------------------------------------------------------

server.tool(
  "resolve_project_dir",
  "查詢這個 Asana 專案是否已經登記過對應的本機/伺服器程式碼目錄。找到就直接回傳 projectDir，不用再問使用者；找不到則回傳 needsInput，呼叫端要自己想辦法取得目錄後呼叫 register_project_dir。",
  { projectGid: z.string().describe("Asana 專案 gid") },
  async ({ projectGid }) => {
    const projectDir = await resolveProjectDir(projectGid);
    if (projectDir) return textResult({ found: true, projectDir });
    return textResult({ found: false, needsInput: true });
  }
);

server.tool(
  "register_project_dir",
  "把使用者提供的專案目錄，登記為某個 Asana 專案的對應關係，之後同一個 Asana 專案的票都不用再問。",
  {
    projectGid: z.string().describe("Asana 專案 gid"),
    projectDir: z.string().describe("使用者提供的程式碼目錄（絕對路徑）"),
  },
  async ({ projectGid, projectDir }) => {
    const absDir = path.resolve(projectDir);
    await registerProjectDir(projectGid, absDir);
    return textResult({ success: true, projectGid, projectDir: absDir });
  }
);

server.tool(
  "resolve_sasd_config",
  "查詢這個 Asana 專案的 SA/SD 規格設定（SA 存放位置、SD 的模式與位置）。找到就直接用，不用再問使用者；找不到則回傳 needsInput，呼叫端要照 get_pipeline_overview 的說明問完整套問題後呼叫 register_sasd_config。這是每個 Asana 專案只需要設定一次的東西，不是每張票都要問——除非 sdMode 是 \"unregistered\"，那種情況才需要逐票詢問。",
  { projectGid: z.string().describe("Asana 專案 gid") },
  async ({ projectGid }) => {
    const config = await resolveSasdConfig(projectGid);
    if (config) return textResult({ found: true, ...config });
    return textResult({ found: false, needsInput: true });
  }
);

server.tool(
  "register_sasd_config",
  "登記某個 Asana 專案的 SA/SD 規格設定。sdMode 有四種：" +
    "\"external\"（SD 是別人/客戶產的，只能讀取當作依據，絕對不能建議修改 SD 本身，只能調整程式碼）、" +
    "\"self\"（SD 是我方產的，判斷需要調整時可以在驗證/實作報告裡明確建議修改段落，但因為 SVN 是唯讀的，不能直接寫回去，要交由人工事後更新）、" +
    "\"self-generated\"（沒有既有 SD，AI 自己維護一份 living document，之後可以用 read_project_sd_doc/write_project_sd_doc 真的讀寫這份文件——**這份文件會寫在 sdOutputPath 指定的真實本機路徑**，不是藏在這個 MCP 自己的安裝目錄裡，方便使用者事後直接把這個檔案傳到 SVN）、" +
    "\"unregistered\"（沒有登記 SD 位置也不自動產生，之後每一張票都要單獨詢問使用者這張票有沒有對應 SD，不會被這裡的設定省略掉）。" +
    "**\"external\"/\"self\" 一定要帶 svnConnectionId，而且這個工具會真的呼叫 svn_test_connection 驗證連得上才會登記成功**——saRoot/sdRoot 是 SVN 上的正式路徑，連不上 SVN 就沒辦法確認規格內容，不能假設之後會自己通。",
  {
    projectGid: z.string().describe("Asana 專案 gid"),
    saRoot: z.string().describe("SA 規格存放位置，SVN 上的正式路徑（例如 \"doc/sa\"，相對於 svnConnectionId 對應 repo 的根目錄）"),
    sdMode: z.enum(["external", "self", "self-generated", "unregistered"]).describe("SD 規格的模式"),
    sdRoot: z.string().nullable().optional().describe("SD 規格存放位置，只有 sdMode 是 external 或 self 時才需要"),
    svnConnectionId: z
      .string()
      .nullable()
      .optional()
      .describe(
        "saRoot/sdRoot 所在的 SVN 連線（svn_list_connections 回傳的 id 或 name），只有 sdMode 是 \"external\" 或 \"self\" 時才需要。" +
          "這個工具會真的呼叫 svn_test_connection 驗證連得上，連不上會拒絕登記。"
      ),
    sdOutputPath: z
      .string()
      .nullable()
      .optional()
      .describe(
        "AI 產出的 SD 規格要寫入的本機檔案路徑（相對於 projectDir），只有 sdMode 是 \"self-generated\" 時才需要。" +
          "這是使用者準備之後要傳到 SVN 的真實檔案位置，一定要先問使用者，不要自己隨便挑一個路徑。"
      ),
  },
  async ({ projectGid, saRoot, sdMode, sdRoot, svnConnectionId, sdOutputPath }) => {
    if (sdMode === "self-generated" && !sdOutputPath) {
      return textResult(
        { success: false, message: "sdMode 是 self-generated 時必須提供 sdOutputPath——請先問使用者「AI 產出的 SD 規格要放在本機哪個目錄/檔案」，再重新呼叫。" },
        true
      );
    }
    if ((sdMode === "external" || sdMode === "self") && !svnConnectionId) {
      return textResult(
        { success: false, message: "sdMode 是 external/self 時必須提供 svnConnectionId——請先呼叫 svn_list_connections 確認可用的連線，問清楚使用者要用哪一個，再重新呼叫。" },
        true
      );
    }
    if (svnConnectionId) {
      const testResult = await callSvnTool("svn_test_connection", { connectionId: svnConnectionId });
      if (!testResult?.success) {
        return textResult(
          {
            success: false,
            message: `SVN 連線驗證失敗，拒絕登記：${testResult?.message ?? "未知錯誤"}。請先跟使用者確認 SVN 連線設定（帳密、URL、網路/VPN），連得上再重新呼叫 register_sasd_config。`,
          },
          true
        );
      }
    }
    await registerSasdConfig(projectGid, {
      saRoot,
      sdMode,
      sdRoot: sdRoot ?? null,
      sdOutputPath: sdOutputPath ?? null,
      svnConnectionId: svnConnectionId ?? null,
    });
    return textResult({ success: true, projectGid, saRoot, sdMode, sdRoot: sdRoot ?? null, sdOutputPath: sdOutputPath ?? null, svnConnectionId: svnConnectionId ?? null });
  }
);

server.tool(
  "read_project_sd_doc",
  "讀取某個 Asana 專案自己維護的 SD 規格文件內容（只適用於 sdMode 是 \"self-generated\" 的專案）。從 register_sasd_config 登記的 sdOutputPath（真實本機檔案）讀取。第一次讀取如果還沒建立過，會回傳空字串。",
  { projectGid: z.string().describe("Asana 專案 gid"), projectDir: z.string().describe("這個 Asana 專案對應的程式碼專案目錄絕對路徑") },
  async ({ projectGid, projectDir }) => {
    const config = await resolveSasdConfig(projectGid);
    if (!config?.sdOutputPath) {
      return textResult(
        { success: false, message: "這個專案還沒登記 sdOutputPath——請先呼叫 register_sasd_config 補上 AI 產出 SD 規格要寫入的本機路徑（要先問使用者）。" },
        true
      );
    }
    try {
      const { content } = await fsReadFile(projectDir, config.sdOutputPath);
      return textResult({ success: true, content, sdOutputPath: config.sdOutputPath });
    } catch {
      return textResult({ success: true, content: "", sdOutputPath: config.sdOutputPath });
    }
  }
);

server.tool(
  "write_project_sd_doc",
  "覆寫某個 Asana 專案自己維護的 SD 規格文件內容（只適用於 sdMode 是 \"self-generated\" 的專案）。寫入 register_sasd_config 登記的 sdOutputPath（projectDir 底下的真實本機檔案，不是藏在這個 MCP 自己的安裝目錄裡），使用者可以直接把這個檔案傳到 SVN。" +
    "**呼叫這個工具之前，一定要先呼叫 get_sd_spec_template（文件是空的／第一次建立時）或 get_sd_spec_versioning_rules（文件已有內容／這次是修改既有版本時），依照裡面的規則產生內容，不要憑自己的格式直接寫。**" +
    "如果這份文件自從上次這個 MCP 寫入之後被外部改過（例如使用者手動編輯），會被擋下，回傳 externally_modified: true；確認要覆蓋就加上 acknowledgeExternalChange: true。",
  {
    projectGid: z.string().describe("Asana 專案 gid"),
    projectDir: z.string().describe("這個 Asana 專案對應的程式碼專案目錄絕對路徑"),
    content: z.string().describe("SD 規格文件的完整新內容"),
    acknowledgeExternalChange: z.boolean().optional().describe("這份文件被外部改過、確認要用這次的內容覆蓋掉時才需要帶 true"),
  },
  async ({ projectGid, projectDir, content, acknowledgeExternalChange }) => {
    const config = await resolveSasdConfig(projectGid);
    if (!config?.sdOutputPath) {
      return textResult(
        { success: false, message: "這個專案還沒登記 sdOutputPath——請先問使用者「AI 產出的 SD 規格要放在本機哪個目錄/檔案」，再呼叫 register_sasd_config 補上，才能寫入。" },
        true
      );
    }
    const outcome = await fsWriteFile(projectDir, config.sdOutputPath, content, { acknowledgeExternalChange });
    if (outcome.blocked) {
      return textResult(
        {
          success: false,
          externally_modified: true,
          message:
            "這份 SD 規格文件自從上次這個 MCP 寫入之後，已經被其他方式修改過（例如使用者手動編輯）。為避免覆蓋掉別人的修改，這次寫入已經被擋下。" +
            "請先比對 currentContent 確認要保留哪個版本；確定要用這次的內容覆蓋，呼叫時加上 acknowledgeExternalChange: true。" +
            (outcome.backupPath ? `目前磁碟上的內容已備份到：${outcome.backupPath}` : ""),
          currentContent: outcome.currentContent,
          lastWrittenAt: outcome.lastWrittenAt,
        },
        true
      );
    }
    return textResult({ success: true, projectGid, sdOutputPath: config.sdOutputPath });
  }
);

server.tool(
  "get_sd_spec_template",
  "取得 SD 規格書撰寫範本（新建規格用）：撰寫原則＋可直接複製修改的檔案骨架＋Exception/TableSchema 共用子文件骨架。" +
    "sdMode 是 \"self-generated\" 且 read_project_sd_doc 回傳空字串（代表這個專案還沒建立過自維護 SD 文件）時，" +
    "在第一次呼叫 write_project_sd_doc 之前，一定要先呼叫這個工具，照裡面的骨架與規則產生內容。" +
    "這份範本目前預設沿用一份既有客戶專案的規格書撰寫慣例（版本管控歷程表格、程式代號/API說明章節結構、" +
    "巢狀 JSON 多行縮排、純 markdown 表格不用內嵌 HTML 等），套用到其他專案的票單時也一律用同一套慣例。",
  {},
  async () => {
    const content = await readFile(path.join(getTemplatesDir(), "SD_TEMPLATE.md"), "utf8");
    return textResult(content);
  }
);

server.tool(
  "get_sd_spec_versioning_rules",
  "取得 SD 規格書維護與版更規範（編輯既有規格用）：版次怎麼遞增、修訂說明怎麼寫、<mark>標記規則、" +
    "TableSchema 子文件版號什麼時候才要跟著動。" +
    "sdMode 是 \"self-generated\" 且 read_project_sd_doc 讀到既有內容（代表這次是修改，不是第一次建立）時，" +
    "在呼叫 write_project_sd_doc 更新內容之前，一定要先呼叫這個工具確認版更規則，不要自己憑感覺加版號或標記異動。",
  {},
  async () => {
    const content = await readFile(path.join(getTemplatesDir(), "SD_VERSIONING_RULES.md"), "utf8");
    return textResult(content);
  }
);

// ---------------------------------------------------------------------------
// SVN access (bridged to svn-mcp — wraps the local Web Terminal's SVN REST API)
// ---------------------------------------------------------------------------

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
  "resolve_default_project",
  "查詢是否已經設定過「今天的問題單」預設要看哪個 Asana workspace/專案。找到就直接用，不用再問；找不到則回傳 needsInput，呼叫端要問使用者一次後呼叫 register_default_project。",
  {},
  async () => {
    const project = await resolveDefaultProject();
    if (project) return textResult({ found: true, ...project });
    return textResult({ found: false, needsInput: true });
  }
);

server.tool(
  "register_default_project",
  "登記「今天的問題單」預設要看的 Asana workspace/專案，之後使用者只要說類似「處理今天的問題單」，都不用再問要看哪個專案。",
  {
    workspaceGid: z.string().describe("Asana 工作區 gid"),
    projectGid: z.string().describe("Asana 專案 gid"),
    projectName: z.string().describe("Asana 專案名稱（用於顯示、也用於追蹤目錄命名）"),
  },
  async ({ workspaceGid, projectGid, projectName }) => {
    await registerDefaultProject({ workspaceGid, projectGid, projectName });
    return textResult({ success: true, workspaceGid, projectGid, projectName });
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

// ---------------------------------------------------------------------------
// Sandboxed file / shell tools (scoped to a caller-supplied projectDir)
// ---------------------------------------------------------------------------

function fsErrorResult(e: unknown) {
  if (e instanceof PathEscapeError) return textResult({ success: false, message: e.message }, true);
  return textResult({ success: false, message: e instanceof Error ? e.message : String(e) }, true);
}

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
    const result = await runShell(projectDir, command, gitRoots);
    return textResult(result, result.blocked === true);
  }
);

server.tool(
  "resolve_git_roots",
  "查詢這個專案目錄底下有沒有登記過 git 版控根目錄。找到就直接用，不用再問使用者；找不到的話，執行 git 相關指令（run_project_shell 裡的 git 指令）前必須先問使用者「前後端原始碼各自的 git 版控根目錄在哪裡」（分開的 repo 分別提供，共用同一個就提供一個），再呼叫 register_git_roots 登記。",
  { projectDir: z.string().describe("專案目錄絕對路徑") },
  async ({ projectDir }) => {
    const gitRoots = await resolveGitRoots(projectDir);
    return textResult(gitRoots ? { found: true, gitRoots } : { found: false, needsInput: true });
  }
);

server.tool(
  "register_git_roots",
  "登記某個專案目錄底下實際的 git 版控根目錄（可以是一個共用的，也可以是前後端分開的多個）。登記之後，run_project_shell 執行 git 指令時才會通過驗證。",
  {
    projectDir: z.string().describe("專案目錄絕對路徑"),
    gitRoots: z
      .array(z.object({ label: z.string().describe("這個 git 根目錄的用途標籤，例如「後端」「前端」「共用」"), path: z.string().describe("這個 git repo 的絕對路徑") }))
      .min(1)
      .describe("這個專案目錄底下實際的 git 版控根目錄清單，至少一筆"),
  },
  async ({ projectDir, gitRoots }) => {
    await registerGitRoots(projectDir, gitRoots as GitRootEntry[]);
    return textResult({ success: true, projectDir, gitRoots });
  }
);

// ---------------------------------------------------------------------------
// Ticket tracking store
// ---------------------------------------------------------------------------

server.tool(
  "get_ticket_status",
  "取得某張票單目前的追蹤狀態（stage / project_dir / verdict / history / summaries / self_confirmation / tester_confirmation / verifier_root_cause / consecutive_fail_count）。" +
    "**verdict 是 AI 驗證師自己判定的 PASS/FAIL，self_confirmation（第一關：使用者自己實測＋審視程式碼品質）跟 tester_confirmation（第二關／最終關：另一位獨立測試員的情境測試）才是真正結案要看的兩關人類確認——三者是不同軸向，verdict PASS 不代表任何一關也是 true**。self_confirmation 是 null 代表使用者還沒表態；tester_confirmation 是 null 代表還沒輪到或還沒表態，兩關都要 confirmed:true 才能當作這張票已經結案。" +
    "**verdict 是 \"FAIL\" 時，verifier_root_cause（\"analysis\"|\"implementation\"）是上次判斷的根因，回傳額外算出的 needs_human_review（consecutive_fail_count >= 3）是連續 FAIL 的安全閥旗標**——處理一張 FAIL 的票之前，先看 needs_human_review：false 才能依 verifier_root_cause 自動決定回工程師還是分析師，true 就不該再自動重跑，要停下來問使用者。" +
    "回傳裡額外附上 sync_flags（analysis_stale / implementation_stale）：任一個是 true，代表 01/02/03 這三份追蹤文件彼此之間有同步債務沒還——" +
    "例如工程師階段推翻了分析師的結論，但沒有回頭同步 01-analysis.md。**換 session/AI 接手一張票之前，一定要先看這個欄位**，是 true 就先把債務還清（把新發現同步回上一階段文件）再繼續往下走，不要當作沒看到。" +
    "**回傳裡也附上 external_changes（analysis_externally_modified / implementation_externally_modified / verification_externally_modified）**：這是每次呼叫都當場重新讀一次磁碟上 01/02/03-*.md 的實際內容、重新算雜湊比對出來的，不是快取值——任一個是 true，代表那份檔案在這個 MCP 不知情的狀況下被改過（使用者直接編輯、別的沒走這條 pipeline 的 AI 動過），對應的 summaries.* 快取摘要跟 sync_flags 判斷都可能已經過期，**要重新用 read_ticket_artifact 讀全文，不要只信快取**。這個工具本身不會自動修正，只負責告知；確認過內容沒問題、想把雜湊記錄同步回目前內容，呼叫 resync_ticket_artifact。",
  { taskGid: z.string().describe("Asana 任務 gid") },
  async ({ taskGid }) => {
    const status = await readStatus(taskGid);
    const externalChanges = await detectExternalChanges(taskGid, status);
    return textResult({
      ...status,
      sync_flags: computeSyncFlags(status),
      needs_human_review: needsHumanReview(status),
      external_changes: externalChanges,
    });
  }
);

server.tool(
  "record_self_confirmation",
  "記錄結案流程『第一關』——使用者自己對這張票的實測結果＋程式碼品質審視——跟 advance_ticket_stage 的 verdict（AI 驗證師自己判定的 PASS/FAIL）是完全不同的東西，不能混用。" +
    "AI 判 PASS 只代表「AI 自己檢查過、可以交給人測了」，不是真正結案；這一關過了（confirmed: true）之後，這張票才會從 list_pending_tickets 的 awaitingSelfConfirmation 清單移到 awaitingTesterConfirmation，等第二關（另一位獨立測試員）表態。" +
    "只能在這張票已經跑到 verified 階段之後才能呼叫（代表至少走過一次分析/實作/驗證），否則會被拒絕。" +
    "confirmed: false 代表使用者實際測過、發現有問題——會記錄下 note，並把這張票的 verdict 重設回 null，重新丟回 list_pending_tickets 的一般待處理清單（標記 humanRejected: true），讓 AI 用跟自己判 FAIL 完全一樣的根因分流機制去處理，不是丟給人工事後自己決定。",
  {
    taskGid: z.string().describe("Asana 任務 gid"),
    confirmed: z.boolean().describe("使用者自己實測＋審視程式碼品質是否通過：true = 沒問題可以交給第二關測試員，false = 發現問題"),
    note: z.string().nullable().optional().describe("備註，例如測了哪些情境、審視程式碼的發現、confirmed 是 false 時具體發現了什麼問題"),
  },
  async ({ taskGid, confirmed, note }) => {
    const current = await readStatus(taskGid);
    if (current.stage !== "verified") {
      return textResult(
        {
          success: false,
          message: `這張票目前 stage 是 "${current.stage}"，還沒跑到 verified 階段（至少要完成一次分析/實作/驗證），無法記錄使用者確認。`,
        },
        true
      );
    }
    const status = await recordSelfConfirmation(taskGid, confirmed, note ?? null);
    return textResult({ success: true, status });
  }
);

server.tool(
  "record_tester_confirmation",
  "記錄結案流程『第二關（最終關）』——另一位獨立測試員對這張票的情境測試結果——跟 advance_ticket_stage 的 verdict（AI 驗證師自己判定的 PASS/FAIL）、record_self_confirmation（第一關：使用者自己實測＋審視程式碼品質）都是完全不同的東西，不能混用。" +
    "只有呼叫這個工具記錄 confirmed: true，這張票才會從 list_pending_tickets 的 awaitingTesterConfirmation 清單裡消失、真正算結案。" +
    "只能在這張票已經跑到 verified 階段、且第一關（self_confirmation）已經 confirmed: true 之後才能呼叫，否則會被拒絕——不能跳過第一關直接記錄第二關。" +
    "confirmed: false 代表測試員實際測過、發現有問題——會記錄下 note，並把這張票的 verdict 重設回 null，重新丟回 list_pending_tickets 的一般待處理清單（標記 humanRejected: true），讓 AI 用跟自己判 FAIL 完全一樣的根因分流機制去處理，不是丟給人工事後自己決定。",
  {
    taskGid: z.string().describe("Asana 任務 gid"),
    confirmed: z.boolean().describe("測試員情境測試是否通過：true = 沒問題可以結案，false = 發現問題"),
    note: z.string().nullable().optional().describe("測試員的備註，例如測了哪些情境、confirmed 是 false 時具體發現了什麼問題"),
  },
  async ({ taskGid, confirmed, note }) => {
    const current = await readStatus(taskGid);
    if (current.stage !== "verified") {
      return textResult(
        {
          success: false,
          message: `這張票目前 stage 是 "${current.stage}"，還沒跑到 verified 階段（至少要完成一次分析/實作/驗證），無法記錄測試員確認。`,
        },
        true
      );
    }
    if (current.self_confirmation?.confirmed !== true) {
      return textResult(
        {
          success: false,
          message:
            "這張票的第一關（使用者自己實測＋審視程式碼品質，record_self_confirmation）還沒確認通過，不能跳過去記錄第二關的測試員確認。",
        },
        true
      );
    }
    const status = await recordTesterConfirmation(taskGid, confirmed, note ?? null);
    return textResult({ success: true, status });
  }
);

server.tool(
  "record_sasd_check",
  "記錄這張票單是否有對應的 SA/SD 規格文件。這是強制的一步：在寫入 01-analysis.md（分析師產出）之前，一定要先呼叫這個工具，否則 write_ticket_artifact 會拒絕寫入 01-analysis.md。",
  {
    taskGid: z.string().describe("Asana 任務 gid"),
    hasSasd: z.boolean().describe("這張票是否有對應的 SA/SD 規格文件"),
    sasdInfo: z.string().nullable().optional().describe("有的話，規格文件的路徑、連結或內容摘要；沒有可省略"),
  },
  async ({ taskGid, hasSasd, sasdInfo }) => {
    const status = await advanceStage(taskGid, (await readStatus(taskGid)).stage, {
      sasd_checked: true,
      sasd_info: hasSasd ? sasdInfo ?? "(使用者確認有 SA/SD 規格，但未提供詳細內容)" : null,
    });
    return textResult({ success: true, status });
  }
);

server.tool(
  "write_ticket_artifact",
  "把內容寫入某張票單的追蹤目錄底下的一個檔案（例如 01-analysis.md / 02-implementation.md / 03-verification.md）。" +
    "寫入 01-analysis.md 之前，這張票必須已經呼叫過 record_sasd_check，否則會被拒絕。" +
    "**filename 是 01-analysis.md / 02-implementation.md / 03-verification.md 之一時，一定要附上 summary**（2-4 條重點，控制在幾百字內，不是全文）——這段摘要會存進這張票的追蹤狀態，之後不管是同一個 session 還是換一個 session/AI 接手下一階段，都可以先用 get_ticket_status 用低成本讀到摘要，決定要不要再花額外的 tool call 讀 read_ticket_artifact 的全文。寫入 01-analysis.md 時，也會自動清掉這張票的 needs_reanalysis 標記（代表已經針對最新票單內容重新分析過）。" +
    `**filename 是 02-implementation.md 或 03-verification.md 時，syncNote 是必填、不能省略**：這次修改/驗證有沒有推翻或補充了上一階段（02 對應 01，03 對應 02）的結論？有的話把內容寫進 syncNote，會自動附加到上一階段文件尾端；真的沒有，也要明確帶入字串 "${NO_SYNC_NEEDED}"，不能什麼都不填直接跳過——這一步是強制的，逼你對「要不要同步」做一次明確判斷，不能船過水無痕，只是答案可以是「不需要」。沒帶這個參數會直接被拒絕寫入。` +
    "**filename 是 02-implementation.md 或 03-verification.md 時，manualActions 也是必填**（陣列，可以是空陣列）：這次有沒有任何事項是使用者必須自己手動處理的（例如產出的 SQL 只能交由使用者到 Database 工具執行、後台程式代號/選單/I18N 需自行設定）？有就列成一條條簡短字串；真的沒有就帶空陣列 []，不能省略——這些項目會被整理進持久化的 PENDING_HUMAN_ACTIONS.md，不能只寫在全文內容裡指望使用者自己重讀全文才發現。",
  {
    taskGid: z.string().describe("Asana 任務 gid"),
    filename: z.string().describe("檔名，例如 01-analysis.md"),
    content: z.string().describe("要寫入的內容（全文）"),
    summary: z
      .string()
      .nullable()
      .optional()
      .describe("這份內容的精簡摘要（2-4 條重點），filename 是 01/02/03-*.md 時務必提供，會存進追蹤狀態供之後低成本接手用"),
    syncNote: z
      .string()
      .nullable()
      .optional()
      .describe(
        `filename 是 02-implementation.md／03-verification.md 時必填。有新發現/結論變動就寫進這裡（會自動附加到上一階段文件）；` +
          `確認這次不需要同步，就帶入字串 "${NO_SYNC_NEEDED}"。留空／不帶會被拒絕寫入。`
      ),
    manualActions: z
      .array(z.string())
      .nullable()
      .optional()
      .describe(
        "filename 是 02-implementation.md／03-verification.md 時必填（陣列）。列出這次需要使用者手動處理的事項（例如「已產出 SQL，見內文，需自行到 Database 工具執行」）；" +
          "確認這次沒有，帶空陣列 []。留空／不帶會被拒絕寫入。"
      ),
  },
  async ({ taskGid, filename, content, summary, syncNote, manualActions }) => {
    if (filename === "01-analysis.md") {
      const status = await readStatus(taskGid);
      if (!status.sasd_checked) {
        return textResult(
          {
            success: false,
            message:
              "尚未確認這張票是否有 SA/SD 規格。請先想辦法確認（通常是問使用者），再呼叫 record_sasd_check({ taskGid, hasSasd, sasdInfo? }) 記錄結果，才能寫入 01-analysis.md。",
          },
          true
        );
      }
    }

    const needsSyncNote = filename === "02-implementation.md" || filename === "03-verification.md";
    if (needsSyncNote && (!syncNote || !syncNote.trim())) {
      const upstream = filename === "02-implementation.md" ? "01-analysis.md" : "02-implementation.md";
      return textResult(
        {
          success: false,
          message:
            `寫入 ${filename} 必須帶 syncNote：這次有沒有東西要同步回 ${upstream}？有就把內容寫進 syncNote，` +
            `真的沒有也要明確帶入字串 "${NO_SYNC_NEEDED}"，不能留空跳過這一步。`,
        },
        true
      );
    }
    if (needsSyncNote && !manualActions) {
      return textResult(
        {
          success: false,
          message: `寫入 ${filename} 必須帶 manualActions（陣列）：這次有沒有需要使用者手動處理的事項？有就列出來，真的沒有就帶空陣列 []，不能省略這個參數。`,
        },
        true
      );
    }

    if (needsSyncNote) {
      await recordStageSync(taskGid, filename as "02-implementation.md" | "03-verification.md", syncNote!.trim());
      await recordManualActions(taskGid, filename as "02-implementation.md" | "03-verification.md", manualActions!);
    }

    await writeArtifact(taskGid, filename, content);
    await recordArtifactHash(taskGid, filename, content);
    await recordArtifactSummary(taskGid, filename, summary);
    return textResult({ success: true, taskGid, filename });
  }
);

server.tool(
  "read_ticket_artifact",
  "讀取某張票單追蹤目錄底下的一個檔案內容（例如 ticket.md / 01-analysis.md）。",
  { taskGid: z.string().describe("Asana 任務 gid"), filename: z.string().describe("檔名，例如 ticket.md") },
  async ({ taskGid, filename }) => {
    const content = await readArtifact(taskGid, filename);
    return textResult({ success: content !== null, content });
  }
);

server.tool(
  "resync_ticket_artifact",
  "把 01-analysis.md／02-implementation.md／03-verification.md 其中一份檔案，現在磁碟上的實際內容重新雜湊、寫回 status.json 對應的 sync.*_hash 欄位。" +
    "**用在：這份檔案剛才是被直接用一般編輯工具（不是透過 write_ticket_artifact）手動改過的**——例如使用者跟另一個沒有走完整分析師/工程師/驗證師流程的 AI 直接對話改了內容。" +
    "呼叫這個工具不需要 syncNote、不會觸發任何角色階段、不會限制 stage，純粹只是「讓追蹤系統知道這份文件現在長這樣」，成本很低，不用為了同步一次手動修改去跑一整套正式流程。" +
    "**這個工具只更新雜湊記錄本身，不會幫你判斷這次手動修改在邏輯上對不對、跟其他階段兜不兜得起來**——呼叫它代表你自己已經確認過這次修改沒問題。" +
    "summary 是選填：這次手動修改如果多到連快取摘要都該換，可以順帶更新；不帶就只同步雜湊，摘要維持原樣。" +
    "**manualActions 也是選填（陣列）**：用在 `manualActions` 這個必填機制上線之前就已經寫過的舊 02/03 檔案——那些檔案裡可能藏著『SQL 待手動執行』『多國語系 I18N 需自行匯入』這類事項，但當時沒有結構化欄位可以宣告，全部散落在自由文字裡，`PENDING_HUMAN_ACTIONS.md` 抓不到。帶這個參數可以回填，讓舊票也正確出現在報告裡；只有 filename 是 02-implementation.md／03-verification.md 時才有意義（01 不支援）。",
  {
    taskGid: z.string().describe("Asana 任務 gid"),
    filename: z
      .enum(["01-analysis.md", "02-implementation.md", "03-verification.md"])
      .describe("要重新同步雜湊的檔名"),
    summary: z
      .string()
      .nullable()
      .optional()
      .describe("這次手動修改內容多到連快取摘要都該更新時才帶；不帶就只更新雜湊，摘要維持原樣"),
    manualActions: z
      .array(z.string())
      .nullable()
      .optional()
      .describe("回填這份文件裡藏著的人工待辦事項（只對 02-implementation.md／03-verification.md 有意義）；不帶就不動這個欄位，維持原樣"),
  },
  async ({ taskGid, filename, summary, manualActions }) => {
    const content = await readArtifact(taskGid, filename);
    if (content === null) {
      return textResult(
        { success: false, message: `找不到 ${filename}，這張票可能還沒走到會產生這份檔案的階段。` },
        true
      );
    }
    await recordArtifactHash(taskGid, filename, content);
    if (summary) await recordArtifactSummary(taskGid, filename, summary);
    if (manualActions && (filename === "02-implementation.md" || filename === "03-verification.md")) {
      await recordManualActions(taskGid, filename, manualActions);
    }
    return textResult({ success: true, taskGid, filename, message: "雜湊已同步為目前磁碟上的實際內容。" });
  }
);

server.tool(
  "advance_ticket_stage",
  "更新某張票單的追蹤狀態，記錄目前進行到哪個階段，並可以一併更新 project_dir / verdict。" +
    "**verdict 設成 \"FAIL\" 時，rootCause 是必填參數**（\"analysis\" 或 \"implementation\"）——判斷這次 FAIL 的根因在分析階段還是實作階段，供下一輪處理這張票時決定要自動跳回分析師還是工程師，不能省略。verdict 不是 \"FAIL\"（PASS，或這次沒有更新 verdict）時，不需要也不應該帶 rootCause，帶了會被拒絕。" +
    "**這個呼叫只要有更新 verdict，就會自動清空 self_confirmation/tester_confirmation**（這兩個人類確認是對上一輪程式碼/結論表態的，新 verdict 出爐代表結論已經更新，舊確認一律作廢，不能沿用）、並機械式維護 consecutive_fail_count（FAIL 累加、PASS 歸零，累加到 3 之後回傳的 needs_human_review 會是 true）。",
  {
    taskGid: z.string().describe("Asana 任務 gid"),
    stage: z
      .enum(["new", "snapshot", "project_dir_confirmed", "analyzed", "implemented", "verified"])
      .describe("要推進到的階段"),
    project_dir: z.string().nullable().optional().describe("這張票對應的專案目錄（有更新才需要帶）"),
    verdict: z.enum(["PASS", "FAIL"]).nullable().optional().describe("驗證結論（只有 verified 階段才需要帶）"),
    rootCause: z
      .enum(["analysis", "implementation"])
      .nullable()
      .optional()
      .describe("verdict 是 \"FAIL\" 時必填：這次 FAIL 的根因在分析階段還是實作階段。verdict 不是 \"FAIL\" 時不應該帶這個參數。"),
  },
  async ({ taskGid, stage, project_dir, verdict, rootCause }) => {
    if (verdict === "FAIL" && !rootCause) {
      return textResult(
        {
          success: false,
          message: `verdict 設成 "FAIL" 時必須帶 rootCause（"analysis" 或 "implementation"），判斷這次 FAIL 的根因在分析階段還是實作階段，不能省略。`,
        },
        true
      );
    }
    if (verdict !== undefined && verdict !== "FAIL" && rootCause) {
      return textResult(
        {
          success: false,
          message: `verdict 不是 "FAIL" 時不應該帶 rootCause，這個參數只在判定 FAIL 時才有意義。`,
        },
        true
      );
    }
    const patch: Partial<TicketStatus> = {};
    if (project_dir !== undefined) patch.project_dir = project_dir;
    if (verdict !== undefined) patch.verdict = verdict;
    if (verdict === "FAIL") patch.verifier_root_cause = rootCause;
    const status = await advanceStage(taskGid, stage, patch);
    return textResult({ success: true, status, needs_human_review: needsHumanReview(status) });
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

process.on("exit", () => {
  void closeChildMcpClients();
});

main().catch((err) => {
  console.error("asana-pipeline-mcp failed to start:", err);
  process.exit(1);
});
