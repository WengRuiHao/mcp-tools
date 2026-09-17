import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callAsanaTool } from "./mcp-clients.js";
import { resolveProjectDir } from "./project-registry.js";
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

export function registerTicketLifecycleTools(server: McpServer): void {
  server.tool(
    "list_pending_tickets",
    "列出指定 Asana 專案裡尚未完成的票單，並在帶 projectName 時把「需要人工處理」的項目整份覆寫進互動網頁 PENDING_HUMAN_ACTIONS.html。\n\n" +
      "**回傳欄位速查**：\n" +
      "- `tickets`：一般待處理清單。`contentChanged:true` = 先前已處理過（甚至 PASS 過），但 Asana 內容後來又變了（或使用者主動要求重新確認），不能因為之前處理過就跳過，下一步 get_ticket_snapshot 會確認要不要重新分析；`humanRequestedReanalysis:true` = 使用者在 PENDING_HUMAN_ACTIONS.html 上主動勾了「請 AI 優先處理」——**這張票即使沒有其他理由要處理，也要在這次批次裡優先呼叫 get_ticket_snapshot**，不能因為使用者這次是要處理別的票就略過，處理完（不管有沒有真的偵測到內容變動）這個旗標會自動清掉；`humanRejected:true` = 使用者用 record_confirmation({confirmed:false}) 打回的票，**套用跟 AI 驗證師自己判 FAIL 完全一樣的根因分流機制**（見 advance_ticket_stage 的 rootCause 說明），不要另開一套「人工打回」流程；`specRejected:true` = 規格草稿被使用者打回。\n" +
      "- `awaitingConfirmation`：AI 驗證師/測試工程師已判 PASS、Asana 內容也沒再變，只等使用者自己實測＋審視程式碼品質。**每次呼叫都要把這份清單完整秀給使用者看**（不能因為這次是處理別的新票就略過），直到每一張都呼叫過 record_confirmation 才會消失。\n" +
      "- `awaitingSpecConfirmation`：只有 sdMode:\"self-generated\" 的專案會出現，等使用者呼叫 record_spec_confirmation 表態，同樣要主動秀給使用者看。\n" +
      "- `manualActions`/`manualActionsCount`、`uncommittedChanges`：兩者互斥——「尚未 commit」且點得出具體檔名的事項只會出現在 `uncommittedChanges`（跟真實 git status 核對過，`registered:false` 代表還沒呼叫過 register_git_roots），不會在 `manualActions` 重複出現。\n\n" +
      "**`PENDING_HUMAN_ACTIONS.html`**（只有帶 `projectName` 才會寫，放在 `<projectDir>/.asana-pipeline/<projectName>/`，取代「只在聊天視窗提醒一次、換個 session 就找不到」的做法，強烈建議每次都帶）：待確認規格草稿／待確認／需要你手動處理的事項／Asana 內容已變更（還沒被要求優先處理的票）這四類可以直接在瀏覽器勾選/確認（即時呼叫 record_spec_confirmation/record_confirmation/resolve_manual_action/request_reanalysis，要先在 dev-pipeline-mcp 目錄下執行 `npm run start:http` 啟動本機 HTTP bridge，第一次產出報告時記得提醒使用者這個步驟）；卡住需要你介入／Git 尚未 commit 這兩類唯讀。**「Asana 內容已變更」的勾選只是標記請求，bridge 沒有 LLM 能力、不會真的觸發分析**——要等下一個呼叫這個工具的 AI 看到 `humanRequestedReanalysis:true` 才會真的處理，見上面 `tickets` 欄位說明。**不需要手動維護同步時機**——任何會改動票單狀態的工具（advance_ticket_stage/write_ticket_artifact/resolve_manual_action/record_confirmation/resync_ticket_artifact/request_reanalysis）呼叫完都會自動局部重寫這份報告，呼叫這裡的 list_pending_tickets 主要是為了發現「全新、還沒被 get_ticket_snapshot 摸過」的票單，以及發現使用者主動標記要優先處理的票。",
    {
      projectGid: z.string().describe("Asana 專案 gid"),
      sectionFilter: z.string().nullable().optional().describe("只取這個 section 名稱底下的任務，不指定就取全部"),
      projectName: z
        .string()
        .nullable()
        .optional()
        .describe("這個 Asana 專案的「全名稱」。有帶的話會把這次算出的待處理項目寫進 PENDING_HUMAN_ACTIONS.html；不帶就只回傳 JSON，不寫檔案。"),
    },
    async ({ projectGid, sectionFilter, projectName }) => {
      const board = await callAsanaTool("asana_board", { projectGid, refresh: true });
      if (!board?.success) return textResult(board, true);

      const tasks: any[] = Array.isArray(board.tasks) ? board.tasks : [];
      const pipelineUserGid = await getPipelineAsanaUserGid();
      const pending = [];
      const awaitingConfirmation = [];
      const awaitingSpecConfirmation = [];
      const needsHumanReviewList = [];
      const manualActionsList = [];
      const contentChangedList = [];
      const contentChangedForReport = [];
      for (const task of tasks) {
        if (task.completed === true) continue;
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

      return textResult({
        success: true,
        projectGid,
        count: pending.length,
        tickets: pending,
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
      });
    }
  );

  server.tool(
    "get_ticket_status",
    "取得某張票單目前的追蹤狀態（stage / project_dir / verdict / history / summaries / confirmation / spec_confirmation / verifier_root_cause / consecutive_fail_count）。" +
      "**verdict 是 AI 驗證師自己判定的 PASS/FAIL，confirmation（使用者自己實測＋審視程式碼品質）才是真正結案要看的人類確認——兩者是不同軸向，verdict PASS 不代表 confirmation 也是 confirmed:true**。confirmation 是 null 代表使用者還沒表態，要 confirmed:true 才能當作這張票已經結案。" +
      "**spec_confirmation 是另一個獨立的確認點，只有 sdMode 為 \"self-generated\" 的專案（走過 stage: \"sd_drafted\"）才會用到**：null 代表使用者還沒對這份 SD 規格草稿表態，advance_ticket_stage 會被擋下不能繼續推進——specOrder 是 \"spec_first\" 時擋在推進到 \"implemented\"（規格先定案才能寫程式碼）；specOrder 是 \"code_first\" 時擋在推進到 \"verified\"（工程師已經先寫完 code，規格是事後反推的，要 confirmed:true 才能讓票單走到驗證完成）。" +
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
    "record_confirmation",
    "記錄結案前唯一一關人類確認——使用者自己對這張票的實測結果＋程式碼品質審視——跟 advance_ticket_stage 的 verdict（AI 驗證師自己判定的 PASS/FAIL）是完全不同的東西，不能混用。" +
      "AI 判 PASS 只代表「AI 自己檢查過、可以交給人測了」，不是真正結案；只有呼叫這個工具記錄 confirmed: true，這張票才會從 list_pending_tickets 的 awaitingConfirmation 清單裡消失、真正算結案。" +
      "只能在這張票已經跑到 tested 階段之後才能呼叫（代表至少走過一次分析/實作/驗證/測試），否則會被拒絕。" +
      "confirmed: false 代表使用者實際測過、發現有問題——會記錄下 note，並把這張票的 verdict 重設回 null，重新丟回 list_pending_tickets 的一般待處理清單（標記 humanRejected: true），讓 AI 用跟自己判 FAIL 完全一樣的根因分流機制去處理，不是丟給人工事後自己決定。" +
      "**呼叫完會自動局部重寫這張票所屬 Asana 專案的 `PENDING_HUMAN_ACTIONS.html`**（純本機運算，不用另外呼叫 `list_pending_tickets`）。",
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
    "記錄「規格草稿定案」這道關卡的確認結果——只有 sdMode 為 \"self-generated\" 的專案（AI 自己維護 SD 規格文件）會走到這一關，不管這個專案的 specOrder 是 \"spec_first\" 還是 \"code_first\"。" +
      "只能在這張票已經推進到 stage: \"sd_drafted\"（規格撰寫者已產出/更新草稿）之後才能呼叫，否則會被拒絕。" +
      "**confirmed: true**：這張票才會解鎖，繼續往下推進——specOrder 是 \"spec_first\" 的話解鎖工程師階段的 advance_ticket_stage 推進到 \"implemented\"；specOrder 是 \"code_first\" 的話（規格是工程師寫完 code 之後才反推補上的）解鎖驗證師階段推進到 \"verified\"。" +
      "**confirmed: false**：代表這份草稿有問題，記錄下 note 說明哪裡要改，stage 不會變動（還停在 \"sd_drafted\"），這張票會重新出現在 list_pending_tickets 的一般 tickets 清單裡並標記 specRejected: true，交給規格撰寫者依 note 修改後重新呼叫 advance_ticket_stage({ stage: \"sd_drafted\" }) 送出新版本（那次呼叫會自動清空這裡的紀錄，不需要另外呼叫任何清空工具）。" +
      "跟 record_confirmation（結案前那關）是完全獨立的兩個確認點，欄位分開存放，不要混用。" +
      "**呼叫完會自動局部重寫這張票所屬 Asana 專案的 `PENDING_HUMAN_ACTIONS.html`**（純本機運算，不用另外呼叫 `list_pending_tickets`）。",
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
    "把 `implementation_manual_actions`／`verification_manual_actions` 裡『使用者確認已經處理完』的一項移除，其餘保留，讓它不再出現在 `PENDING_HUMAN_ACTIONS.html`。" +
      "**用在：使用者跟你說某個票單的某項手動待辦（例如某段 SQL、某份多國語系匯入）已經做完了**——不用整份陣列重新宣告一次，只要指出這一項，其餘事項會原封不動保留。" +
      "**`action` 用完整文字精確比對**（前後空白會自動忽略）——文字必須跟 `get_ticket_status`/`list_pending_tickets` 回傳的 `manualActions` 內容一字不差，找不到完全對應的項目時，會回傳 `success: false` 跟這份文件目前的完整清單，讓你核對正確文字後再重試，不要憑印象猜測。" +
      "移除之後這個工具會自動局部重寫 `PENDING_HUMAN_ACTIONS.html`（純本機運算，不用等下次呼叫 `list_pending_tickets`），不需要呼叫端額外做任何事。",
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
    "標記某張票單「使用者要求優先重新確認」（human_requested_reanalysis）。" +
      "**用在：使用者直接跟你說『幫我標記 XX 票要優先重新確認』，或你在 PENDING_HUMAN_ACTIONS.html 對應的勾選按鈕背後看到這個呼叫**——純資料操作，不會、也不能自己觸發分析。" +
      "**這個工具呼叫完之後，你自己就應該直接接著呼叫 get_ticket_snapshot 處理這張票**（不用等旗標被清掉再等下一次批次）；旗標存在的意義是給*其他*之後才連上這個專案的 AI/session 看到，不是給你自己延後處理的藉口。" +
      "呼叫完會自動局部重寫 `PENDING_HUMAN_ACTIONS.html`。",
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
    "更新某張票單的追蹤狀態，記錄目前進行到哪個階段，並可以一併更新 project_dir / verdict。" +
      "**推進到 \"project_dir_confirmed\"/\"analyzed\"/\"implemented\"/\"verified\"/\"tested\" 這幾個階段前，會檢查對應的證據是否已經存在，不是單純改個欄位就能過關**：" +
      "\"project_dir_confirmed\" 要求 project_dir 已確定（這次帶或先前已設定過）；\"analyzed\"/\"implemented\"/\"verified\"/\"tested\" 分別要求 01-analysis.md／02-implementation.md／03-verification.md／04-test.md 已經透過 write_ticket_artifact 寫入非空內容——" +
      "沒有對應證據就直接呼叫這個工具想跳過某個角色（例如只做完工程師改動就想直接標記 verified），會被拒絕，訊息會說明還缺哪一份文件。" +
      "**\"tested\" 是 \"verified\" 之後、使用者最終確認之前新增的一關（測試工程師），verdict/rootCause 的規則跟 \"verified\" 完全一樣，兩者共用同一組 consecutive_fail_count/needs_human_review 安全閥**——判斷依據見 get_role_prompt({role:\"tester\"})：只有測試項目裡出現 AI 有把握判定的 verified_fail 才算 FAIL，AI 沒把握判定、只能列出來提醒使用者的項目（needs_manual_check）不影響這裡的 verdict。" +
      "**verdict 設成 \"FAIL\" 時，rootCause 是必填參數**（\"analysis\" 或 \"implementation\"）——判斷這次 FAIL 的根因在分析階段還是實作階段，供下一輪處理這張票時決定要自動跳回分析師還是工程師，不能省略。verdict 不是 \"FAIL\"（PASS，或這次沒有更新 verdict）時，不需要也不應該帶 rootCause，帶了會被拒絕。" +
      "**這個呼叫只要有更新 verdict，就會自動清空 confirmation**（這個人類確認是對上一輪程式碼/結論表態的，新 verdict 出爐代表結論已經更新，舊確認一律作廢，不能沿用）、並機械式維護 consecutive_fail_count（FAIL 累加、PASS 歸零，累加到 3 之後回傳的 needs_human_review 會是 true）。" +
      "**呼叫完會自動局部重寫這張票所屬 Asana 專案的 `PENDING_HUMAN_ACTIONS.html`**（純本機運算，不用另外呼叫 `list_pending_tickets`）。",
    {
      taskGid: z.string().describe("Asana 任務 gid"),
      stage: z
        .enum(["new", "snapshot", "project_dir_confirmed", "analyzed", "sd_drafted", "implemented", "verified", "tested"])
        .describe(
          "要推進到的階段。\"sd_drafted\" 只有 sdMode 為 \"self-generated\" 的專案才需要（規格撰寫者產出/更新 SD 草稿後推進到這裡）；" +
            "其他 sdMode 直接從 \"analyzed\" 推進到 \"implemented\" 即可，不用經過這一階。" +
            "**self-generated 底下這一階出現的時機依 specOrder 而定**：\"spec_first\" 是 \"analyzed\" 之後、\"implemented\" 之前；\"code_first\" 是 \"implemented\" 之後、\"verified\" 之前（工程師先寫完 code，規格撰寫者才依實作反推補上 SD 草稿）。" +
            "\"tested\" 是 \"verified\" 之後、使用者最終確認之前新增的一階（測試工程師），每張票都會經過，套用哪些檢查項目由測試工程師依這張票的改動內容自己判斷（見 get_role_prompt({role:\"tester\"})）。"
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
