import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callAsanaTool } from "./mcp-clients.js";
import { resolveProjectDir } from "./project-registry.js";
import { readProjectSettings } from "./project-rule-files.js";
import {
  readStatus,
  peekStatus,
  advanceStage,
  recordConfirmation,
  recordSpecConfirmation,
  needsHumanReview,
  describeSdSkip,
  computeSyncFlags,
  detectExternalChanges,
  resolveManualAction,
  requestReanalysis,
  writePendingActionsReport,
  readArtifact,
  resolveTicketDir,
  type TicketStatus,
  type ExternalChangeFlags,
  type ManualActionItem,
} from "./pipeline-store.js";
import { syncPendingActionsReport, getPipelineAsanaUserGid, getUncommittedChangesSummary, filterOutGitCommitActions } from "./pending-actions-sync.js";
import { textResult } from "./shared.js";
import { checkTestEvidenceForTested, findStaleEvidenceBackups, summarizeTestEvidence } from "./test-evidence-store.js";
import { filterAndLimitTickets, localDateString, detectTicketNumber, DUE_ON_DATE_PATTERN } from "./ticket-list-filter.js";
import { computeNextAction } from "./next-action.js";
import { sasdForStatus, statusResponse, verboseParam } from "./stage-response.js";
import { createBoardFetcher } from "./board-cache.js";

const fetchBoard = createBoardFetcher({ call: callAsanaTool, now: Date.now });

export function registerTicketLifecycleTools(server: McpServer): void {
  server.tool(
    "list_pending_tickets",
    "列出 Asana 專案尚未完成的票單（onlyAssignedToMe 或專案 .pipeline/settings.json 可限制只列指派給本人的）。帶 projectName（建議每次都帶）時一併把「需人工處理」項目覆寫進 `<projectDir>/.asana-pipeline/<projectName>/PENDING_HUMAN_ACTIONS.html`。\n" +
      "回傳：\n" +
      "- `tickets`：待處理。`contentChanged:true`=Asana 內容又變了，用 get_ticket_snapshot 判斷是否重分析；`humanRequestedReanalysis:true`=使用者要求優先，**一定先對它呼叫 get_ticket_snapshot**；`humanRejected:true`=使用者打回（依 rootCause 分流）；`specRejected:true`=規格草稿被打回。\n" +
      "- `awaitingConfirmation`／`awaitingSpecConfirmation`（僅 self-generated）：等使用者確認（record_confirmation／record_spec_confirmation），**每次呼叫都要完整秀給使用者**。\n" +
      "- `manualActions`／`uncommittedChanges` 互斥：有檔名的「尚未 commit」只在 `uncommittedChanges`（`registered:false`=尚未登記 git_roots）。\n" +
      "Asana 資料 60 秒內用快取，要最新帶 refresh:true。",
    {
      projectGid: z.string().describe("Asana 專案 gid"),
      sectionFilter: z.string().nullable().optional().describe("只取此 section 的任務；不指定=全部"),
      projectName: z
        .string()
        .nullable()
        .optional()
        .describe("Asana 專案「全名稱」；有帶才寫報告檔"),
      onlyAssignedToMe: z
        .boolean()
        .nullable()
        .optional()
        .describe(
          "true=只列指派給目前 Asana 帳號的票；false=全部。沒帶時看專案 .pipeline/settings.json，都沒有=false"
        ),
      dueOn: z
        .union([z.enum(["today", "overdue", "today_or_overdue"]), z.string().regex(DUE_ON_DATE_PATTERN)])
        .nullable()
        .optional()
        .describe("過濾 `tickets`：today／overdue／today_or_overdue／YYYY-MM-DD（無到期日的排除）"),
      search: z
        .string()
        .nullable()
        .optional()
        .describe("過濾 `tickets`：票號完全相等或標題包含此字串（不分大小寫）。帶 search 時 manualActions 明細會省略（只留 manualActionsCount）"),
      limit: z
        .number()
        .int()
        .positive()
        .nullable()
        .optional()
        .describe("限制 `tickets` 筆數（到期日由早到晚）；超過會附 totalMatched／truncated"),
      refresh: z.boolean().nullable().optional().describe("true=強制重抓 Asana"),
    },
    async ({ projectGid, sectionFilter, projectName, onlyAssignedToMe, dueOn, search, limit, refresh }) => {
      const { board, fromCache, ageSeconds } = await fetchBoard(projectGid, { forceRefresh: refresh === true });
      if (!board?.success) return textResult(board, true);

      let onlyMine = onlyAssignedToMe ?? null;
      if (onlyMine === null) {
        const settingsProjectDir = await resolveProjectDir(projectGid);
        if (settingsProjectDir) {
          try {
            onlyMine = (await readProjectSettings(settingsProjectDir)).onlyAssignedToMe ?? false;
          } catch (err: any) {
            return textResult({ success: false, message: err.message }, true);
          }
        }
      }
      const tasks: any[] = Array.isArray(board.tasks) ? board.tasks : [];
      const pipelineUserGid = await getPipelineAsanaUserGid();
      if (onlyMine && !pipelineUserGid) {
        return textResult({ success: false, message: "要求只列指派給我的票，但無法判斷目前 Asana 帳號是誰（asana_me 失敗），為避免列出不該處理的票，這次不繼續。" }, true);
      }
      let skippedNotMine = 0;
      const pending = [];
      const awaitingConfirmation = [];
      const awaitingSpecConfirmation = [];
      const needsHumanReviewList = [];
      const manualActionsList = [];
      const contentChangedList = [];
      const contentChangedForReport = [];
      for (const task of tasks) {
        if (task.completed === true) continue;
        if (onlyMine && (task.assignee?.gid ?? null) !== pipelineUserGid) {
          skippedNotMine++;
          continue;
        }
        if (sectionFilter) {
          const sectionNames = (task.memberships ?? []).map((m: any) => m.section?.name);
          if (!sectionNames.includes(sectionFilter)) continue;
        }
        const status = await peekStatus(task.gid);

        // 人工手動待辦跟連續 FAIL 安全閥，不管這張票目前卡在哪個分流，都要獨立檢查一次——不能只在某個分支裡順便處理。
        // 每一項要帶上它是哪一份文件宣告的（filename），resolve_manual_action／互動版報告的勾選按鈕都要靠這個精準比對。
        const manualActions: ManualActionItem[] = [
          ...status.implementation_manual_actions.map((text: string) => ({ filename: "02-implementation.md" as const, text })),
          ...status.verification_manual_actions.map((text: string) => ({ filename: "03-verification.md" as const, text })),
          ...status.test_manual_actions.map((text: string) => ({ filename: "04-test.md" as const, text })),
        ];
        if (manualActions.length > 0) {
          manualActionsList.push({ taskGid: task.gid, name: task.name, actions: manualActions });
        }
        if (
          (status.stage === "verified" || status.stage === "tested") &&
          status.verdict === "FAIL" &&
          needsHumanReview(status)
        ) {
          needsHumanReviewList.push({ taskGid: task.gid, name: task.name, consecutiveFailCount: status.consecutive_fail_count });
        }

        // 規格先定案關卡（只有走過 sd_drafted 的票——即 sdMode: "self-generated"——才會落到這裡）：
        // 草稿還沒表態，代表工程師階段還不能開始，這張票整個先不進一般 pending 清單，改列進專屬清單提醒使用者去確認。
        if (status.stage === "sd_drafted" && status.spec_confirmation === null) {
          awaitingSpecConfirmation.push({ taskGid: task.gid, name: task.name, dueOn: task.due_on });
          continue;
        }

        // 測試工程師階段（"tested"）是 verified 之後、人類確認之前的最後一道 AI 關卡——只有走到這裡 PASS，
        // 才算 AI 這邊全部檢查完，可以進入 awaitingConfirmation 交給使用者最終確認。
        const isTestedPass = status.stage === "tested" && status.verdict === "PASS";
        const boardModifiedAt: string | null = task.modified_at ?? null;
        const contentChanged =
          isTestedPass &&
          !!boardModifiedAt &&
          !!status.last_seen_modified_at &&
          boardModifiedAt !== status.last_seen_modified_at;

        if (isTestedPass && !contentChanged) {
          // AI 已判 PASS 且內容沒再變——但這不等於「真正結案」，要看使用者自己這關有沒有確認過。
          if (status.confirmation?.confirmed === true) continue; // 確認過沒問題，才算真的結案
          awaitingConfirmation.push({
            taskGid: task.gid,
            name: task.name,
            dueOn: task.due_on,
            confirmation: status.confirmation,
          });
          continue;
        }

        const isContentChanged = contentChanged || status.needs_reanalysis;
        // 使用者在網頁上主動勾了「請 AI 優先處理」——跟 isContentChanged 是不同軸向（那是 AI 自己偵測到
        // 的），這個純粹是使用者的請求，即使 needs_reanalysis 還是 false 也要顯示、也要被當作優先事項。
        const humanRequested = !!status.human_requested_reanalysis;
        const showAsChanged = isContentChanged || humanRequested;
        pending.push({
          taskGid: task.gid,
          name: task.name,
          ...(detectTicketNumber(task) ? { ticketNumber: detectTicketNumber(task) } : {}),
          dueOn: task.due_on,
          stage: status.stage,
          ...(showAsChanged ? { contentChanged: true } : {}),
          ...(humanRequested ? { humanRequestedReanalysis: true } : {}),
          ...(status.confirmation?.confirmed === false ? { humanRejected: true } : {}),
          ...(status.stage === "sd_drafted" && status.spec_confirmation?.confirmed === false ? { specRejected: true } : {}),
        });
        if (showAsChanged) {
          contentChangedList.push({ taskGid: task.gid, name: task.name, stage: status.stage, ...(humanRequested ? { humanRequested: true } : {}) });
        }
        // 「Asana 內容已被異動，待重新確認」這個持久化報告區塊只列「指派人剛好是這個 pipeline 帳號本人」的
        // 票單——票單狀態常在不同人之間流轉，內容變了但不是指派給這個帳號的票單與使用者無關，不冒出來打擾。
        // 這條沒有例外：就算曾被勾過「請 AI 優先處理」，轉手給別人之後也不再顯示（旗標本身還在，AI 照樣會從
        // `tickets[].humanRequestedReanalysis` 看到並處理）。上面的 `contentChangedList`（回傳給呼叫端的 JSON 欄位，
        // `pending[].contentChanged` 也是）不受這條限制，用途不同（提醒 AI「這份舊分析可能已經過期，
        // 用之前先看一眼」，跟該不該寫進報告通知人類是兩回事）。
        const assigneeGid: string | null = task.assignee?.gid ?? null;
        if (showAsChanged && pipelineUserGid !== null && assigneeGid === pipelineUserGid) {
          contentChangedForReport.push({ taskGid: task.gid, name: task.name, stage: status.stage, ...(humanRequested ? { humanRequested: true } : {}) });
        }
      }

      const manualActionsForReport = filterOutGitCommitActions(manualActionsList);

      let pendingActionsReportPath: string | null = null;
      let uncommittedChanges: Awaited<ReturnType<typeof getUncommittedChangesSummary>> | null = null;
      if (projectName) {
        const projectDir = await resolveProjectDir(projectGid);
        if (projectDir) {
          uncommittedChanges = await getUncommittedChangesSummary(projectDir, manualActionsList);
          pendingActionsReportPath = await writePendingActionsReport(projectDir, projectName, {
            awaitingSpecConfirmation,
            awaitingConfirmation,
            needsHumanReview: needsHumanReviewList,
            contentChanged: contentChangedForReport,
            manualActions: manualActionsForReport,
            uncommittedChanges,
          });
        }
      }

      const searchText = typeof search === "string" && search.trim() ? search.trim() : null;
      const hasListFilter = dueOn != null || limit != null || searchText !== null;
      const listed = filterAndLimitTickets(pending, { dueOn, search: searchText, limit, today: localDateString() });

      return textResult({
        success: true,
        projectGid,
        count: listed.tickets.length,
        ...(onlyMine ? { filteredBy: "assignee=me", skippedNotAssignedToMe: skippedNotMine } : {}),
        ...(hasListFilter
          ? {
              filters: { ...(dueOn != null ? { dueOn } : {}), ...(searchText !== null ? { search: searchText } : {}), ...(limit != null ? { limit } : {}) },
              totalMatched: listed.totalMatched,
              ...(listed.truncated ? { truncated: true, truncatedNote: listed.truncatedNote } : {}),
            }
          : {}),
        ...(searchText !== null && listed.tickets.length === 0
          ? { searchNote: `沒有任何待處理票單符合 search="${searchText}"（票號需完全相等，或標題包含此字串）；已完成或不在 pending 清單的票不會出現在這裡，其他清單不受影響。` }
          : {}),
        tickets: listed.tickets,
        awaitingConfirmationCount: awaitingConfirmation.length,
        awaitingConfirmation,
        awaitingSpecConfirmationCount: awaitingSpecConfirmation.length,
        awaitingSpecConfirmation,
        needsHumanReviewCount: needsHumanReviewList.length,
        needsHumanReview: needsHumanReviewList,
        contentChangedCount: contentChangedList.length,
        contentChangedList,
        manualActionsCount: manualActionsForReport.length,
        ...(searchText !== null
          ? manualActionsForReport.length > 0
            ? { manualActionsOmittedNote: "帶 search 時省略各票待辦明細以節省上下文（數量見 manualActionsCount）；要看明細請不帶 search，或看報告網頁。" }
            : {}
          : { manualActions: manualActionsForReport }),
        ...(uncommittedChanges ? { uncommittedChanges } : {}),
        ...(pendingActionsReportPath ? { pendingActionsReportPath } : {}),
        ...(fromCache ? { boardFromCache: true, boardAgeSeconds: ageSeconds } : {}),
      });
    }
  );

  server.tool(
    "get_ticket_status",
    "取得票單追蹤狀態（stage / project_dir / verdict / history / summaries / confirmation / spec_confirmation / verifier_root_cause / consecutive_fail_count）。\n" +
      "- **verdict 是 AI 驗證師的 PASS/FAIL，confirmation 是使用者實測確認，兩者不同軸**：confirmation 要 confirmed:true 才算結案。\n" +
      "- spec_confirmation 僅 sdMode \"self-generated\"：null 時 advance_ticket_stage 被擋。\n" +
      "- **needs_human_review（consecutive_fail_count >= 3）為 true 就停下問使用者，不要自動重跑**；verifier_root_cause 是上次 FAIL 根因。\n" +
      "- sync_flags 為 true=01/02/03 有同步債，**接手前先還清**。\n" +
      "- external_changes 的 *_externally_modified 為 true=檔案被外部改過，summaries 與 sync_flags 可能過期，**要 read_ticket_artifact 讀全文**，確認後 resync_ticket_artifact。\n" +
      "- nextAction：依狀態算出的下一步，與工具實際把關一致，優先照做。",
    {
      taskGid: z.string().describe("任務 gid"),
      verbose: z.boolean().nullable().optional().describe("true=回完整 status（含 history）；預設精簡"),
    },
    async ({ taskGid, verbose }) => {
      const status = await readStatus(taskGid);
      const { history: _history, sync: _sync, ...slimStatus } = status;
      const base = verbose ? status : slimStatus;
      const externalChanges = await detectExternalChanges(taskGid, status);
      const syncFlags = computeSyncFlags(status);
      const sasd = await sasdForStatus(status);
      const evidenceSummary = summarizeTestEvidence(status);
      const stale = status.test_evidence.length > 0 ? await findStaleEvidenceBackups(status, await resolveTicketDir(taskGid)).catch(() => []) : [];
      const sdSkipNotice = describeSdSkip(status.spec_confirmation);
      return textResult({
        ...base,
        ...(sdSkipNotice ? { spec_confirmation: { ...status.spec_confirmation, sdSkipNotice } } : {}),
        test_evidence: stale.length > 0
          ? { ...evidenceSummary, stale_old_backups: { count: stale.length, paths: stale, hint: "有未清理的舊備份，請關閉開啟中的檔案後重新呼叫 record_test_evidence（同功能名稱與原檔名）" } }
          : evidenceSummary,
        sync_flags: syncFlags,
        needs_human_review: needsHumanReview(status),
        external_changes: externalChanges,
        nextAction: computeNextAction(status, { syncFlags, externalChanges, sasd }),
      });
    }
  );

  server.tool(
    "record_confirmation",
    "記錄結案前唯一一關人類確認（使用者自己實測＋審視程式碼品質），與 advance_ticket_stage 的 verdict（AI 驗證師）不同。" +
      "只有 confirmed: true 才真正結案，且只能在已到 tested 階段後呼叫，否則被拒絕。" +
      "confirmed: false=使用者測出問題：記下 note、verdict 重設為 null，票單回一般清單（humanRejected: true），走與 AI 判 FAIL 相同的根因分流。" +
      "呼叫後自動重寫報告；verbose:true 取完整狀態。",
    {
      taskGid: z.string().describe("任務 gid"),
      confirmed: z.boolean().describe("使用者實測＋審視程式碼是否通過：true=結案，false=有問題"),
      note: z.string().nullable().optional().describe("備註：測了哪些情境、審視發現；confirmed=false 時寫具體問題"),
      verbose: verboseParam,
    },
    async ({ taskGid, confirmed, note, verbose }) => {
      const current = await readStatus(taskGid);
      if (current.stage !== "tested") {
        return textResult(
          {
            success: false,
            message: `這張票目前 stage 是 "${current.stage}"，還沒跑到 tested 階段（至少要完成一次分析/實作/驗證/測試），無法記錄使用者確認。`,
          },
          true
        );
      }
      const status = await recordConfirmation(taskGid, confirmed, note ?? null);
      await syncPendingActionsReport(taskGid);
      return statusResponse(taskGid, status, verbose);
    }
  );

  server.tool(
    "record_spec_confirmation",
    "記錄「規格草稿定案」確認，僅 sdMode \"self-generated\"（與 record_confirmation 獨立），一般只能在 \"sd_drafted\" 後呼叫。" +
      "confirmed: true=解鎖下一步（spec_first 到 implemented；code_first 到 verified）。confirmed: false=記下 note，stage 維持 sd_drafted（specRejected: true），規格撰寫者修改後重新 advance_ticket_stage({ stage: \"sd_drafted\" })。" +
      "**sdNotRequired: true=使用者明確表示本票不需要 SD**：userInstruction 必填（使用者原話或原意），可在 \"analyzed\" 或 \"sd_drafted\" 呼叫、僅 self-generated。**AI 不可自行提議或決定略過 SD**，沒有使用者明確表示不得使用；不確定先問。紀錄供稽核。verbose:true 取完整狀態。",
    {
      taskGid: z.string().describe("任務 gid"),
      confirmed: z.boolean().describe("規格草稿是否可動手寫程式碼：true=可以，false=要修改。sdNotRequired 為 true 時必須是 true"),
      note: z.string().nullable().optional().describe("備註；confirmed=false 時具體說明哪裡要改"),
      sdNotRequired: z.boolean().nullable().optional().describe("true=使用者明確表示本票不需要 SD。必須同時帶 userInstruction；絕不可由 AI 自行決定。"),
      userInstruction: z.string().nullable().optional().describe("sdNotRequired=true 時必填：使用者表示不需要 SD 的原話或原意，原文記錄供稽核"),
      verbose: verboseParam,
    },
    async ({ taskGid, confirmed, note, sdNotRequired, userInstruction, verbose }) => {
      const current = await readStatus(taskGid);
      if (sdNotRequired === true) {
        const instruction = (userInstruction ?? "").trim();
        if (!instruction) {
          return textResult(
            { success: false, message: "sdNotRequired: true 必須帶 userInstruction（使用者表示本票不需要 SD 的原話或原意，不可空白）。AI 不可自行決定略過 SD；若不確定使用者是否同意，請先問他。" },
            true
          );
        }
        if (confirmed !== true) {
          return textResult({ success: false, message: "sdNotRequired: true 時 confirmed 必須是 true。" }, true);
        }
        if (current.stage !== "analyzed" && current.stage !== "sd_drafted") {
          return textResult(
            { success: false, message: `這張票目前 stage 是 "${current.stage}"，sdNotRequired 只能在 "analyzed" 或 "sd_drafted" 階段記錄。` },
            true
          );
        }
        const sasd = await sasdForStatus(current);
        if (!sasd) {
          return textResult(
            { success: false, message: "查不到這張票所屬專案的 SA/SD 設定（status 沒有 project_gid 或專案未登記），無法確認 sdMode 是否為 self-generated，不能記錄 sdNotRequired。" },
            true
          );
        }
        if (sasd.sdMode !== "self-generated") {
          return textResult(
            { success: false, message: `這個專案的 sdMode 是 "${sasd.sdMode}"，不是 "self-generated"，不需要也不能記錄 sdNotRequired（只有 self-generated 專案才有規格確認關卡）。` },
            true
          );
        }
        const skipped = await recordSpecConfirmation(taskGid, true, instruction, true);
        await syncPendingActionsReport(taskGid);
        return statusResponse(taskGid, skipped, verbose);
      }
      if (current.stage !== "sd_drafted") {
        return textResult(
          {
            success: false,
            message: `這張票目前 stage 是 "${current.stage}"，還沒推進到 "sd_drafted"（規格撰寫者尚未產出草稿），無法記錄規格確認。`,
          },
          true
        );
      }
      const status = await recordSpecConfirmation(taskGid, confirmed, note ?? null);
      await syncPendingActionsReport(taskGid);
      return statusResponse(taskGid, status, verbose);
    }
  );

  server.tool(
    "record_sasd_check",
    "記錄這張票單是否有對應的 SA/SD 規格文件。強制：寫入 01-analysis.md 前一定要先呼叫，否則 write_ticket_artifact 拒絕寫入。verbose:true 取完整狀態。",
    {
      taskGid: z.string().describe("任務 gid"),
      hasSasd: z.boolean().describe("這張票是否有對應的 SA/SD 規格文件"),
      sasdInfo: z.string().nullable().optional().describe("有的話：規格文件路徑、連結或摘要"),
      verbose: verboseParam,
    },
    async ({ taskGid, hasSasd, sasdInfo, verbose }) => {
      const status = await advanceStage(taskGid, (await readStatus(taskGid)).stage, {
        sasd_checked: true,
        sasd_info: hasSasd ? sasdInfo ?? "(使用者確認有 SA/SD 規格，但未提供詳細內容)" : null,
      });
      return statusResponse(taskGid, status, verbose);
    }
  );

  server.tool(
    "resolve_manual_action",
    "移除 manualActions 裡『使用者確認已處理完』的一項（其餘保留），用在使用者說某項手動待辦（SQL、I18N 匯入等）做完了。" +
      "**`action` 要與 get_ticket_status/list_pending_tickets 的 manualActions 文字一字不差**（前後空白忽略）；找不到時回傳 success:false 與目前清單，核對後重試，不要憑印象猜。移除後自動重寫報告。",
    {
      taskGid: z.string().describe("任務 gid"),
      filename: z
        .enum(["02-implementation.md", "03-verification.md", "04-test.md"])
        .describe("該待辦由哪份文件宣告（工程師 02、驗證師 03、測試工程師 04）"),
      action: z.string().describe("要移除的事項完整文字（從 manualActions 複製）"),
    },
    async ({ taskGid, filename, action }) => {
      const result = await resolveManualAction(taskGid, filename, action);
      if (!result.removed) {
        return textResult(
          {
            success: false,
            message: "找不到完全符合的事項，沒有任何變動。以下是這份文件目前宣告的完整清單，請核對文字後再試一次：",
            currentActions: result.remaining,
          },
          true
        );
      }
      await syncPendingActionsReport(taskGid);
      return textResult({ success: true, taskGid, filename, remaining: result.remaining });
    }
  );

  server.tool(
    "request_reanalysis",
    "標記某票「使用者要求優先重新確認」（human_requested_reanalysis），純資料操作、不會自己觸發分析。" +
      "用在使用者要求標記，或 PENDING_HUMAN_ACTIONS.html 勾選按鈕背後的呼叫。**呼叫完你自己應直接接著對這張票呼叫 get_ticket_snapshot**；旗標是留給之後連上的其他 AI/session 看的，不是延後處理的藉口。自動重寫報告；verbose:true 取完整狀態。",
    {
      taskGid: z.string().describe("任務 gid"),
      verbose: verboseParam,
    },
    async ({ taskGid, verbose }) => {
      const status = await requestReanalysis(taskGid);
      await syncPendingActionsReport(taskGid);
      return statusResponse(taskGid, status, verbose, { taskGid });
    }
  );

  server.tool(
    "advance_ticket_stage",
    "更新票單追蹤階段，可一併更新 project_dir / verdict。" +
      "推進到 project_dir_confirmed/analyzed/implemented/verified/tested 前會檢查證據：project_dir 已確定，或 01/02/03/04-*.md 已用 write_ticket_artifact 寫入非空內容；缺少或被外部改過會被拒絕，後者須先 read_ticket_artifact 再 resync_ticket_artifact。verdict 只能在 verified／tested 帶。" +
      "**verdict 設 \"FAIL\" 時 rootCause 必填**；非 FAIL 不可帶 rootCause。" +
      "tested 的 verdict 規則同 verified：只有 AI 有把握的 verified_fail 才算 FAIL，needs_manual_check 不影響（見 get_role_prompt({role:\"tester\"})）。" +
      "更新 verdict 會清空 confirmation，並維護 consecutive_fail_count（FAIL 累加、PASS 歸零，達 3 時 needs_human_review 為 true）。verbose:true 取完整狀態。",
    {
      taskGid: z.string().describe("任務 gid"),
      stage: z
        .enum(["new", "snapshot", "project_dir_confirmed", "analyzed", "sd_drafted", "implemented", "verified", "tested"])
        .describe(
          "目標階段。\"sd_drafted\" 僅 sdMode \"self-generated\" 需要（spec_first：analyzed 後；code_first：implemented 後）。\"tested\" 在 verified 之後（測試工程師），每張票都要經過。"
        ),
      project_dir: z.string().nullable().optional().describe("票單對應的專案目錄（有更新才帶）"),
      verdict: z.enum(["PASS", "FAIL"]).nullable().optional().describe("驗證結論（僅 verified／tested 可帶，其他階段會被拒絕）"),
      rootCause: z
        .enum(["analysis", "implementation"])
        .nullable()
        .optional()
        .describe("verdict=\"FAIL\" 時必填：根因在分析或實作階段；非 FAIL 不可帶"),
      verbose: verboseParam,
    },
    async ({ taskGid, stage, project_dir, verdict, rootCause, verbose }) => {
      if (verdict != null && stage !== "verified" && stage !== "tested") {
        return textResult(
          {
            success: false,
            message: `verdict 只有推進到 "verified" 或 "tested" 階段時才有意義，不能在 "${stage}" 階段帶 verdict（目前帶了 "${verdict}"）。請移除 verdict 參數，或改在驗證師／測試工程師階段記錄。`,
          },
          true
        );
      }
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

      // 防止跳過某個角色就直接宣告推進到後面的階段（例如只做完工程師改動就想直接標成 verified）：
      // 每個階段要求對應的產出文件已經透過 write_ticket_artifact 寫入非空內容，不能只改 stage 欄位就過關。
      const STAGE_ARTIFACT_REQUIREMENT: Partial<Record<TicketStatus["stage"], string>> = {
        analyzed: "01-analysis.md",
        implemented: "02-implementation.md",
        verified: "03-verification.md",
        tested: "04-test.md",
      };
      const ARTIFACT_EXTERNAL_FLAG: Record<string, keyof ExternalChangeFlags> = {
        "01-analysis.md": "analysis_externally_modified",
        "02-implementation.md": "implementation_externally_modified",
        "03-verification.md": "verification_externally_modified",
        "04-test.md": "test_externally_modified",
      };
      const requiredArtifact = STAGE_ARTIFACT_REQUIREMENT[stage];
      if (requiredArtifact) {
        const artifactContent = await readArtifact(taskGid, requiredArtifact);
        const externalChanges = await detectExternalChanges(taskGid, await readStatus(taskGid));
        if (externalChanges[ARTIFACT_EXTERNAL_FLAG[requiredArtifact]]) {
          return textResult(
            {
              success: false,
              message: `${requiredArtifact} 的目前內容與 MCP 記錄的雜湊不符（_externally_modified：被使用者直接編輯或別的流程繞過 write_ticket_artifact 改過），不能推進到 "${stage}" 階段。請先呼叫 read_ticket_artifact 檢視全文確認內容無誤，再呼叫 resync_ticket_artifact({ taskGid, filename: "${requiredArtifact}" }) 同步雜湊後重試。`,
            },
            true
          );
        }
        if (!artifactContent || !artifactContent.trim()) {
          return textResult(
            {
              success: false,
              message: `這張票還沒有 ${requiredArtifact} 的內容（尚未呼叫 write_ticket_artifact 寫入非空內容），不能推進到 "${stage}" 階段——這份文件是實際完成該階段工作的證據，不能只更新 stage 卻沒有對應的分析/實作/驗證產出。`,
            },
            true
          );
        }
      }

      // tested：每張票都要有測試證據與 testLevel；宣告有產出 Excel/PDF 時還要有 excel/pdf 證據。
      if (stage === "tested") {
        const reason = checkTestEvidenceForTested(await readStatus(taskGid));
        if (reason) return textResult({ success: false, message: reason }, true);
      }

      // 這張票目前卡在 sd_drafted（sdMode: "self-generated"）的話，規格草稿必須先經過使用者確認，才能繼續往下推進——
      // 不管這次要推進到的是哪個階段。這個 gate 刻意只看「目前是不是卡在 sd_drafted 又沒確認」，不用另外查 specOrder：
      // - specOrder "spec_first"：sd_drafted 發生在 implemented 之前，所以卡住的是「推進到 implemented」這一步；
      // - specOrder "code_first"：sd_drafted 發生在 implemented 之後（工程師先寫完 code，規格撰寫者才依實作反推補一份 SD），
      //   所以卡住的是「推進到 verified」這一步——同一個 gate、同一個判斷式，剛好對到不同的目標階段。
      // 沒走過 sd_drafted 的票（其他 sdMode，直接從 analyzed 推進過來）不受這條限制，維持原有行為。
      if (stage === "implemented" || stage === "verified") {
        const currentForSpecGate = await readStatus(taskGid);
        if (currentForSpecGate.stage === "sd_drafted" && currentForSpecGate.spec_confirmation?.confirmed !== true) {
          return textResult(
            {
              success: false,
              message:
                `這張票的 SD 規格草稿還沒經過使用者確認（spec_confirmation.confirmed 不是 true），不能推進到 "${stage}"。` +
                `請先等使用者呼叫 record_spec_confirmation 確認這份草稿，或依打回意見修改草稿後重新呼叫 advance_ticket_stage({ stage: "sd_drafted" })。`,
            },
            true
          );
        }
      }

      // self-generated 專案：沒有使用者確認過的 SD 草稿（或使用者明確表示不需要 SD）就不能越過規格關卡。
      // spec_first 擋在 implemented，code_first 擋在 verified；其他 sdMode 與查不到專案設定的票維持原有行為。
      if (stage === "implemented" || stage === "verified") {
        const currentForSdMode = await readStatus(taskGid);
        if (currentForSdMode.spec_confirmation?.confirmed !== true) {
          const sasd = await sasdForStatus(currentForSdMode);
          const gatedStage = sasd?.specOrder === "code_first" ? "verified" : "implemented";
          if (sasd?.sdMode === "self-generated" && stage === gatedStage) {
            return textResult(
              {
                success: false,
                message:
                  `這個專案的 sdMode 是 "self-generated"（specOrder: ${sasd.specOrder}），推進到 "${stage}" 前必須先有使用者確認過的 SD 規格草稿：` +
                  `請規格撰寫者產出草稿並 advance_ticket_stage({ stage: "sd_drafted" })，等使用者 record_spec_confirmation；` +
                  `或使用者明確表示本票不需要 SD 時，才帶使用者原話呼叫 record_spec_confirmation({ sdNotRequired: true, userInstruction })。AI 不可自行略過。`,
              },
              true
            );
          }
        }
      }

      if (stage === "project_dir_confirmed") {
        const current = await readStatus(taskGid);
        const resolvedProjectDir = project_dir ?? current.project_dir;
        if (!resolvedProjectDir) {
          return textResult(
            {
              success: false,
              message: `推進到 "project_dir_confirmed" 階段時必須確定 project_dir（可以這次呼叫時一併帶入，或這張票先前已經設定過），不能是空值。`,
            },
            true
          );
        }
      }

      const patch: Partial<TicketStatus> = {};
      if (project_dir !== undefined) patch.project_dir = project_dir;
      if (verdict !== undefined) patch.verdict = verdict;
      if (verdict === "FAIL") patch.verifier_root_cause = rootCause;
      const status = await advanceStage(taskGid, stage, patch);
      await syncPendingActionsReport(taskGid);
      return statusResponse(taskGid, status, verbose, { needs_human_review: needsHumanReview(status) });
    }
  );
}
