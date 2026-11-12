// 內部過程檔名單：正式交付物（SA、SD、資料表結構文件、流程圖）不可提及。SA／SD 標準檢查與交付物引用檢查共用，避免各自維護造成判定不一致。

/** 正式交付物本身的檔名：SA、SD 內文不可互相以檔名稱呼（資料表結構文件可連到 03-sd.md，不在此限）。 */
const SELF_DELIVERABLE_TERMS: readonly string[] = ["01-sa", "03-sd"];

/** SA 標準檢查使用的內部檔名（維持原有清單與順序）。 */
export const SA_INTERNAL_TERMS: readonly string[] = ["01-sa", "02-db", "03-sd", "spec-check", "sa-notes", ".dev-pipeline"];

/** SD 標準檢查使用的內部檔名（維持原有清單與順序）。 */
export const SD_INTERNAL_TERMS: readonly string[] = ["01-sa", "02-db", "03-sd", "spec-check", "sa-notes", "impl-fe", "impl-be", "dup-report", ".dev-pipeline", "verify.md", "test.md", "impact.md", "baseline.md", "tech-stack.md"];

/** 交付物引用檢查：任何正式交付物都不可提及的內部檔名與目錄（不含正式交付物自己的檔名）。 */
export const INTERNAL_POINTER_TERMS: readonly string[] = [...new Set([...SA_INTERNAL_TERMS, ...SD_INTERNAL_TERMS, "sa-mockup", "02-db.sql", "item.md", "final-summary.md", "status.json", "00-索引"])].filter((t) => !SELF_DELIVERABLE_TERMS.includes(t));

/** 內部過程檔中不是流程產出物的檔案（列「內部過程檔清單」時一併列出）。 */
export const EXTRA_INTERNAL_FILES: readonly string[] = ["dup-report.md", "00-索引.md"];

/** 系統依 status.json 與流程定義自動產生的索引檔（不是任何角色的產出物、不可被要求產出、AI 不可手寫）。 */
export const INDEX_DOC_FILE = "00-索引.md";
