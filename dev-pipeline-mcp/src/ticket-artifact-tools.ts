import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  readStatus,
  writeArtifact,
  readArtifact,
  readArtifactResult,
  recordArtifactHash,
  recordArtifactSummary,
  recordStageSync,
  recordManualActions,
  resolveTicketDir,
  resolveArtifactPath,
  detectSensitiveManualActions,
  NO_SYNC_NEEDED,
} from "./pipeline-store.js";
import { checkAnalysisGates, checkImplementationGates } from "./project-gates.js";
import { syncPendingActionsReport } from "./pending-actions-sync.js";
import { textResult } from "./shared.js";
import {
  TEST_LEVELS,
  checkTestEvidenceForArtifact,
  mergeEvidenceManualActions,
  pendingScreenshotActions,
  recordTestDeclaration,
} from "./test-evidence-store.js";

const WRITE_MODES = ["overwrite", "append", "replace"] as const;
type WriteMode = (typeof WRITE_MODES)[number];

type Composed = { ok: true; content: string } | { ok: false; body: Record<string, unknown> };

/** 該 artifact 的絕對路徑（用 pipeline-store 的路徑解析，不自己拼）。 */
async function artifactFilePath(taskGid: string, filename: string): Promise<string> {
  return resolveArtifactPath(await resolveTicketDir(taskGid), filename);
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** 依 mode 算出「套用後的完整內容」；後續所有關卡都對這份內容檢查。不寫檔。 */
async function composeContent(
  taskGid: string,
  filename: string,
  mode: WriteMode,
  content: string | undefined,
  oldString: string | undefined,
  newString: string | undefined
): Promise<Composed> {
  const fail = (message: string, extra: Record<string, unknown> = {}): Composed => ({ ok: false, body: { success: false, message, ...extra } });
  if (mode === "overwrite") {
    return typeof content === "string" ? { ok: true, content } : fail(`overwrite 模式必須帶 content（全文）。`);
  }
  const existing = await readArtifactResult(taskGid, filename);
  if (existing.status === "not_found") {
    if (mode === "replace") return fail(`${filename} 不存在，無法 replace；請改用 mode=overwrite 或 append 建立。`);
  } else if (existing.status !== "ok") {
    return fail(existing.message, { reason: existing.status });
  }
  const current = existing.status === "ok" ? existing.content : "";
  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  const toEol = (t: string): string => t.replace(/\r\n|\r|\n/g, eol);

  if (mode === "append") {
    if (typeof content !== "string" || content === "") return fail("append 模式必須帶非空的 content。");
    const addition = current.includes("\n") || current === "" ? toEol(content) : content;
    const sep = current !== "" && !current.endsWith("\n") ? eol : "";
    return { ok: true, content: current + sep + addition };
  }
  if (!oldString) return fail("replace 模式必須帶非空的 oldString。");
  if (typeof newString !== "string") return fail("replace 模式必須帶 newString（要刪除就帶空字串）。");
  const needle = toEol(oldString);
  const matchCount = countOccurrences(current, needle);
  if (matchCount !== 1) {
    return fail(
      matchCount === 0
        ? `oldString 在 ${filename} 中找不到（matchCount=0），未做任何修改；請先 read_ticket_artifact 確認原文。`
        : `oldString 在 ${filename} 中出現 ${matchCount} 次，必須恰好一次；請加長 oldString 使其唯一。`,
      { matchCount }
    );
  }
  const at = current.indexOf(needle);
  return { ok: true, content: current.slice(0, at) + toEol(newString) + current.slice(at + needle.length) };
}

export function registerTicketArtifactTools(server: McpServer): void {
  server.tool(
    "write_ticket_artifact",
    "寫入票單追蹤目錄的 01-analysis.md／02-implementation.md／03-verification.md／04-test.md，成功回傳 filePath。" +
      "mode：overwrite（預設，整份覆寫）｜append（接在後面）｜replace（oldString 須恰好出現一次，換成 newString；檔案不存在則拒絕）。關卡對套用後的完整內容檢查。" +
      "寫 01 前須已 record_sasd_check，且過專案 gates.json 的分析關卡（02 另有實作關卡）。overwrite 必帶 summary。" +
      `寫 02/03/04 必填 syncNote（無需同步帶 "${NO_SYNC_NEEDED}"）與 manualActions（沒有帶 []）。` +
      "**寫 04 另必填 producesOfficeFiles 與 testLevel（須等於證據最高層級）**，且須先 record_test_evidence 至少 1 筆；內文要有標題含「測試證據」的一節、提及每筆證據的功能名稱與 testLevel，producesOfficeFiles=true 另需 excel/pdf 證據。",
    {
      taskGid: z.string().describe("任務 gid"),
      filename: z
        .enum(["01-analysis.md", "02-implementation.md", "03-verification.md", "04-test.md"])
        .describe("要寫入哪一份追蹤文件"),
      mode: z.enum(WRITE_MODES).optional().describe("overwrite（預設）｜append｜replace"),
      content: z.string().optional().describe("overwrite：全文；append：接在後面的內容；replace 不用"),
      oldString: z.string().optional().describe("replace：被取代的文字，須恰好出現一次"),
      newString: z.string().optional().describe("replace：取代後文字（可為空字串）"),
      summary: z
        .string()
        .nullable()
        .optional()
        .describe("摘要（2-4 條重點）；overwrite 必填，append/replace 可省略（沿用既有）"),
      syncNote: z
        .string()
        .nullable()
        .optional()
        .describe(`02/03/04 必填。新發現寫這裡（自動附加到上一階段文件）；不需同步帶 "${NO_SYNC_NEEDED}"`),
      manualActions: z
        .array(z.string())
        .nullable()
        .optional()
        .describe(
          "02/03/04 必填（陣列）：需使用者手動處理的事項（04 為 needs_manual_check 項目），沒有帶 []。未 commit 另列一條「已完成但尚未commit：檔名A、檔名B」（含「commit」與帶副檔名的檔名）"
        ),
      producesOfficeFiles: z
        .boolean()
        .nullable()
        .optional()
        .describe("04 必填：本次測試是否產出 Excel/PDF；其他檔忽略"),
      testLevel: z
        .enum(TEST_LEVELS)
        .nullable()
        .optional()
        .describe("04 必填：unit-mock｜integration-db｜live-api，須等於證據最高層級；其他檔忽略"),
    },
    async ({ taskGid, filename, mode, content: rawContent, oldString, newString, summary, syncNote, manualActions, producesOfficeFiles, testLevel }) => {
      const writeMode: WriteMode = mode ?? "overwrite";
      const hasSummary = Boolean(summary && summary.trim());
      if (writeMode === "overwrite" && !hasSummary) {
        return textResult(
          {
            success: false,
            message: `寫入 ${filename} 必須帶 summary（2-4 條重點的精簡摘要）：會存進追蹤狀態供之後低成本接手用，不可省略或留空。`,
          },
          true
        );
      }
      const composed = await composeContent(taskGid, filename, writeMode, rawContent, oldString, newString);
      if (!composed.ok) return textResult(composed.body, true);
      const content = composed.content;

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

      // 04-test.md：測試證據關卡，通過後把仍待使用者截圖的 Excel 證據自動併入 manualActions。
      let finalManualActions = manualActions;
      if (filename === "04-test.md") {
        if (typeof producesOfficeFiles !== "boolean") {
          return textResult(
            {
              success: false,
              message: "寫入 04-test.md 必須帶 producesOfficeFiles：這次測試有沒有產出 Excel/PDF？有就帶 true，沒有帶 false，不能省略。",
            },
            true
          );
        }
        if (!testLevel) {
          return textResult(
            {
              success: false,
              message: `寫入 04-test.md 必須帶 testLevel（${TEST_LEVELS.join("｜")}）：unit-mock＝依賴全是 mock；integration-db＝有連真實資料庫；live-api＝打真實運行中的服務。要等於證據中最高層級。`,
            },
            true
          );
        }
        const status = await readStatus(taskGid);
        const reason = checkTestEvidenceForArtifact(status, { content, testLevel, producesOfficeFiles });
        if (reason) return textResult({ success: false, message: reason }, true);
        const ticketDir = await resolveTicketDir(taskGid);
        const hits = detectSensitiveManualActions(pendingScreenshotActions(status, ticketDir));
        if (hits.length > 0) {
          return textResult(
            { success: false, message: "自動產生的待截圖待辦疑似含敏感內容，請檢查證據的功能名稱（featureName）是否夾帶憑證或 SQL，改名後用 record_test_evidence 重新記錄。" },
            true
          );
        }
        finalManualActions = mergeEvidenceManualActions(manualActions!, status, ticketDir);
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

      // 先寫檔案，再依序記錄；檔案寫入失敗就什麼狀態都不動，記錄失敗則明確告知「檔案已寫入但 status 未同步」。
      try {
        await writeArtifact(taskGid, filename, content);
      } catch (err: any) {
        return textResult(
          { success: false, message: `寫入 ${filename} 失敗，檔案與追蹤狀態都沒有變動：${err?.message ?? String(err)}` },
          true
        );
      }

      let step = "recordArtifactHash";
      try {
        await recordArtifactHash(taskGid, filename, content);
        step = "recordArtifactSummary";
        if (hasSummary) await recordArtifactSummary(taskGid, filename, summary);
        if (needsSyncNote) {
          const stageFile = filename as "02-implementation.md" | "03-verification.md" | "04-test.md";
          step = "recordStageSync";
          await recordStageSync(taskGid, stageFile, syncNote!.trim());
          step = "recordManualActions";
          await recordManualActions(taskGid, stageFile, finalManualActions!);
        }
        if (filename === "04-test.md") {
          step = "recordTestDeclaration";
          await recordTestDeclaration(taskGid, producesOfficeFiles!, testLevel!);
        }
        step = "syncPendingActionsReport";
        await syncPendingActionsReport(taskGid);
      } catch (err: any) {
        return textResult(
          {
            success: false,
            fileWritten: true,
            failedStep: step,
            message:
              `${filename} 的檔案內容已寫入，但追蹤狀態未完整同步（失敗步驟：${step}，原因：${err?.message ?? String(err)}）。` +
              `請呼叫 resync_ticket_artifact({ taskGid, filename${needsSyncNote ? ", manualActions" : ""} }) 補同步雜湊/狀態` +
              (needsSyncNote ? "，並視需要重新確認 syncNote 是否已附加到上一階段文件。" : "。"),
          },
          true
        );
      }
      return textResult({ success: true, taskGid, filename, filePath: await artifactFilePath(taskGid, filename) });
    }
  );

  server.tool(
    "read_ticket_artifact",
    "讀取票單追蹤目錄下的一個檔案（如 ticket.md / 01-analysis.md）。",
    { taskGid: z.string().describe("任務 gid"), filename: z.string().describe("檔名，例如 ticket.md") },
    async ({ taskGid, filename }) => {
      const result = await readArtifactResult(taskGid, filename);
      if (result.status === "ok") return textResult({ success: true, filePath: await artifactFilePath(taskGid, filename), content: result.content });
      return textResult({ success: false, content: null, reason: result.status, message: result.message }, true);
    }
  );

  server.tool(
    "resync_ticket_artifact",
    "把 01-04 其中一份追蹤檔案磁碟上的實際內容重新雜湊、寫回 status.json。" +
      "用在檔案剛被一般編輯工具（非 write_ticket_artifact）直接改過之後；不需 syncNote、不觸發角色階段，只更新雜湊，不判斷修改是否正確。" +
      "summary 選填（修改大到摘要該換時才帶）。manualActions 選填（陣列）：回填舊 02/03/04 檔案裡散落在自由文字的人工待辦（01 不支援）。",
    {
      taskGid: z.string().describe("任務 gid"),
      filename: z
        .enum(["01-analysis.md", "02-implementation.md", "03-verification.md", "04-test.md"])
        .describe("要重新同步雜湊的檔"),
      summary: z
        .string()
        .nullable()
        .optional()
        .describe("修改大到摘要該更新時才帶；不帶只更新雜湊"),
      manualActions: z
        .array(z.string())
        .nullable()
        .optional()
        .describe("回填文件裡的人工待辦（僅 02/03/04 有意義）；不帶就不動"),
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
