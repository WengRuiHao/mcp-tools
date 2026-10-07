import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readStatus } from "./pipeline-store.js";
import { syncPendingActionsReport } from "./pending-actions-sync.js";
import { textResult } from "./shared.js";
import { EVIDENCE_KINDS, FAKE_DATA_LABEL, TEST_LEVELS, EvidenceInputError, recordTestEvidence } from "./test-evidence-store.js";

export function registerTestEvidenceTools(server: McpServer): void {
  server.tool(
    "record_test_evidence",
    "測試工程師記錄一筆測試證據：把證據檔**複製**（不是移動）備份到 `<票單目錄>/test-evidence/<功能名稱>/`，並寫進 status.json 的 test_evidence，讓使用者能回頭觀察。**每筆只存一個可直接觀察的檔案**：真實資料存 `<原檔名>.<副檔名>`；假資料存 `<原檔名>_假資料.<副檔名>` 並放進 `【假資料】<功能名稱>` 資料夾（截圖命名 `<原檔名>_假資料_截圖_N`），不再另存原始檔；sourceFile 的絕對路徑與 sha256 只記在 status.json 供追溯。同一筆（功能＋原檔名）再次呼叫會把舊格式備份（`_原始`、`_假資料標註`、舊資料夾名，含 Office 鎖定檔 `~$`）換成新命名並刪除舊檔；舊檔刪不掉（例如被 Excel 開著）不會讓登記失敗，回傳 success:true 與 `cleanupWarnings`，關閉檔案後再呼叫一次即可重試清理。" +
      "每張票都要有至少 1 筆證據：write_ticket_artifact 寫 04-test.md 與 advance_ticket_stage 推進到 tested 都會檢查。\n" +
      "fileKind：excel／pdf（實際產出的檔案）、api-call（實際呼叫記錄原文：method、URL、request、HTTP 狀態、response、耗時；.json/.txt/.http/.md）、" +
      "test-report（gradle test 等的測試報告；.xml/.html/.txt/.json）、db-state（測試前後的唯讀查詢結果；.csv/.json/.txt/.md）。\n" +
      "testLevel（必填）：unit-mock＝依賴全是 mock；integration-db＝有連真實資料庫；live-api＝打真實運行中的服務。只有 unit-mock 時不得宣稱已驗證真實 DB／真實 API。\n" +
      "規則：1) 截圖必須來自實際檔案的真實渲染，禁止用轉網頁重畫、依公式重算的圖當證據。" +
      "2) pdf 必須帶 screenshotPaths（用 PyMuPDF 逐頁轉 PNG）；excel 沒有截圖會標記「待使用者截圖」，並在寫 04-test.md 時自動產生待辦，使用者截圖後放進同一資料夾或再呼叫本工具補登（同功能＋同原檔名重複呼叫＝更新同一筆）。" +
      `3) usesFakeData=true：excel/pdf 要提供 markedFile（副本，檔案本身標註「${FAKE_DATA_LABEL}」，紅字粗體、字級 14 以上、放在第一眼看得到的位置）並明確帶 fakeDataMarked:true，存進證據資料夾的是 markedFile，sourceFile 不複製；api-call/db-state 則 sourceFile 第一個非空白行必須就是該標註文字（工具會讀檔驗證）；test-report 不改檔，只靠檔名、資料夾與記錄標示。寫 04-test.md 時「測試證據」表格欄位：功能名稱｜資料來源（假資料／真實資料）｜測試層級｜檔案類型｜證據檔位置（單一檔案）｜截圖｜備註。` +
      "4) api-call/db-state/test-report 的文字檔會掃描未遮蔽的 Authorization/Bearer token、JWT、password/secret/api key/token 值、連線字串帳密，命中就拒絕並回報檔名與行號（不回印內容），請遮蔽成 **** 後重送。" +
      "路徑一律限制在票單目錄內，拒絕不存在、非一般檔案、符號連結、副檔名不符、超過 50MB。",
    {
      taskGid: z.string().describe("Asana 任務 gid"),
      featureName: z.string().min(1).describe("功能名稱（例如「某報表 Excel 匯出」），會當作備份資料夾名稱，自動做檔名安全處理"),
      fileKind: z.enum(EVIDENCE_KINDS).describe("證據類型：excel | pdf | api-call | test-report | db-state"),
      testLevel: z.enum(TEST_LEVELS).describe("測試層級：unit-mock | integration-db | live-api"),
      testSource: z.string().nullable().optional().describe("選填：證據怎麼取得（例如指令或測試類別名稱）"),
      sourceFile: z.string().describe("實際產出（或實際擷取）的檔案絕對路徑，必須存在且是一般檔案"),
      usesFakeData: z.boolean().describe("這次測試是否用了假資料"),
      markedFile: z.string().nullable().optional().describe(`excel/pdf 且 usesFakeData=true 時必填：已標註「${FAKE_DATA_LABEL}」的副本絕對路徑（會被存成證據檔）`),
      fakeDataMarked: z.boolean().nullable().optional().describe("excel/pdf 且 usesFakeData=true 時必須明確帶 true：確認副本內已依規定標註"),
      screenshotPaths: z.array(z.string()).nullable().optional().describe("實際渲染截圖的絕對路徑（png/jpg/jpeg）。pdf 必填至少 1 張；excel 可省略（會標記待使用者截圖）；其他類型可省略"),
      note: z.string().nullable().optional().describe("選填備註"),
    },
    async (args) => {
      try {
        const { record, backupDir, cleanupWarnings } = await recordTestEvidence(args);
        await syncPendingActionsReport(args.taskGid);
        const status = await readStatus(args.taskGid);
        return textResult({
          success: true,
          taskGid: args.taskGid,
          evidence: {
            id: record.id,
            featureName: record.featureName,
            fileKind: record.fileKind,
            testLevel: record.testLevel,
            usesFakeData: record.usesFakeData,
            backupDir,
            files: record.files,
            pendingManualScreenshot: record.pendingManualScreenshot,
          },
          totalEvidence: status.test_evidence.length,
          cleanupWarnings,
          message:
            (record.pendingManualScreenshot
              ? "已備份。這是 Excel 證據，尚無實際渲染截圖：寫 04-test.md 時會自動產生「待使用者截圖」待辦；使用者截圖放進同一資料夾後，再呼叫本工具補登（帶 screenshotPaths）即可清除待截圖旗標。"
              : "已備份並記錄。") +
            (cleanupWarnings.length > 0
              ? `已登記，但有 ${cleanupWarnings.length} 個舊檔未能刪除（見 cleanupWarnings，多半是檔案被 Excel 等程式開啟）：關閉後再呼叫一次本工具（同功能名稱與原檔名）即可完成清理，登記不受影響。`
              : ""),
        });
      } catch (err: any) {
        if (err instanceof EvidenceInputError) return textResult({ success: false, message: err.message }, true);
        return textResult({ success: false, message: `記錄測試證據失敗：${err.message}` }, true);
      }
    }
  );
}
