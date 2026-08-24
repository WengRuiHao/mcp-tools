import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  readStatus,
  writeArtifact,
  readArtifact,
  recordArtifactHash,
  recordArtifactSummary,
  recordStageSync,
  recordManualActions,
  detectSensitiveManualActions,
  NO_SYNC_NEEDED,
} from "./pipeline-store.js";
import { syncPendingActionsReport } from "./pending-actions-sync.js";
import { textResult } from "./shared.js";

export function registerTicketArtifactTools(server: McpServer): void {
  server.tool(
    "write_ticket_artifact",
    "把內容寫入某張票單的追蹤目錄底下的一個檔案（例如 01-analysis.md / 02-implementation.md / 03-verification.md）。" +
      "**content 是整份檔案內容覆寫，不是附加**：如果這份檔案已經有既有內容，寫入前一定要先呼叫 read_ticket_artifact 讀出目前全文，把舊內容＋這一輪新內容組合成完整全文再一次送進來，絕不能只把「這一輪新增的段落」當 content 傳入，否則會把之前所有輪次的內容永久覆蓋掉且無法復原。只有確定這份檔案第一次被寫入（目前必為空）時才可以直接傳新內容。" +
      "寫入 01-analysis.md 之前，這張票必須已經呼叫過 record_sasd_check，否則會被拒絕。" +
      "**filename 是 01-analysis.md / 02-implementation.md / 03-verification.md 之一時，一定要附上 summary**（2-4 條重點，控制在幾百字內，不是全文）——這段摘要會存進這張票的追蹤狀態，之後不管是同一個 session 還是換一個 session/AI 接手下一階段，都可以先用 get_ticket_status 用低成本讀到摘要，決定要不要再花額外的 tool call 讀 read_ticket_artifact 的全文。寫入 01-analysis.md 時，也會自動清掉這張票的 needs_reanalysis 標記（代表已經針對最新票單內容重新分析過）。" +
      `**filename 是 02-implementation.md 或 03-verification.md 時，syncNote 是必填、不能省略**：這次修改/驗證有沒有推翻或補充了上一階段（02 對應 01，03 對應 02）的結論？有的話把內容寫進 syncNote，會自動附加到上一階段文件尾端；真的沒有，也要明確帶入字串 "${NO_SYNC_NEEDED}"，不能什麼都不填直接跳過——這一步是強制的，逼你對「要不要同步」做一次明確判斷，不能船過水無痕，只是答案可以是「不需要」。沒帶這個參數會直接被拒絕寫入。` +
      "**filename 是 02-implementation.md 或 03-verification.md 時，manualActions 也是必填**（陣列，可以是空陣列）：這次有沒有任何事項是使用者必須自己手動處理的（例如產出的 SQL 只能交由使用者到 Database 工具執行、後台程式代號/選單/I18N 需自行設定）？有就列成一條條簡短字串；真的沒有就帶空陣列 []，不能省略——這些項目會被整理進持久化的 PENDING_HUMAN_ACTIONS.md，不能只寫在全文內容裡指望使用者自己重讀全文才發現。" +
      "**如果這次改動的檔案還沒 commit（沒有跑 git commit，或使用者/前一輪明確決定先不 commit），額外用固定格式列一條**：「已完成但尚未commit：檔名A、檔名B」（一定要包含「commit」這個字，冒號後面用頓號/逗號分隔實際檔名，檔名要以副檔名結尾，例如 .java／.jrxml）——這是 PENDING_HUMAN_ACTIONS.md 裡「Git 尚未 commit 的變更」這個自動化板塊唯一認得的格式（會另外拿真實 git status 核對過才顯示，不是照抄這裡的文字），只描述「還要重新編譯」「需要人工核對」這類措辭、沒提到「commit」兩個字跟具體檔名的話，這個板塊會顯示空白，使用者只能自己跑 git status 才會發現這些檔案還沒進版控。" +
      "**寫入完成後會自動局部重寫這張票所屬 Asana 專案的 `PENDING_HUMAN_ACTIONS.md`**（純本機運算，不用另外呼叫 `list_pending_tickets`）。",
    {
      taskGid: z.string().describe("Asana 任務 gid"),
      filename: z.string().describe("檔名，例如 01-analysis.md"),
      content: z.string().describe("要寫入的內容（全文，整份覆寫既有檔案——若檔案已有內容，先呼叫 read_ticket_artifact 讀出全文再組合，不要只傳這一輪新增段落）"),
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
            "確認這次沒有，帶空陣列 []。留空／不帶會被拒絕寫入。" +
            "有檔案還沒 commit 的話，額外用固定格式列一條「已完成但尚未commit：檔名A、檔名B」（含「commit」二字＋冒號後頓號/逗號分隔的檔名清單），這是報告裡 Git 板塊唯一認得的格式，見上方工具說明。"
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
      if (needsSyncNote && manualActions && manualActions.length > 0) {
        const hits = detectSensitiveManualActions(manualActions);
        if (hits.length > 0) {
          return textResult(
            {
              success: false,
              message:
                "manualActions 裡有項目疑似夾帶完整 SQL 語句全文或憑證/連線字串（" +
                hits.map((h) => `「${h.action}」：${h.reasons.join("、")}`).join("；") +
                "）。這裡只該留技術性描述（例如「已產出 INSERT SQL，新增 3 語系選項資料，待手動執行」），" +
                "完整內容留在內文全文裡就好，不要重複複製進 manualActions。請改寫後再重新呼叫 write_ticket_artifact。",
            },
            true
          );
        }
      }

      if (needsSyncNote) {
        await recordStageSync(taskGid, filename as "02-implementation.md" | "03-verification.md", syncNote!.trim());
        await recordManualActions(taskGid, filename as "02-implementation.md" | "03-verification.md", manualActions!);
      }

      await writeArtifact(taskGid, filename, content);
      await recordArtifactHash(taskGid, filename, content);
      await recordArtifactSummary(taskGid, filename, summary);
      await syncPendingActionsReport(taskGid);
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
      if (manualActions && manualActions.length > 0) {
        const hits = detectSensitiveManualActions(manualActions);
        if (hits.length > 0) {
          return textResult(
            {
              success: false,
              message:
                "manualActions 裡有項目疑似夾帶完整 SQL 語句全文或憑證/連線字串（" +
                hits.map((h) => `「${h.action}」：${h.reasons.join("、")}`).join("；") +
                "）。這裡只該留技術性描述，完整內容留在內文全文裡就好，不要重複複製進 manualActions。請改寫後再重新呼叫。",
            },
            true
          );
        }
      }

      await recordArtifactHash(taskGid, filename, content);
      if (summary) await recordArtifactSummary(taskGid, filename, summary);
      if (manualActions && (filename === "02-implementation.md" || filename === "03-verification.md")) {
        await recordManualActions(taskGid, filename, manualActions);
      }
      await syncPendingActionsReport(taskGid);
      return textResult({ success: true, taskGid, filename, message: "雜湊已同步為目前磁碟上的實際內容。" });
    }
  );
}
