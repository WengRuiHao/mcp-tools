// S10：重用防線的程式檢查。三項：
// C1 impl-fe.md／impl-be.md 的「## 重用檢查紀錄」表格；C2 impact.md 的「## 可重用清單」；C3 03-sd.md 的「## 重用與共用設計」。
// 標題偵測沿用 sa-image-check 的 listHeadings（略過程式碼區塊）。
import { listHeadings } from "./sa-image-check.js";

export const REUSE_RECORD_HEADING = "重用檢查紀錄";
export const REUSABLE_LIST_HEADING = "可重用清單";
export const SD_REUSE_HEADING = "重用與共用設計";
export const REUSE_DECISIONS: readonly string[] = ["重用", "擴充既有", "新建", "無新增"];
/** 決定為這些值時，理由必填。 */
const REASON_REQUIRED: readonly string[] = ["新建", "無新增"];
const MIN_COLUMNS = 4;
const SECTION_LEVELS: readonly number[] = [2, 3];

/** 取出標題（層級 2～3、標題文字以 name 開頭）底下到下一個同級或更高級標題之前的內容；沒有該標題回 null。 */
export function extractSection(text: string, name: string): string | null {
  const heads = listHeadings(text);
  const at = heads.findIndex((h) => SECTION_LEVELS.includes(h.level) && h.title.startsWith(name));
  if (at < 0) return null;
  const end = heads.slice(at + 1).find((h) => h.level <= heads[at].level);
  const lines = text.split(/\r\n|\r|\n/);
  return lines.slice(heads[at].line, end ? end.line - 1 : lines.length).join("\n");
}

const clean = (cell: string): string => cell.replace(/[`*_]/g, "").trim();
const isSeparator = (cells: readonly string[]): boolean => cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c.trim()));
const splitRow = (line: string): string[] => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

/** 表格資料列（分隔列之後的列）；沒有表頭加分隔列回 null。全空白列略過。 */
function tableDataRows(body: string): string[][] | null {
  const rows = body.split(/\r\n|\r|\n/).filter((l) => l.trim().startsWith("|")).map(splitRow);
  const sep = rows.findIndex(isSeparator);
  if (sep < 1) return null;
  return rows.slice(sep + 1).filter((r) => r.some((c) => c !== ""));
}

const isOnlyNone = (body: string): boolean => /^[\s\-*>無无none：:。.（）()]*$/i.test(body) && /無|无|none/i.test(body);

/** C1：impl-fe.md／impl-be.md 的重用檢查紀錄。fileName 只用於訊息。 */
export function checkReuseRecord(text: string, fileName: string): string[] {
  const body = extractSection(text, REUSE_RECORD_HEADING);
  if (body === null) return [`${fileName} 缺少「## ${REUSE_RECORD_HEADING}」一節`];
  const rows = tableDataRows(body);
  if (rows === null) return [`${fileName}「${REUSE_RECORD_HEADING}」必須是 markdown 表格（表頭＋分隔列＋資料列），欄位：搜尋關鍵字｜找到的候選｜決定｜理由${isOnlyNone(body) ? "；只寫「無」不通過" : ""}`];
  if (rows.length === 0) return [`${fileName}「${REUSE_RECORD_HEADING}」沒有任何資料列（若確實沒有新增方法或元件，寫一列「決定=無新增」並在理由說明）`];
  return rows.flatMap((r, i) => {
    const where = `${fileName}「${REUSE_RECORD_HEADING}」第 ${i + 1} 列`;
    if (r.length < MIN_COLUMNS) return [`${where}欄位不足（至少 ${MIN_COLUMNS} 欄：搜尋關鍵字｜找到的候選｜決定｜理由）`];
    const [keyword, , decision, reason] = r.map(clean);
    const out: string[] = [];
    if (keyword === "") out.push(`${where}搜尋關鍵字空白`);
    if (!REUSE_DECISIONS.includes(decision)) out.push(`${where}決定「${decision}」不合法（只能是：${REUSE_DECISIONS.join("、")}）`);
    else if (REASON_REQUIRED.includes(decision) && reason === "") out.push(`${where}決定為「${decision}」，理由必填`);
    return out;
  });
}

const NOT_FOUND_RE = /已搜尋[：:]\s*[^，,]+[，,]\s*未找到/;
const FILE_LOCATION_RE = /[\w\-./\\]+\.[A-Za-z][A-Za-z0-9]{0,7}\b|[\w\-.]+[/\\][\w\-./\\]+/;
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;

/** 清單條目：條列項目，或表格資料列（整列合併成一個字串）。 */
function listEntries(body: string): string[] {
  const rows = tableDataRows(body);
  if (rows !== null) return rows.map((r) => r.join(" "));
  return body.split(/\r\n|\r|\n/).flatMap((l) => {
    const m = LIST_ITEM_RE.exec(l);
    return m && m[1].trim() !== "" ? [m[1]] : [];
  });
}

/** C2：impact.md 的可重用清單。 */
export function checkImpactReuseList(text: string, fileName = "impact.md"): string[] {
  const body = extractSection(text, REUSABLE_LIST_HEADING);
  if (body === null) return [`${fileName} 缺少「## ${REUSABLE_LIST_HEADING}」一節`];
  if (body.trim() === "") return [`${fileName}「${REUSABLE_LIST_HEADING}」是空的`];
  if (isOnlyNone(body)) return [`${fileName}「${REUSABLE_LIST_HEADING}」不能只寫「無」；沒找到要寫「已搜尋：<關鍵字>，未找到」`];
  const entries = listEntries(body);
  if (entries.length === 0) return [`${fileName}「${REUSABLE_LIST_HEADING}」請用條列或表格逐項列出（每項要有檔案位置，或寫「已搜尋：<關鍵字>，未找到」）`];
  return entries.flatMap((e, i) => (FILE_LOCATION_RE.test(e) || NOT_FOUND_RE.test(e) ? [] : [`${fileName}「${REUSABLE_LIST_HEADING}」第 ${i + 1} 項沒有檔案位置，也沒有「已搜尋：<關鍵字>，未找到」字樣：${e.slice(0, 30)}`]));
}

/** C3：03-sd.md 的重用與共用設計。 */
export function checkSdReuseDesign(text: string, fileName = "03-sd.md"): string[] {
  const body = extractSection(text, SD_REUSE_HEADING);
  if (body === null) return [`${fileName} 缺少「## ${SD_REUSE_HEADING}」一節`];
  return body.trim() === "" ? [`${fileName}「${SD_REUSE_HEADING}」是空的`] : [];
}
