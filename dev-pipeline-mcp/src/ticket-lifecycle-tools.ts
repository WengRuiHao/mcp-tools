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
  computeSyncFlags,
  detectExternalChanges,
  resolveManualAction,
  requestReanalysis,
  writePendingActionsReport,
  readArtifact,
  type TicketStatus,
  type ManualActionItem,
} from "./pipeline-store.js";
import { syncPendingActionsReport, getPipelineAsanaUserGid, getUncommittedChangesSummary, filterOutGitCommitActions } from "./pending-actions-sync.js";
import { textResult } from "./shared.js";
import { filterAndLimitTickets, localDateString, DUE_ON_DATE_PATTERN } from "./ticket-list-filter.js";
import { computeNextAction } from "./next-action.js";
import { createBoardFetcher } from "./board-cache.js";

const fetchBoard = createBoardFetcher({ call: callAsanaTool, now: Date.now });

export function registerTicketLifecycleTools(server: McpServer): void {
  server.tool(
    "list_pending_tickets",
    "列出 Asana 專案尚未完成的票單（onlyAssignedToMe 或專案 .pipeline/settings.json 可限制只列指派給本人的）。帶 projectName 時一併把「需人工處理」項目覆寫進 `<projectDir>/.asana-pipeline/<projectName>/PENDING_HUMAN_ACTIONS.html`（建議每次都帶）。\n" +
      "回傳欄位：\n" +
      "- `tickets`：待處理。`contentChanged:true`=處理過但 Asana 內容又變了，由 get_ticket_snapshot 判斷是否重分析；`humanRequestedReanalysis:true`=使用者要求優先處理，**這批次一定要先對它呼叫 get_ticket_snapshot**（處理後旗標自動清除）；`humanRejected:true`=使用者 record_confirmation({confirmed:false}) 打回，比照驗證師判 FAIL 的根因分流（見 advance_ticket_stage 的 rootCause）；`specRejected:true`=規格草稿被打回。\n" +
      "- `awaitingConfirmation`：AI 已判 PASS、等使用者實測確認；**每次呼叫都要完整秀給使用者**，直到 record_confirmation。\n" +
      "- `awaitingSpecConfirmation`：僅 sdMode \"self-generated\"，等 record_spec_confirmation，同樣要秀給使用者。\n" +
      "- `manualActions`／`uncommittedChanges` 互斥：「尚未 commit」且有具體檔名的只在 `uncommittedChanges`（`registered:false`=尚未 register_git_roots）。\n" +
      "Asana 資料 60 秒內重複呼叫會用快取（回傳帶 boardFromCache／boardAgeSeconds，剛改的指派／到期日可能還沒反映），要最新資料帶 refresh:true。\n" +
      "HTML 上的勾選要先在 dev-pipeline-mcp 目錄執行 `npm run start:http` 啟動本機 HTTP bridge（首次產出報告時提醒使用者）；「Asana 內容已變更」的勾選只是標記，要等下一個看到 `humanRequestedReanalysis:true` 的 AI 才會處理。改票單狀態的工具都會自動局部重寫報告，本工具主要用來發現全新的票與使用者標記的優先票。",
    {
      projectGid: z.string().describe("Asana 專案 gid"),
      sectionFilter: z.string().nullable().optional().describe("只取這個 section 名稱底下的任務，不指定就取全部"),
      projectName: z
        .string()
        .nullable()
        .optional()
        .describe("這個 Asana 專案的「全名稱」。有帶的話會把這次算出的待處理項目寫進 PENDING_HUMAN_ACTIONS.html；不帶就只回傳 JSON，不寫檔案。"),
      onlyAssignedToMe: z
        .boolean()
        .nullable()
        .optional()
        .describe(
          "true=只列指派給目前 Asana 帳號本人的票（其他人的不列、也不進 PENDING_HUMAN_ACTIONS.html）；false=列全部。沒帶時看專案 <projectDir>/.pipeline/settings.json 的 onlyAssignedToMe，都沒有就是 false。"
        ),
      dueOn: z
        .union([z.enum(["today", "overdue", "today_or_overdue"]), z.string().regex(DUE_ON_DATE_PATTERN)])
        .nullable()
        .optional()
        .describe("只過濾 `tickets`：依到期日篩選（today／overdue／today_or_overdue／YYYY-MM-DD）；無到期日的票一律排除。其他清單不受影響。"),
      limit: z
        .number()
        .int()
        .positive()
        .nullable()
        .optional()
        .describe("只限制 `tickets` 回傳筆數（依到期日由早到晚）；超過會附 totalMatched／truncated／truncatedNote，不會悄悄截斷。"),
      refresh: z.boolean().nullable().optional().describe("true=強制重抓 Asana；沒帶=60 秒內重複呼叫用快取。"),
    },
    async ({ projectGid, sectionFilter, projectName, onlyAssignedToMe, dueOn, limit, refresh }) => {
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
        // 「Asana 內容已被異動，待重新確認」這個持久化報告區塊，一般情況下額外要求指派人剛好是這個
        // pipeline 帳號本人——單純內容變了但沒指派給這個帳號的票單不冒出來打擾使用者。但使用者自己在
        // 網頁上主動勾了「請 AI 優先處理」的票，不管指派人是誰都一定要顯示（是使用者自己要求的，不能
        // 因為指派人條件被過濾掉）。上面的 `contentChangedList`（回傳給呼叫端的 JSON 欄位，
        // `pending[].contentChanged` 也是）不受這條限制，用途不同（提醒 AI「這份舊分析可能已經過期，
        // 用之前先看一眼」，跟該不該寫進報告通知人類是兩回事）。
        const assigneeGid: string | null = task.assignee?.gid ?? null;
        if (showAsChanged && (humanRequested || (pipelineUserGid !== null && assigneeGid === pipelineUserGid))) {
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

      const hasListFilter = dueOn != null || limit != null;
      const listed = filterAndLimitTickets(pending, { dueOn, limit, today: localDateString() });

      return textResult({
        success: true,
        projectGid,
        count: listed.tickets.length,
        ...(onlyMine ? { filteredBy: "assignee=me", skippedNotAssignedToMe: skippedNotMine } : {}),
        ...(hasListFilter
          ? {
              filters: { ...(dueOn != null ? { dueOn } : {}), ...(limit != null ? { limit } : {}) },
              totalMatched: listed.totalMatched,
              ...(listed.truncated ? { truncated: true, truncatedNote: listed.truncatedNote } : {}),
            }
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
        manualActions: manualActionsForReport,
        ...(uncommittedChanges ? { uncommittedChanges } : {}),
        ...(pendingActionsReportPath ? { pendingActionsReportPath } : {}),
        ...(fromCache ? { boardFromCache: true, boardAgeSeconds: ageSeconds } : {}),
      });
    }
  );

  server.tool(
    "get_ticket_status",
    "取得某張票單的追蹤狀態（stage / project_dir / verdict / history / summaries / confirmation / spec_confirmation / verifier_root_cause / consecutive_fail_count）。\n" +
      "- **verdict 是 AI 驗證師的 PASS/FAIL，confirmation 是使用者實測確認，兩者不同軸**：confirmation 要 confirmed:true 才算結案，null=未表態。\n" +
      "- **spec_confirmation** 僅 sdMode \"self-generated\" 使用：null 時 advance_ticket_stage 被擋（\"spec_first\" 擋在 implemented，\"code_first\" 擋在 verified）。\n" +
      "- verdict FAIL 時 verifier_root_cause 是上次根因；**needs_human_review（consecutive_fail_count >= 3）為 true 就停下問使用者，不要自動重跑**，false 才依根因回工程師或分析師。\n" +
      "- sync_flags（analysis_stale / implementation_stale）為 true=01/02/03 有同步債，**接手前先還清**。\n" +
      "- external_changes（*_externally_modified，每次現場重算雜湊）為 true=檔案被外部改過，summaries 與 sync_flags 可能過期，**要 read_ticket_artifact 讀全文**；確認無誤後用 resync_ticket_artifact 同步。\n" +
      "- nextAction：程式依上述狀態算出的下一步（summary／blockedBy／suggestedTools），與工具實際把關一致，優先照它做。",
    { taskGid: z.string().describe("Asana 任務 gid") },
    async ({ taskGid }) => {
      const status = await readStatus(taskGid);
      const externalChanges = await detectExternalChanges(taskGid, status);
      const syncFlags = computeSyncFlags(status);
      return textResult({
        ...status,
        sync_flags: syncFlags,
        needs_human_review: needsHumanReview(status),
        external_changes: externalChanges,
        nextAction: computeNextAction(status, { syncFlags, externalChanges }),
      });
    }
  );

  server.tool(
    "record_confirmation",
    "記錄結案前唯一一關人類確認（使用者自己實測＋審視程式碼品質），與 advance_ticket_stage 的 verdict（AI 驗證師判定）是不同東西。" +
      "只有記錄 confirmed: true，票單才會從 awaitingConfirmation 消失、真正結案。只能在已跑到 tested 階段後呼叫，否則被拒絕。" +
      "confirmed: false=使用者測出問題：記下 note、verdict 重設為 null，票單回到 list_pending_tickets 一般清單（humanRejected: true），走與 AI 判 FAIL 相同的根因分流。" +
      "呼叫後自動局部重寫 PENDING_HUMAN_ACTIONS.html。",
    {
      taskGid: z.string().describe("Asana 任務 gid"),
      confirmed: z.boolean().describe("使用者自己實測＋審視程式碼品質是否通過：true = 沒問題、真正結案，false = 發現問題"),
      note: z.string().nullable().optional().describe("備註，例如測了哪些情境、審視程式碼的發現、confirmed 是 false 時具體發現了什麼問題"),
    },
    async ({ taskGid, confirmed, note }) => {
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
      return textResult({ success: true, status });
    }
  );

  server.tool(
    "record_spec_confirmation",
    "記錄「規格草稿定案」關卡的確認結果，僅 sdMode \"self-generated\" 專案會走到這一關（與 record_confirmation 是獨立的兩個確認點）。只能在已推進到 stage \"sd_drafted\" 後呼叫，否則被拒絕。" +
      "confirmed: true=解鎖下一步：specOrder \"spec_first\" 解鎖推進到 \"implemented\"；\"code_first\"（規格是寫完 code 後反推）解鎖推進到 \"verified\"。" +
      "confirmed: false=草稿有問題：記下 note，stage 維持 \"sd_drafted\"，票單回到 list_pending_tickets 一般清單（specRejected: true），規格撰寫者依 note 修改後重新 advance_ticket_stage({ stage: \"sd_drafted\" }) 送出（會自動清空這裡的紀錄）。" +
      "呼叫後自動局部重寫 PENDING_HUMAN_ACTIONS.html。",
    {
      taskGid: z.string().describe("Asana 任務 gid"),
      confirmed: z.boolean().describe("是否確認這份規格草稿可以動手寫程式碼：true = 沒問題、可以開始，false = 有問題要修改"),
      note: z.string().nullable().optional().describe("備註，confirmed 是 false 時應具體說明規格草稿哪裡需要修改"),
    },
    async ({ taskGid, confirmed, note }) => {
      const current = await readStatus(taskGid);
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
    "resolve_manual_action",
    "移除 manualActions 裡『使用者確認已處理完』的一項（其餘保留），讓它不再出現在 PENDING_HUMAN_ACTIONS.html。" +
      "用在使用者說某票的某項手動待辦（SQL、I18N 匯入等）做完了；只指出這一項即可。" +
      "**`action` 要與 get_ticket_status/list_pending_tickets 回傳的 manualActions 文字一字不差**（前後空白忽略）；找不到時回傳 success:false 與目前完整清單，核對後重試，不要憑印象猜。移除後自動局部重寫報告。",
    {
      taskGid: z.string().describe("Asana 任務 gid"),
      filename: z
        .enum(["02-implementation.md", "03-verification.md", "04-test.md"])
        .describe("這項待辦事項是哪一份文件宣告的（工程師階段用 02，驗證師階段用 03，測試工程師階段用 04）"),
      action: z.string().describe("要移除的事項，完整文字（可以從 get_ticket_status 或上次 list_pending_tickets 的 manualActions 裡複製）"),
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
    "標記某張票單「使用者要求優先重新確認」（human_requested_reanalysis），純資料操作、不會自己觸發分析。" +
      "用在使用者要求標記某票優先重新確認，或 PENDING_HUMAN_ACTIONS.html 勾選按鈕背後的呼叫。**呼叫完你自己應直接接著對這張票呼叫 get_ticket_snapshot**；旗標是留給之後才連上的其他 AI/session 看的，不是延後處理的藉口。呼叫後自動局部重寫報告。",
    {
      taskGid: z.string().describe("Asana 任務 gid"),
    },
    async ({ taskGid }) => {
      const status = await requestReanalysis(taskGid);
      await syncPendingActionsReport(taskGid);
      return textResult({ success: true, taskGid, status });
    }
  );

  server.tool(
    "advance_ticket_stage",
    "更新票單追蹤階段，可一併更新 project_dir / verdict。" +
      "推進到 project_dir_confirmed/analyzed/implemented/verified/tested 前會檢查證據：project_dir 已確定，或 01/02/03/04-*.md 已用 write_ticket_artifact 寫入非空內容；缺少會被拒絕並說明缺哪份。" +
      "**verdict 設 \"FAIL\" 時 rootCause（\"analysis\"|\"implementation\"）必填**，供下一輪決定回分析師或工程師；非 FAIL 不可帶 rootCause。" +
      "tested 的 verdict 規則同 verified（共用 consecutive_fail_count/needs_human_review 安全閥）：只有 AI 有把握的 verified_fail 才算 FAIL，needs_manual_check 不影響（見 get_role_prompt({role:\"tester\"})）。" +
      "只要更新 verdict 就會自動清空 confirmation，並維護 consecutive_fail_count（FAIL 累加、PASS 歸零，達 3 時 needs_human_review 為 true）。呼叫後自動局部重寫 PENDING_HUMAN_ACTIONS.html。",
    {
      taskGid: z.string().describe("Asana 任務 gid"),
      stage: z
        .enum(["new", "snapshot", "project_dir_confirmed", "analyzed", "sd_drafted", "implemented", "verified", "tested"])
        .describe(
          "要推進到的階段。\"sd_drafted\" 只有 sdMode \"self-generated\" 才需要（specOrder \"spec_first\"：analyzed 之後、implemented 之前；\"code_first\"：implemented 之後、verified 之前）；其他 sdMode 直接從 analyzed 到 implemented。" +
            "\"tested\" 在 verified 之後、使用者最終確認之前（測試工程師），每張票都會經過。"
        ),
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

      // 防止跳過某個角色就直接宣告推進到後面的階段（例如只做完工程師改動就想直接標成 verified）：
      // 每個階段要求對應的產出文件已經透過 write_ticket_artifact 寫入非空內容，不能只改 stage 欄位就過關。
      const STAGE_ARTIFACT_REQUIREMENT: Partial<Record<TicketStatus["stage"], string>> = {
        analyzed: "01-analysis.md",
        implemented: "02-implementation.md",
        verified: "03-verification.md",
        tested: "04-test.md",
      };
      const requiredArtifact = STAGE_ARTIFACT_REQUIREMENT[stage];
      if (requiredArtifact) {
        const artifactContent = await readArtifact(taskGid, requiredArtifact);
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
      return textResult({ success: true, status, needs_human_review: needsHumanReview(status) });
    }
  );
}
