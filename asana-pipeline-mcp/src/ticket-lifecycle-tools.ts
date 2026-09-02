import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callAsanaTool } from "./mcp-clients.js";
import { resolveProjectDir } from "./project-registry.js";
import {
  readStatus,
  advanceStage,
  recordConfirmation,
  needsHumanReview,
  computeSyncFlags,
  detectExternalChanges,
  resolveManualAction,
  writePendingActionsReport,
  readArtifact,
  type TicketStatus,
} from "./pipeline-store.js";
import { syncPendingActionsReport, getPipelineAsanaUserGid, getUncommittedChangesSummary, filterOutGitCommitActions } from "./pending-actions-sync.js";
import { textResult } from "./shared.js";

export function registerTicketLifecycleTools(server: McpServer): void {
  server.tool(
    "list_pending_tickets",
    "列出指定 Asana 專案裡尚未完成、且尚未驗證通過（PASS）的票單清單。透過 asana-mcp 取得看板資料，並依本地追蹤紀錄過濾掉已經處理完成的票。" +
      "**已經 PASS 的票單如果 Asana 上的內容後來又被改過（用 modified_at 便宜初篩），一樣會重新列進 tickets，並標記 contentChanged: true**——代表這張票不能因為之前 PASS 就跳過，下一步呼叫 get_ticket_snapshot 會確認內容是否真的變了、需不需要重新分析。" +
      "**結案前還有一關人類確認，回傳額外附上這關待處理的清單：`awaitingConfirmation`**——AI 驗證師判過 PASS、Asana 內容也沒再變過，但『使用者自己』還沒實際測過＋審視過程式碼品質的票單。" +
      "AI 自己判定 PASS 不等於這張票真的結案，呼叫端每次執行這個工具都必須把這份清單完整秀給使用者看（不能因為這次是來處理別的新票就略過），直到每一張都呼叫過 record_confirmation 為止，才會從清單消失。" +
      "**`tickets`（一般待處理清單）裡如果某張票標記 `humanRejected: true`，代表這不是一張全新沒驗證過的票，而是使用者事後回報有問題、被重新丟回來的票**（`record_confirmation` 帶 `confirmed:false` 時會把這張票的 verdict 重設回 null，讓它重新出現在這裡）——處理這種票要當作跟 AI 驗證師自己判 FAIL 完全一樣的情況，套用同一套根因分流機制（見 get_role_prompt({role:\"verifier\"})/advance_ticket_stage 的 rootCause 說明），不要另外發明一套「人工打回」流程。" +
      "**帶 `projectName` 時，這次算出來的五類「需要人工處理」項目（待你確認／卡住需要介入／Asana 內容已變更待重新確認／需要你手動處理的事項／Git 尚未 commit 的變更）會整份覆寫進一份持久化的 `PENDING_HUMAN_ACTIONS.md`**（放在 `<projectDir>/.asana-pipeline/<projectName>/` 底下，跟每張票自己的追蹤目錄同一層）——這是為了取代「只在聊天視窗提醒一次，換個 session 就找不到」的做法，不需要任何人記得手動維護。強烈建議每次呼叫都帶上 `projectName`（跟步驟 0 拿到的 Asana 專案全名稱一致）。" +
      "**這份報告不再需要呼叫端手動維護同步時機**——advance_ticket_stage/write_ticket_artifact/resolve_manual_action/record_confirmation/resync_ticket_artifact 這幾個會改動票單狀態的工具，現在每次呼叫完都會自動局部重寫這份報告（純本機運算，不重查 Asana），呼叫這裡的 list_pending_tickets 主要是用來發現「全新、還沒被任何一次 get_ticket_snapshot 摸過」的票單，不是同步這份報告的唯一時機。" +
      "**`PENDING_HUMAN_ACTIONS.md` 的「Asana 內容已被異動，待重新確認」這個分類，只有這張票目前的指派人剛好是這個 pipeline 帳號本人（透過 asana_me 取得）時才會列進去**——單純內容變了、但沒有人特地把它指派回這個帳號的票單不會出現在這裡，避免大量雜訊。這個過濾條件只影響這份報告要不要顯示，不影響 `tickets`/`contentChangedList` 這兩個回傳欄位本身（那兩個仍然只看內容有沒有變，讓呼叫端知道「這份舊分析可能過期了」）。" +
      "**`uncommittedChanges` 依票單分組，只列出「git status 真的還沒 commit、又有某張票的 manualActions 點名說是它改的」檔案**——跟這次 pipeline 無關的其他未 commit 檔案不在清單裡（要查全部異動請自己跑 git status）。是否真的還沒 commit 仍然以 git 的真實狀態為準，manualActions 文字只用來標出「這個檔案屬於哪張票」。`registered: false` 代表這個專案還沒呼叫過 `register_git_roots`。" +
      "**`manualActions`/`manualActionsCount`（回傳 JSON 跟 `PENDING_HUMAN_ACTIONS.md` 都一樣）已經濾掉純粹是「尚未 commit」且點得出具體檔名的項目**——那類事項改由上面的 `uncommittedChanges`/「Git 尚未 commit 的變更」區塊負責呈現（跟真實 git status 核對過，比自由文字準確），不會在這裡重複出現造成雜訊。真的還沒 commit 完的檔案永遠看得到（在 Git 區塊），只是不會在這個區塊也出現一次。",
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
      const pipelineUserGid = await getPipelineAsanaUserGid();
      const pending = [];
      const awaitingConfirmation = [];
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
        const status = await readStatus(task.gid);

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
        pending.push({
          taskGid: task.gid,
          name: task.name,
          dueOn: task.due_on,
          stage: status.stage,
          ...(isContentChanged ? { contentChanged: true } : {}),
          ...(status.confirmation?.confirmed === false ? { humanRejected: true } : {}),
        });
        if (isContentChanged) {
          contentChangedList.push({ taskGid: task.gid, name: task.name, stage: status.stage });
        }
        // 「Asana 內容已被異動，待重新確認」這個持久化報告區塊，額外要求指派人剛好是這個 pipeline 帳號本人——
        // 單純內容變了但沒指派給這個帳號的票單不冒出來打擾使用者。上面的 `contentChangedList`（回傳給呼叫端的
        // JSON 欄位，`pending[].contentChanged` 也是）不受這條限制，用途不同（提醒 AI「這份舊分析可能已經過期，
        // 用之前先看一眼」，跟該不該寫進報告通知人類是兩回事）。
        const assigneeGid: string | null = task.assignee?.gid ?? null;
        if (isContentChanged && pipelineUserGid !== null && assigneeGid === pipelineUserGid) {
          contentChangedForReport.push({ taskGid: task.gid, name: task.name, stage: status.stage });
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
    "取得某張票單目前的追蹤狀態（stage / project_dir / verdict / history / summaries / confirmation / verifier_root_cause / consecutive_fail_count）。" +
      "**verdict 是 AI 驗證師自己判定的 PASS/FAIL，confirmation（使用者自己實測＋審視程式碼品質）才是真正結案要看的人類確認——兩者是不同軸向，verdict PASS 不代表 confirmation 也是 confirmed:true**。confirmation 是 null 代表使用者還沒表態，要 confirmed:true 才能當作這張票已經結案。" +
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
      "只能在這張票已經跑到 verified 階段之後才能呼叫（代表至少走過一次分析/實作/驗證），否則會被拒絕。" +
      "confirmed: false 代表使用者實際測過、發現有問題——會記錄下 note，並把這張票的 verdict 重設回 null，重新丟回 list_pending_tickets 的一般待處理清單（標記 humanRejected: true），讓 AI 用跟自己判 FAIL 完全一樣的根因分流機制去處理，不是丟給人工事後自己決定。" +
      "**呼叫完會自動局部重寫這張票所屬 Asana 專案的 `PENDING_HUMAN_ACTIONS.md`**（純本機運算，不用另外呼叫 `list_pending_tickets`）。",
    {
      taskGid: z.string().describe("Asana 任務 gid"),
      confirmed: z.boolean().describe("使用者自己實測＋審視程式碼品質是否通過：true = 沒問題、真正結案，false = 發現問題"),
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
      const status = await recordConfirmation(taskGid, confirmed, note ?? null);
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
    "把 `implementation_manual_actions`／`verification_manual_actions` 裡『使用者確認已經處理完』的一項移除，其餘保留，讓它不再出現在 `PENDING_HUMAN_ACTIONS.md`。" +
      "**用在：使用者跟你說某個票單的某項手動待辦（例如某段 SQL、某份多國語系匯入）已經做完了**——不用整份陣列重新宣告一次，只要指出這一項，其餘事項會原封不動保留。" +
      "**`action` 用完整文字精確比對**（前後空白會自動忽略）——文字必須跟 `get_ticket_status`/`list_pending_tickets` 回傳的 `manualActions` 內容一字不差，找不到完全對應的項目時，會回傳 `success: false` 跟這份文件目前的完整清單，讓你核對正確文字後再重試，不要憑印象猜測。" +
      "移除之後這個工具會自動局部重寫 `PENDING_HUMAN_ACTIONS.md`（純本機運算，不用等下次呼叫 `list_pending_tickets`），不需要呼叫端額外做任何事。",
    {
      taskGid: z.string().describe("Asana 任務 gid"),
      filename: z
        .enum(["02-implementation.md", "03-verification.md"])
        .describe("這項待辦事項是哪一份文件宣告的（工程師階段用 02，驗證師階段用 03）"),
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
    "advance_ticket_stage",
    "更新某張票單的追蹤狀態，記錄目前進行到哪個階段，並可以一併更新 project_dir / verdict。" +
      "**推進到 \"project_dir_confirmed\"/\"analyzed\"/\"implemented\"/\"verified\" 這幾個階段前，會檢查對應的證據是否已經存在，不是單純改個欄位就能過關**：" +
      "\"project_dir_confirmed\" 要求 project_dir 已確定（這次帶或先前已設定過）；\"analyzed\"/\"implemented\"/\"verified\" 分別要求 01-analysis.md／02-implementation.md／03-verification.md 已經透過 write_ticket_artifact 寫入非空內容——" +
      "沒有對應證據就直接呼叫這個工具想跳過某個角色（例如只做完工程師改動就想直接標記 verified），會被拒絕，訊息會說明還缺哪一份文件。" +
      "**verdict 設成 \"FAIL\" 時，rootCause 是必填參數**（\"analysis\" 或 \"implementation\"）——判斷這次 FAIL 的根因在分析階段還是實作階段，供下一輪處理這張票時決定要自動跳回分析師還是工程師，不能省略。verdict 不是 \"FAIL\"（PASS，或這次沒有更新 verdict）時，不需要也不應該帶 rootCause，帶了會被拒絕。" +
      "**這個呼叫只要有更新 verdict，就會自動清空 confirmation**（這個人類確認是對上一輪程式碼/結論表態的，新 verdict 出爐代表結論已經更新，舊確認一律作廢，不能沿用）、並機械式維護 consecutive_fail_count（FAIL 累加、PASS 歸零，累加到 3 之後回傳的 needs_human_review 會是 true）。" +
      "**呼叫完會自動局部重寫這張票所屬 Asana 專案的 `PENDING_HUMAN_ACTIONS.md`**（純本機運算，不用另外呼叫 `list_pending_tickets`）。",
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

      // 防止跳過某個角色就直接宣告推進到後面的階段（例如只做完工程師改動就想直接標成 verified）：
      // 每個階段要求對應的產出文件已經透過 write_ticket_artifact 寫入非空內容，不能只改 stage 欄位就過關。
      const STAGE_ARTIFACT_REQUIREMENT: Partial<Record<TicketStatus["stage"], string>> = {
        analyzed: "01-analysis.md",
        implemented: "02-implementation.md",
        verified: "03-verification.md",
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
