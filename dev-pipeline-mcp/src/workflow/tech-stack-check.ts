// S13：技術選型的程式檢查。
// tech-stack.md 必須有「## 技術來源」「## 技術棧」「## 選擇理由」三節；依技術來源另需「## 候選方案」（全新待選）或「## 目標技術」（換技術）。
// baseline.md（既有系統）必須有非空的「## 現有技術棧」。標題偵測沿用 reuse-record-check 的 extractSection（略過程式碼區塊）。
import { headingMatches, stripHeadingNumber } from "./heading-match.js";
import { extractSection, tableDataRows } from "./reuse-record-check.js";
import { listHeadings } from "./sa-image-check.js";

export const TECH_SOURCE_HEADING = "技術來源";
export const TECH_STACK_HEADING = "技術棧";
export const TECH_REASON_HEADING = "選擇理由";
export const TECH_CANDIDATES_HEADING = "候選方案";
export const TECH_TARGET_HEADING = "目標技術";
export const BASELINE_TECH_HEADING = "現有技術棧";
export const TECH_STACK_FILE = "tech-stack.md";
export const BASELINE_FILE = "baseline.md";
export const MIN_CANDIDATES = 2;
const NOT_APPLICABLE = "不適用";
/** 擋回訊息附的固定列名範例（列名比對以第一欄為準）。 */
export const TECH_STACK_EXAMPLE = `列名固定：${["前端語言","前端框架","前端元件庫","後端語言","後端框架","資料庫種類","資料庫版本","建置與測試工具","主要版本"].join("、")}；範例列「| 前端框架 | 不適用 |」，不適用要寫「${NOT_APPLICABLE}」並在選擇理由說明`;

/** 技術棧表格必須列出的項目；match 以第一欄（去掉空白與括號）判斷這一列是不是該項目。 */
interface RequiredItem {
  label: string;
  match: (cell: string) => boolean;
}
const has = (...words: string[]) => (cell: string): boolean => words.every((w) => cell.includes(w));
const REQUIRED_ITEMS: readonly RequiredItem[] = [
  { label: "前端語言", match: has("前端", "語言") },
  { label: "前端框架", match: has("前端", "框架") },
  { label: "前端元件庫", match: has("前端", "元件庫") },
  { label: "後端語言", match: has("後端", "語言") },
  { label: "後端框架", match: has("後端", "框架") },
  { label: "資料庫種類", match: has("資料庫", "種類") },
  { label: "資料庫版本", match: has("資料庫", "版本") },
  { label: "建置與測試工具", match: (c) => c.includes("建置") || c.includes("測試") },
  { label: "主要版本", match: has("主要版本") },
];

/** 敷衍答案：只寫「無／N/A／待定」之類。「不適用」是合法答案（必須在選擇理由說明）。 */
const PLACEHOLDER_RE = /^(無|无|沒有|没有|none|n\/a|na|nil|null|tbd|todo|待定|待決定|未定|未決定|待確認|略|空|-+|\?+)$/i;
const isPlaceholder = (v: string): boolean => PLACEHOLDER_RE.test(v.replace(/[\s`*_。.、，,：:（）()]/g, ""));
const clean = (cell: string): string => cell.replace(/[`*_]/g, "").trim();
const normLabel = (cell: string): string => clean(cell).replace(/[\s（）()]/g, "");
const isBlank = (body: string | null): boolean => body === null || body.trim() === "";

function checkStackTable(body: string): { problems: string[]; usesNotApplicable: boolean } {
  const rows = tableDataRows(body);
  if (rows === null) return { problems: [`${TECH_STACK_FILE}「${TECH_STACK_HEADING}」必須是 markdown 表格（表頭＋分隔列＋資料列），每列「項目｜內容」。${TECH_STACK_EXAMPLE}`], usesNotApplicable: false };
  const problems: string[] = [];
  let usesNotApplicable = false;
  for (const item of REQUIRED_ITEMS) {
    const hit = rows.filter((r) => item.match(normLabel(r[0] ?? "")));
    if (hit.length === 0) {
      problems.push(`${TECH_STACK_FILE}「${TECH_STACK_HEADING}」表格缺少「${item.label}」這一列（${TECH_STACK_EXAMPLE}）`);
      continue;
    }
    for (const r of hit) {
      const value = clean(r.slice(1).join(" "));
      if (value === "" || isPlaceholder(value)) problems.push(`${TECH_STACK_FILE}「${item.label}」不可空白或只寫「無／N/A／待定」；確實沒有這一層請寫「${NOT_APPLICABLE}」並在「${TECH_REASON_HEADING}」說明`);
      else if (value.includes(NOT_APPLICABLE)) usesNotApplicable = true;
    }
  }
  return { problems, usesNotApplicable };
}

const CANDIDATE_RE = /^方案/;

function checkCandidates(text: string, reason: string): string[] {
  const body = extractSection(text, TECH_CANDIDATES_HEADING);
  if (body === null) return [`${TECH_STACK_FILE} 缺少「## ${TECH_CANDIDATES_HEADING}」一節（技術來源為全新待選，要提出 ${MIN_CANDIDATES}～3 組方案讓使用者選）`];
  const heads = listHeadings(text);
  const at = heads.findIndex((h) => h.level === 2 && headingMatches(h.title, TECH_CANDIDATES_HEADING));
  const end = heads.slice(at + 1).find((h) => h.level <= 2);
  const lines = text.split(/\r\n|\r|\n/);
  const subs = heads.slice(at + 1, end ? heads.indexOf(end) : undefined).filter((h) => h.level === 3 && CANDIDATE_RE.test(stripHeadingNumber(h.title)));
  if (subs.length < MIN_CANDIDATES) return [`${TECH_STACK_FILE}「${TECH_CANDIDATES_HEADING}」至少要有 ${MIN_CANDIDATES} 個「### 方案…」子標題（目前 ${subs.length} 個）`];
  const problems: string[] = [];
  subs.forEach((h, i) => {
    const next = heads.slice(heads.indexOf(h) + 1).find((x) => x.level <= 3);
    const part = lines.slice(h.line, next ? next.line - 1 : end ? end.line - 1 : lines.length).join("\n");
    const where = `${TECH_STACK_FILE}「${h.title}」`;
    if (!(part.includes("優缺點") || (part.includes("優點") && part.includes("缺點")))) problems.push(`${where}缺少優缺點`);
    if (!(part.includes("學習") && part.includes("維運"))) problems.push(`${where}缺少學習與維運成本`);
    if (!part.includes("相容")) problems.push(`${where}缺少與現有專案相容性`);
  });
  const named = subs.some((h) => {
    const m = /^方案\s*([A-Za-z0-9一二三四五])/.exec(h.title);
    return m ? new RegExp(`方案\\s*${m[1]}`).test(reason) : reason.includes(h.title);
  });
  if (!named) problems.push(`${TECH_STACK_FILE}「${TECH_REASON_HEADING}」要寫明選了哪一個方案（例如「選方案 A」）`);
  return problems;
}

/** 「候選方案」小節寫了「無」之類（沒有需要使用者決定的方案）。 */
const NO_CANDIDATE_RE = /^(無|无|沒有|没有|none|n\/a|na|nil|不適用|不适用|略|無需|无需|不需|不用|--+|—+)/i;

/**
 * tech-stack.md 是否有需要使用者決定的候選方案：有「候選方案」小節，且（有「### 方案…」子標題，或內容第一行不是「無／沒有／不適用」之類）。
 * 沒有該小節、內容空白、或只寫「無」都是 false。程式碼區塊內的標題不算（沿用 extractSection）。
 */
export function hasTechCandidates(text: string): boolean {
  const body = extractSection(text, TECH_CANDIDATES_HEADING);
  if (body === null) return false;
  const lines = body.split(/\r\n|\r|\n/);
  if (lines.some((l) => /^#{3,}\s*方案/.test(l.trim()))) return true;
  const first = lines.map((l) => l.replace(/[\s>*_`\-:：。.（）()]/g, "")).find((l) => l !== "");
  return first !== undefined && !NO_CANDIDATE_RE.test(first);
}

export interface TechStackCheckInput {
  techSource: string | undefined;
  /** baseline.md 全文（沿用現有時用來核對；讀不到傳 undefined）。 */
  baselineText?: string | undefined;
}

/** 檢查 tech-stack.md 全文；回傳問題清單（空陣列＝合格）。 */
export function checkTechStack(text: string, input: TechStackCheckInput): string[] {
  const problems: string[] = [];
  const source = extractSection(text, TECH_SOURCE_HEADING);
  if (isBlank(source)) problems.push(`${TECH_STACK_FILE} 缺少「## ${TECH_SOURCE_HEADING}」一節或內容空白（寫明是沿用現有／換技術／全新有規範／全新待選）`);
  const reason = extractSection(text, TECH_REASON_HEADING);
  if (isBlank(reason)) problems.push(`${TECH_STACK_FILE} 缺少「## ${TECH_REASON_HEADING}」一節或內容空白`);
  const stack = extractSection(text, TECH_STACK_HEADING);
  if (stack === null) problems.push(`${TECH_STACK_FILE} 缺少「## ${TECH_STACK_HEADING}」一節`);
  else {
    const t = checkStackTable(stack);
    problems.push(...t.problems);
    if (t.usesNotApplicable && !(reason ?? "").includes(NOT_APPLICABLE)) problems.push(`${TECH_STACK_FILE} 有項目寫「${NOT_APPLICABLE}」，必須在「${TECH_REASON_HEADING}」說明為什麼不適用`);
  }
  if (input.techSource === "new-select") problems.push(...checkCandidates(text, reason ?? ""));
  if (input.techSource === "change" && isBlank(extractSection(text, TECH_TARGET_HEADING))) {
    problems.push(`${TECH_STACK_FILE} 缺少「## ${TECH_TARGET_HEADING}」一節或內容空白（技術來源為換技術，要寫使用者指定的目標技術）`);
  }
  if (input.techSource === "existing" && isBlank(input.baselineText === undefined ? null : extractSection(input.baselineText, BASELINE_TECH_HEADING))) {
    problems.push(`技術來源為沿用現有，但 ${BASELINE_FILE} 沒有非空的「## ${BASELINE_TECH_HEADING}」可對照`);
  }
  return problems;
}

/** C：baseline.md（既有系統現況盤點）必須有非空的「## 現有技術棧」。 */
export function checkBaselineTechStack(text: string, fileName: string): string[] {
  return isBlank(extractSection(text, BASELINE_TECH_HEADING)) ? [`${fileName} 缺少「## ${BASELINE_TECH_HEADING}」一節或內容空白（記錄前端、後端、資料庫、建置與測試工具與主要版本）`] : [];
}
