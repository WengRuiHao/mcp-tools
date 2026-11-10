// 版本管控歷程檢查：SA、SD、資料表結構文件共用。
// 文件必須有「## 版本管控歷程」一節，裡面是固定表頭的表格，至少一列，版次遞增、日期 YYYY/MM/DD、修訂說明有實質內容。
import { parseTable } from "./md-table.js";
import { extractSection } from "./reuse-record-check.js";

export const VERSION_HISTORY_HEADING = "版本管控歷程";
export const VERSION_HISTORY_HEADER: readonly string[] = ["版次", "發行日期", "修訂說明", "修訂單位", "修訂人員"];
const VERSION_RE = /^(\d+)\.(\d+)$/;
const DATE_RE = /^(\d{4})\/(\d{2})\/(\d{2})$/;
/** 修訂說明只有這些詞（去掉標點與空白後）視為空洞。 */
const EMPTY_WORDS: readonly string[] = ["調整", "修正", "更新", "修改", "異動", "變更", "補充", "新增", "增修", "修訂", "略", "無", "同上", "na", "none", "tbd"];

const clean = (cell: string): string => cell.replace(/[`*_]/g, "").trim();
const isEmptyExplanation = (v: string): boolean => v === "" || EMPTY_WORDS.includes(v.replace(/[\s。.，,、：:；;\-—（）()]/g, "").toLowerCase());

function isRealDate(v: string): boolean {
  const m = DATE_RE.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

function checkRow(row: readonly string[], where: string, prev: [number, number] | null): { problems: string[]; version: [number, number] | null } {
  const [version, date, note] = row.map(clean);
  const problems: string[] = [];
  let parsed: [number, number] | null = null;
  const vm = VERSION_RE.exec(version ?? "");
  if (!vm) problems.push(`${where}版次「${version ?? ""}」格式不正確（例如 0.1、0.2 或 1.0、1.1）`);
  else {
    parsed = [Number(vm[1]), Number(vm[2])];
    if (prev && (parsed[0] < prev[0] || (parsed[0] === prev[0] && parsed[1] <= prev[1]))) problems.push(`${where}版次 ${version} 必須大於上一列（版次要遞增）`);
  }
  if (!isRealDate(date ?? "")) problems.push(`${where}發行日期「${date ?? ""}」必須是存在的日期，格式 YYYY/MM/DD`);
  if (isEmptyExplanation(note ?? "")) problems.push(`${where}修訂說明空白或只有「調整」「修正」「更新」這類空洞詞，請寫出這一版實際改了什麼`);
  return { problems, version: parsed };
}

/** 檢查文件全文的版本管控歷程；回傳違規逐項說明（空陣列＝合格）。fileName 只用於訊息。 */
export function checkVersionHistory(text: string, fileName = "文件"): string[] {
  const body = extractSection(text, VERSION_HISTORY_HEADING);
  if (body === null) return [`${fileName} 缺少「## ${VERSION_HISTORY_HEADING}」一節`];
  const table = parseTable(body);
  if (table === null) return [`${fileName}「${VERSION_HISTORY_HEADING}」必須是 markdown 表格，表頭固定為：${VERSION_HISTORY_HEADER.join("｜")}`];
  const header = table.header.map(clean);
  if (header.length !== VERSION_HISTORY_HEADER.length || header.some((h, i) => h !== VERSION_HISTORY_HEADER[i])) {
    return [`${fileName}「${VERSION_HISTORY_HEADING}」表頭必須是：${VERSION_HISTORY_HEADER.join("｜")}（目前是：${header.join("｜")}）`];
  }
  if (table.rows.length === 0) return [`${fileName}「${VERSION_HISTORY_HEADING}」至少要有一列（初版也要記錄）`];
  const problems: string[] = [];
  let prev: [number, number] | null = null;
  table.rows.forEach((row, i) => {
    const where = `${fileName}「${VERSION_HISTORY_HEADING}」第 ${i + 1} 列`;
    if (row.length < VERSION_HISTORY_HEADER.length) {
      problems.push(`${where}欄位不足（需要 ${VERSION_HISTORY_HEADER.length} 欄）`);
      return;
    }
    const r = checkRow(row, where, prev);
    problems.push(...r.problems);
    if (r.version) prev = r.version;
  });
  return problems;
}
