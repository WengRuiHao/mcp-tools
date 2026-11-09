// S12a：解析 impl-fe.md／impl-be.md 的「## 改動檔案」與「## 重複豁免」兩節，供自動重複偵測使用。
// 容錯：任何格式問題都不拋例外，缺節回空；是否有效的判斷交給偵測模組（豁免理由不足會被標為無效）。
import type { DupWaiver } from "../dup-detect/types.js";
import { extractSection, tableDataRows } from "./reuse-record-check.js";

export const CHANGED_FILES_HEADING = "改動檔案";
export const DUP_WAIVER_HEADING = "重複豁免";

export interface DupInput {
  /** 「## 改動檔案」列出的路徑（相對於專案目錄，已去重、反斜線換成斜線）。 */
  changedFiles: string[];
  waivers: DupWaiver[];
}

const LIST_MARK_RE = /^(?:[-*+]|\d+[.)])\s+/;

function parseChangedFiles(body: string): string[] {
  const seen = new Set<string>();
  for (const raw of body.split(/\r\n|\r|\n/)) {
    const line = raw.trim().replace(LIST_MARK_RE, "").replace(/^`+|`+$/g, "").trim();
    if (line === "" || line.startsWith("```")) continue;
    seen.add(line.split("\\").join("/").replace(/^\.\//, ""));
  }
  return [...seen];
}

const stripTicks = (cell: string): string => cell.replace(/`/g, "").trim();

function parseWaivers(body: string): DupWaiver[] {
  const rows = tableDataRows(body) ?? [];
  return rows.map((r) => {
    const other = stripTicks(r[1] ?? "").split("\\").join("/");
    return { file: stripTicks(r[0] ?? "").split("\\").join("/"), ...(other === "" ? {} : { otherFile: other }), reason: r.slice(2).join("|").trim() };
  });
}

/** 從實作說明全文取出改動檔案清單與重複豁免；缺節時對應欄位為空陣列。 */
export function parseDupInput(text: string): DupInput {
  try {
    const files = extractSection(text, CHANGED_FILES_HEADING);
    const waivers = extractSection(text, DUP_WAIVER_HEADING);
    return { changedFiles: files === null ? [] : parseChangedFiles(files), waivers: waivers === null ? [] : parseWaivers(waivers) };
  } catch {
    return { changedFiles: [], waivers: [] };
  }
}
