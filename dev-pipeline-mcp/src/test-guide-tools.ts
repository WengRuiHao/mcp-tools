import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getTemplatesDir } from "./config-store.js";
import { textResult } from "./shared.js";

export function registerTestGuideTools(server: McpServer): void {
  server.tool(
    "get_test_engineer_guide",
    "取得測試工程師說明書：設計測試案例、跑手動/情境測試時查的檢查清單，跟「驗證師」角色的規格/程式碼交叉核對是不同用途。" +
      "涵蓋三章：一、通用測試框架（等價分類/邊界值、狀態機跳轉、權限矩陣、負向測試、回歸測試，所有專案都適用）；" +
      "二、報表測試（分組小計、跨頁表頭、格式在地化、空值抑制、新舊報表逐欄比對，Crystal → Jasper 遷移類報表適用，可搭配 crystal-to-jasper-mcp 的工具）；" +
      "三、老舊系統測試（JDK6 + 舊 IE 這類環境：doc mode/VM 環境準備、自動化 ROI 低改走手動+截圖比對、瀏覽器相依功能相容矩陣、老版本 JDK 建置實測、已知怪異行為先記基準避免誤判）。" +
      "驗證師階段判斷該測哪些情境、或使用者手動驗收前，都可以呼叫這個工具取得對應章節的檢查清單。",
    {},
    async () => {
      const content = await readFile(path.join(getTemplatesDir(), "TEST_ENGINEER_GUIDE.md"), "utf8");
      return textResult(content);
    }
  );
}
