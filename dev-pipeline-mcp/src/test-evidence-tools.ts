import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readStatus } from "./pipeline-store.js";
import { syncPendingActionsReport } from "./pending-actions-sync.js";
import { textResult } from "./shared.js";
import { EVIDENCE_KINDS, FAKE_DATA_LABEL, TEST_LEVELS, EvidenceInputError, recordTestEvidence } from "./test-evidence-store.js";

export function registerTestEvidenceTools(server: McpServer): void {
  server.tool(
    "record_test_evidence",
    "測試工程師記錄一筆測試證據：**複製**（不是移動）證據檔備份到 `<票單目錄>/test-evidence/<功能名稱>/` 並寫進 status.json。**每筆只存一個可直接觀察的檔案**：真實資料存 `<原檔名>.<副檔名>`；假資料存 `<原檔名>_假資料.<副檔名>` 並放進 `【假資料】<功能名稱>` 資料夾。同功能＋同原檔名再次呼叫＝更新同一筆；舊檔刪不掉不使登記失敗，回傳 `cleanupWarnings`，關檔後再呼叫重試。" +
      "每張票至少 1 筆：write_ticket_artifact 寫 04-test.md 與 advance_ticket_stage 到 tested 都會檢查。" +
      "只有 unit-mock（依賴全是 mock）的 testLevel 不得宣稱已驗證真實 DB／API。\n" +
      "規則：1) 截圖必須來自實際檔案的真實渲染，禁止用轉網頁重畫、依公式重算的圖當證據。" +
      "2) pdf 必須帶 screenshotPaths；excel 沒截圖會標記「待使用者截圖」並自動產生待辦，補截圖後再呼叫本工具。" +
      `3) usesFakeData=true：excel/pdf 要提供 markedFile（副本，標註「${FAKE_DATA_LABEL}」，紅字粗體、字級 14 以上、第一眼可見）並帶 fakeDataMarked:true；api-call/db-state 的 sourceFile 第一個非空白行必須就是該標註文字（會讀檔驗證）；test-report 不改檔。` +
      "4) 文字檔會掃描未遮蔽的 Authorization/Bearer token、JWT、password/secret/api key/token 值、連線字串帳密，命中即拒絕（回報檔名與行號），請遮蔽成 **** 後重送。" +
      "路徑限制在票單目錄內，拒絕不存在、非一般檔案、符號連結、副檔名不符、超過 50MB。",
    {
      taskGid: z.string().describe("任務 gid"),
      featureName: z.string().min(1).describe("功能名稱，當備份資料夾名（自動處理檔名安全）"),
      fileKind: z.enum(EVIDENCE_KINDS).describe("證據類型"),
      testLevel: z.enum(TEST_LEVELS).describe("測試層級"),
      testSource: z.string().nullable().optional().describe("選填：證據取得方式（指令或測試類別名稱）"),
      sourceFile: z.string().describe("實際產出/擷取的檔案絕對路徑，須存在且為一般檔案"),
      usesFakeData: z.boolean().describe("這次測試是否用了假資料"),
      markedFile: z.string().nullable().optional().describe(`excel/pdf 且 usesFakeData=true 必填：標註「${FAKE_DATA_LABEL}」的副本絕對路徑`),
      fakeDataMarked: z.boolean().nullable().optional().describe("excel/pdf 且 usesFakeData=true 必須帶 true"),
      screenshotPaths: z.array(z.string()).nullable().optional().describe("實際渲染截圖絕對路徑（png/jpg/jpeg）；pdf 至少 1 張，其他可省略"),
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
