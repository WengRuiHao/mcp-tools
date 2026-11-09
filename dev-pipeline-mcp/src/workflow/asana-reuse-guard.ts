// S12b：Asana 流程推進到 implemented 時的重用防線。
// 重用檢查紀錄沿用 S10 的 checkReuseRecord；改動檔案與重複豁免從 02-implementation.md 解析；重複偵測沿用 S11。
import { isAbsolute, relative } from "node:path";
import { detectDuplicates, formatDupReport, getChangedFiles, DupPathError, type DupReport, type DupWaiver } from "../dup-detect/index.js";
import { CHANGED_FILES_HEADING, DUP_WAIVER_HEADING, parseDupInput } from "./dup-input.js";
import { checkReuseRecord, extractSection } from "./reuse-record-check.js";

export const IMPLEMENTATION_FILE = "02-implementation.md";
export const DUP_REPORT_FILE = "dup-report.md";

const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;
const PATH_TOKEN_RE = /^[^\s`'"|()（）,，、;；<>：:]+/;


/** 「## 改動檔案」條列的檔案路徑（條列項目開頭的路徑字樣，其後說明文字忽略）；沒有該節回空陣列。 */
export function parseChangedFileList(text: string): string[] {
  const body = extractSection(text, CHANGED_FILES_HEADING);
  if (body === null) return [];
  const found = new Set<string>();
  for (const line of body.split(/\r\n|\r|\n/)) {
    const item = LIST_ITEM_RE.exec(line)?.[1];
    if (item === undefined) continue;
    const token = PATH_TOKEN_RE.exec(item.replace(/[`*]/g, "").trim())?.[0];
    if (token && /[./\\]/.test(token)) found.add(token.replace(/^\.\//, ""));
  }
  return [...found];
}

/** 改動檔案清單與版本控制偵測結果的聯集（相對 projectDir 的路徑；專案目錄外的絕對路徑原樣保留，由偵測拒絕）。 */
function unionChanged(projectDir: string, listed: readonly string[], vcs: readonly string[] | null): string[] {
  const rel = (p: string): string => {
    if (!isAbsolute(p)) return p;
    const r = relative(projectDir, p);
    return r.startsWith("..") || isAbsolute(r) ? p : r.split("\\").join("/");
  };
  return [...new Set([...listed.map(rel), ...(vcs ?? [])])];
}

export type ReuseGuardResult =
  | { ok: true; reportMarkdown: string }
  | { ok: false; message: string; reportMarkdown?: string };

function blockingMessage(report: DupReport): string {
  const where = report.duplicates
    .slice(0, 5)
    .map((b) => `${b.file} 第 ${b.startLine}～${b.endLine} 行 ⇄ ${b.otherFile} 第 ${b.otherStartLine}～${b.otherEndLine} 行（連續 ${b.matchedLines} 行）`);
  const invalid = report.invalidWaivers.map((w) => `${w.file}${w.otherFile ? ` ⇄ ${w.otherFile}` : ""}`);
  const parts: string[] = [];
  if (report.duplicates.length > 0) parts.push(`有 ${report.duplicates.length} 處未豁免的重複程式碼：${where.join("；")}${report.duplicates.length > 5 ? "…" : ""}`);
  if (invalid.length > 0) parts.push(`「## ${DUP_WAIVER_HEADING}」有無效豁免（理由至少 4 個字元、檔案不可空白）：${invalid.join("、")}`);
  return (
    `重複程式碼偵測未通過，不能推進到 "implemented"：${parts.join("。")}。` +
    `建議：改成呼叫專案既有的共用方法，或把重複部分抽成共用方法；確有正當理由保留時，在 ${IMPLEMENTATION_FILE} 加「## ${DUP_WAIVER_HEADING}」表格（檔案｜相似檔案｜理由）。` +
    `完整報告已寫到票單目錄的 ${DUP_REPORT_FILE}。`
  );
}

/** 推進到 implemented 前的檢查：重用檢查紀錄、改動檔案、重複偵測。 */
export async function checkAsanaReuseGuard(implementation: string, projectDir: string | null): Promise<ReuseGuardResult> {
  const recordProblems = checkReuseRecord(implementation, IMPLEMENTATION_FILE);
  if (recordProblems.length > 0) {
    return { ok: false, message: `${IMPLEMENTATION_FILE} 的重用檢查紀錄不合格，不能推進到 "implemented"：${recordProblems.join("；")}。` };
  }
  if (!projectDir) {
    return { ok: false, message: `這張票還沒有確定的專案目錄（project_dir），無法做重複程式碼偵測；請先確認專案目錄（可在這次 advance_ticket_stage 帶 project_dir）。` };
  }
  const changed = unionChanged(projectDir, parseChangedFileList(implementation), await getChangedFiles(projectDir));
  if (changed.length === 0) {
    return { ok: false, message: `取不到任何改動檔案（專案目錄不是版本控制工作副本，${IMPLEMENTATION_FILE} 也沒有「## ${CHANGED_FILES_HEADING}」條列）。請在 ${IMPLEMENTATION_FILE} 補上「## ${CHANGED_FILES_HEADING}」，每個改動檔案一行條列（相對專案目錄的路徑）。` };
  }
  let report: DupReport;
  try {
    report = await detectDuplicates({ projectDir, changedFiles: changed, waivers: parseDupInput(implementation).waivers });
  } catch (err) {
    if (err instanceof DupPathError) return { ok: false, message: `「## ${CHANGED_FILES_HEADING}」有不合法的路徑，無法偵測重複：${err.message}` };
    throw err;
  }
  const reportMarkdown = formatDupReport(report);
  if (report.blocking || report.invalidWaivers.length > 0) return { ok: false, message: blockingMessage(report), reportMarkdown };
  return { ok: true, reportMarkdown };
}
