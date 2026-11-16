// 流程對 SA 的一致性檢查（警告級，不擋交件）：SA 的功能名稱要出現在 flow.mmd 的節點文字裡。
// 功能清單來源（依序）：
//  1. SA 有「功能」「功能清單」「功能說明」章節時：其下三級標題、清單項目、或表格第一欄；
//  2. 否則取「操作說明」表格「操作」欄裡 「」 括起來的畫面項目名稱（SA 範本沒有獨立功能章節時的替代）。
// 解析不出任何功能時回空陣列（不誤報）。比對忽略空白與標點，允許子字串。
import { readFileSync } from "node:fs";
import path from "node:path";
import { headingEquals } from "./heading-match.js";
import { parseTable } from "./md-table.js";
import { MERMAID_FILE_NAME } from "./mermaid-check.js";
import { extractSection } from "./reuse-record-check.js";
import { listHeadings, SA_FILE_NAME } from "./sa-image-check.js";

const FEATURE_SECTION_NAMES: readonly string[] = ["功能清單", "功能說明", "功能"];
const OPERATION_SECTION = "操作說明";
const MIN_NAME_LENGTH = 2;
const MAX_NAME_LENGTH = 30;
const LINE_BREAK = /\r\n|\r|\n/;

/** 去掉空白、標點、符號與 markdown 記號，只留文字與數字。 */
export const normalizeForMatch = (t: string): string => t.replace(/[`*_]/g, "").replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();

const cleanName = (t: string): string => t.replace(/[`*_]/g, "").replace(/^[\d.、)）\s-]+/, "").trim();

function uniq(names: readonly string[]): string[] {
  const seen = new Set<string>();
  return names.filter((n) => {
    const key = normalizeForMatch(n);
    if (key.length < MIN_NAME_LENGTH || n.length > MAX_NAME_LENGTH || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 二級標題與 name 完全相同的章節內容（不用前綴比對，避免「功能」命中「功能目的」）；沒有回 null。 */
function exactSection(text: string, name: string): string | null {
  const heads = listHeadings(text);
  const at = heads.findIndex((h) => h.level === 2 && headingEquals(h.title, name));
  if (at < 0) return null;
  const end = heads.slice(at + 1).find((h) => h.level <= 2);
  const lines = text.split(LINE_BREAK);
  return lines.slice(heads[at].line, end ? end.line - 1 : lines.length).join("\n");
}

function featuresFromSection(text: string): string[] {
  for (const name of FEATURE_SECTION_NAMES) {
    const body = exactSection(text, name);
    if (body === null) continue;
    const lines = body.split(LINE_BREAK);
    const subHeads = lines.filter((l) => /^###\s+\S/.test(l)).map((l) => cleanName(l.replace(/^###\s+/, "")));
    if (subHeads.length > 0) return subHeads;
    const table = parseTable(body);
    if (table !== null) return table.rows.map((r) => cleanName(r[0] ?? ""));
    return lines.filter((l) => /^\s*(?:[-*]|\d+[.)])\s+\S/.test(l)).map((l) => cleanName(l.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "")));
  }
  return [];
}

function featuresFromOperations(text: string): string[] {
  const body = extractSection(text, OPERATION_SECTION);
  const table = body === null ? null : parseTable(body);
  if (table === null) return [];
  const col = Math.max(0, table.header.findIndex((h) => h.includes("操作")));
  return table.rows.flatMap((r) => [...(r[col] ?? "").matchAll(/「([^」]+)」/g)].map((m) => m[1].trim()));
}

/** 從 SA 全文抽出功能名稱清單（去重、略過太短或太長者）。 */
export function extractSaFeatures(saText: string): string[] {
  const fromSection = uniq(featuresFromSection(saText));
  return fromSection.length > 0 ? fromSection : uniq(featuresFromOperations(saText));
}

/** 回傳 SA 功能名稱在流程圖文字完全找不到者。 */
export function findFeaturesMissingInFlow(saText: string, flowText: string): string[] {
  const flow = normalizeForMatch(flowText);
  return extractSaFeatures(saText).filter((f) => !flow.includes(normalizeForMatch(f)));
}

/** 讀工作項目目錄下的 01-sa.md 與 flow.mmd，回警告清單；缺檔、讀不到或解析不出功能時回空陣列。 */
export function checkFlowCoversSa(workItemDir: string): string[] {
  try {
    const sa = readFileSync(path.join(workItemDir, SA_FILE_NAME), "utf-8");
    const flow = readFileSync(path.join(workItemDir, MERMAID_FILE_NAME), "utf-8");
    const missing = findFeaturesMissingInFlow(sa, flow);
    return missing.length === 0 ? [] : [`流程圖（${MERMAID_FILE_NAME}）沒有出現 SA（${SA_FILE_NAME}）的功能：${missing.map((m) => `「${m}」`).join("、")}；請核對流程是否漏畫，或 SA 功能名稱與流程圖用語是否一致（僅提醒，不擋交件）`];
  } catch {
    return [];
  }
}
