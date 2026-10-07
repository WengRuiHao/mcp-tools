import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getTemplatesDir } from "./config-store.js";
import { textResult } from "./shared.js";

export function registerTestGuideTools(server: McpServer): void {
  server.tool(
    "get_test_engineer_guide",
    "取得測試工程師說明書（設計測試案例、跑手動/情境測試的檢查清單，與驗證師的規格/程式碼交叉核對不同用途）。" +
      "三章：一、通用測試框架（等價分類/邊界值、狀態機跳轉、權限矩陣、負向、回歸，所有專案適用）；二、報表測試（分組小計、跨頁表頭、格式在地化、空值抑制、新舊報表逐欄比對，Crystal → Jasper 遷移適用，可搭配 crystal-to-jasper-mcp）；三、老舊系統測試（JDK6 + 舊 IE 環境準備、手動+截圖比對、瀏覽器相容矩陣、舊 JDK 建置實測、已知怪異行為先記基準）；五、測試證據（每張票都要：record_test_evidence 的證據類型與取得方式、測試層級 unit-mock/integration-db/live-api、機密遮蔽、假資料標註、Excel 人工截圖與 PDF 用 PyMuPDF 渲染、04-test.md「測試證據」一節格式）。",
    {},
    async () => {
      const content = await readFile(path.join(getTemplatesDir(), "TEST_ENGINEER_GUIDE.md"), "utf8");
      return textResult(content);
    }
  );
}
