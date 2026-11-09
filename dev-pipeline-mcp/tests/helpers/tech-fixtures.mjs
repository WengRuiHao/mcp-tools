// 技術選型相關的測試檔案內容：既有系統現況盤點的「現有技術棧」與各技術來源合格的 tech-stack.md。

/** 既有系統現況盤點必填的「## 現有技術棧」。 */
export const BASELINE_TECH_OK = "基線\n## 現有技術棧\n- 前端 Vue 3、後端 Java 17、MySQL 8\n";

export const STACK_TABLE =
  "| 項目 | 內容 |\n| --- | --- |\n| 前端語言 | TypeScript |\n| 前端框架 | Vue 3 |\n| 前端元件庫 | Element Plus |\n| 後端語言 | Java |\n| 後端框架 | Spring Boot |\n| 資料庫種類 | MySQL |\n| 資料庫版本 | 8.0 |\n| 建置與測試工具 | Maven、JUnit 5 |\n| 主要版本 | Java 17、Vue 3.4 |\n";

const CANDIDATES =
  "## 候選方案\n### 方案 A\n優缺點：成熟穩定。學習與維運成本：低。與現有專案相容性：高。\n### 方案 B\n優缺點：新穎。學習與維運成本：高。與現有專案相容性：中。\n";

/** 依技術來源產生合格的 tech-stack.md。 */
export function techStackFor(source) {
  const extra = source === "new-select" ? CANDIDATES : source === "change" ? "## 目標技術\n使用者指定改用 Vue 3。\n" : "";
  const reason = source === "new-select" ? "選方案 A，因為成熟穩定。" : "依來源決定。";
  return `## 技術來源\n${source}\n${extra}## 技術棧\n${STACK_TABLE}## 選擇理由\n${reason}\n`;
}
