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
import { checkAnalysisGates, checkImplementationGates } from "./project-gates.js";
import { syncPendingActionsReport } from "./pending-actions-sync.js";
import { textResult } from "./shared.js";

export function registerTicketArtifactTools(server: McpServer): void {
  server.tool(
    "write_ticket_artifact",
    "把內容寫入某張票單追蹤目錄下的檔案（01-analysis.md / 02-implementation.md / 03-verification.md / 04-test.md）。" +
      "**content 是整份覆寫、不是附加**：檔案已有內容時，先 read_ticket_artifact 讀全文，組合舊＋新內容再整份送入，否則先前內容永久遺失。" +
      "寫 01-analysis.md 前必須已呼叫 record_sasd_check，且需通過專案 gates.json（<projectDir>/.pipeline/gates.json）的分析關卡（寫 02-implementation.md 亦有實作關卡），否則拒絕並說明缺什麼。" +
      "寫 01–04 都要帶 summary（2-4 條重點）；寫 01-analysis.md 會清掉 needs_reanalysis 標記。" +
      `寫 02/03/04 必填 syncNote（對上一階段有無修正；沒有就帶 "${NO_SYNC_NEEDED}"）與 manualActions（需使用者手動處理的事項，沒有帶 []），缺少會被拒絕。` +
      "寫入後自動局部重寫該 Asana 專案的 PENDING_HUMAN_ACTIONS.html。",
    {
      taskGid: z.string().describe("Asana 任務 gid"),
      filename: z
        .enum(["01-analysis.md", "02-implementation.md", "03-verification.md", "04-test.md"])
        .describe("要寫入哪一份追蹤文件"),
      content: z.string().describe("要寫入的內容（全文，整份覆寫既有檔案——若檔案已有內容，先呼叫 read_ticket_artifact 讀出全文再組合，不要只傳這一輪新增段落）"),
      summary: z
        .string()
        .nullable()
        .optional()
        .describe("這份內容的精簡摘要（2-4 條重點），filename 是 01/02/03/04-*.md 時務必提供，會存進追蹤狀態供之後低成本接手用"),
      syncNote: z
        .string()
        .nullable()
        .optional()
        .describe(
          `filename 是 02-implementation.md／03-verification.md／04-test.md 時必填。有新發現/結論變動就寫進這裡（會自動附加到上一階段文件）；` +
            `確認這次不需要同步，就帶入字串 "${NO_SYNC_NEEDED}"。留空／不帶會被拒絕寫入。`
        ),
      manualActions: z
        .array(z.string())
        .nullable()
        .optional()
        .describe(
          "02/03/04 必填（陣列）。列出需使用者手動處理的事項（例如「已產出 SQL，見內文，需自行到 Database 工具執行」；04-test.md 則是 needs_manual_check 項目）；沒有就帶 []。" +
            "檔案還沒 commit 時另列一條固定格式「已完成但尚未commit：檔名A、檔名B」（含「commit」二字與帶副檔名的檔名），Git 板塊只認這格式。"
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
        if (status.project_dir) {
          const gate = await checkAnalysisGates({
            projectDir: status.project_dir,
            ticketName: status.name ?? "",
            analysisContent: content,
            hasSasd: Boolean(status.sasd_info),
          });
          if (!gate.ok) return textResult({ success: false, message: gate.message }, true);
        }
      }

      const SYNC_UPSTREAM: Record<string, string> = {
        "02-implementation.md": "01-analysis.md",
        "03-verification.md": "02-implementation.md",
        "04-test.md": "03-verification.md",
      };
      const needsSyncNote = filename in SYNC_UPSTREAM;
      if (needsSyncNote && (!syncNote || !syncNote.trim())) {
        const upstream = SYNC_UPSTREAM[filename];
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

      if (filename === "02-implementation.md") {
        const status = await readStatus(taskGid);
        if (status.project_dir) {
          const gate = await checkImplementationGates({
            projectDir: status.project_dir,
            ticketName: status.name ?? "",
            implementationContent: content,
          });
          if (!gate.ok) return textResult({ success: false, message: gate.message }, true);
        }
      }

      if (needsSyncNote) {
        await recordStageSync(taskGid, filename as "02-implementation.md" | "03-verification.md" | "04-test.md", syncNote!.trim());
        await recordManualActions(taskGid, filename as "02-implementation.md" | "03-verification.md" | "04-test.md", manualActions!);
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
    "把 01-04 其中一份追蹤檔案目前磁碟上的實際內容重新雜湊、寫回 status.json。" +
      "用在這份檔案剛被一般編輯工具（非 write_ticket_artifact）直接改過之後；不需要 syncNote、不觸發任何角色階段，只更新雜湊，不判斷修改是否正確。" +
      "summary 選填（手動修改大到摘要該換時才帶）。manualActions 選填（陣列）：回填 manualActions 機制上線前寫的舊 02/03/04 檔案裡散落在自由文字的人工待辦（01 不支援）。",
    {
      taskGid: z.string().describe("Asana 任務 gid"),
      filename: z
        .enum(["01-analysis.md", "02-implementation.md", "03-verification.md", "04-test.md"])
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
        .describe("回填這份文件裡藏著的人工待辦事項（只對 02-implementation.md／03-verification.md／04-test.md 有意義）；不帶就不動這個欄位，維持原樣"),
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
      if (manualActions && (filename === "02-implementation.md" || filename === "03-verification.md" || filename === "04-test.md")) {
        await recordManualActions(taskGid, filename, manualActions);
      }
      await syncPendingActionsReport(taskGid);
      return textResult({ success: true, taskGid, filename, message: "雜湊已同步為目前磁碟上的實際內容。" });
    }
  );
}
