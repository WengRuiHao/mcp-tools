// 前端工程師交稿前自檢：impl-fe.md 必須有「## 交稿前自檢」表格（項目｜結果｜說明），
// 7 個標準項目各一列，結果填「已做」或「不適用」，不適用必須在說明寫理由。
import { extractSection, tableDataRows } from "./reuse-record-check.js";

export const FE_SELF_CHECK_HEADING = "交稿前自檢";
/** 標準項目：項目欄必須包含的關鍵字（說明書建議的項目名稱都含有這些字）。 */
export const FE_SELF_CHECK_ITEMS: readonly string[] = ["去空白", "數值", "狀態", "用詞", "共用", "測試", "實機"];
const RESULT_DONE = "已做";
const RESULT_NA = "不適用";
const MIN_COLUMNS = 3;

export const FE_SELF_CHECK_EXAMPLE =
  `格式範例（每個標準項目各一列，共 ${FE_SELF_CHECK_ITEMS.length} 項：文字去空白、數值顯示、狀態不誤清、標籤用詞、共用歸屬、測試、實機畫面）：\n` +
  "| 項目 | 結果 | 說明 |\n| --- | --- | --- |\n| 文字去空白 | 已做 | 訂單編號送出前 trim |\n| 數值顯示 | 不適用 | 本功能沒有金額或數量欄位 |";

const clean = (cell: string): string => cell.replace(/[`*_]/g, "").trim();

export function checkFeSelfCheck(text: string, fileName: string): string[] {
  const where = `${fileName}「${FE_SELF_CHECK_HEADING}」`;
  const body = extractSection(text, FE_SELF_CHECK_HEADING);
  if (body === null) return [`${fileName} 缺少「## ${FE_SELF_CHECK_HEADING}」一節。${FE_SELF_CHECK_EXAMPLE}`];
  const rows = tableDataRows(body);
  if (rows === null) return [`${where}必須是 markdown 表格（表頭＋分隔列＋資料列）。${FE_SELF_CHECK_EXAMPLE}`];
  const problems = rows.flatMap((r, i) => {
    const at = `${where}第 ${i + 1} 列`;
    if (r.length < MIN_COLUMNS) return [`${at}欄位不足（需要 ${MIN_COLUMNS} 欄：項目｜結果｜說明）`];
    const result = clean(r[1]);
    if (result !== RESULT_DONE && result !== RESULT_NA) return [`${at}結果「${result}」不合法（只能填「${RESULT_DONE}」或「${RESULT_NA}」）`];
    if (result === RESULT_NA && clean(r[2]) === "") return [`${at}結果為「${RESULT_NA}」，說明必須寫理由`];
    return [];
  });
  const missing = FE_SELF_CHECK_ITEMS.filter((k) => !rows.some((r) => clean(r[0] ?? "").includes(k)));
  const missingMsgs = missing.map((k) => `${where}缺少自檢項目「${k}」`);
  const all = [...problems, ...missingMsgs];
  return all.length === 0 ? [] : [...all.slice(0, -1), `${all[all.length - 1]}。${FE_SELF_CHECK_EXAMPLE}`];
}
