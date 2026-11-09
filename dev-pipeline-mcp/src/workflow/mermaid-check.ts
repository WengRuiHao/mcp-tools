// S8：flow.mmd 基本格式檢查（流程分析師 done 時，除了 flow.png 之外也要通過）。
// 只做離線、低成本的結構檢查，不做完整 Mermaid 語法解析，也不負責轉圖。
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

export const MERMAID_FILE_NAME = "flow.mmd";
/** 流程圖文字大小上限（位元組）。 */
export const MERMAID_MAX_BYTES = 256 * 1024;
/** 已知的 Mermaid 圖類型宣告（第一個非註解、非空白行必須以其中之一開頭）。 */
export const MERMAID_DIAGRAM_TYPES: readonly string[] = [
  "flowchart",
  "graph",
  "sequenceDiagram",
  "stateDiagram-v2",
  "stateDiagram",
  "classDiagram",
  "erDiagram",
  "journey",
  "gantt",
  "pie",
  "gitGraph",
  "mindmap",
  "timeline",
  "quadrantChart",
  "requirementDiagram",
  "C4Context",
  "C4Container",
  "C4Component",
  "C4Dynamic",
  "C4Deployment",
  "sankey-beta",
  "xychart-beta",
  "block-beta",
];

const FORBIDDEN_MARKUP: readonly { re: RegExp; label: string }[] = [
  { re: /<\s*script/i, label: "<script" },
  { re: /javascript\s*:/i, label: "javascript:" },
  { re: /<\s*(iframe|object|embed)\b/i, label: "<iframe／<object／<embed" },
];
const BRACKET_PAIRS: readonly [string, string][] = [
  ["[", "]"],
  ["(", ")"],
  ["{", "}"],
];

const isComment = (line: string): boolean => line.trim().startsWith("%%");

/** 略過開頭的 YAML frontmatter（--- … ---）後，回傳第一個非註解、非空白行。 */
function firstDeclarationLine(lines: readonly string[]): string | null {
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (lines[i]?.trim() === "---") {
    const close = lines.findIndex((l, idx) => idx > i && l.trim() === "---");
    if (close >= 0) i = close + 1;
  }
  for (; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t !== "" && !isComment(t)) return t;
  }
  return null;
}

const startsWithType = (line: string): boolean => MERMAID_DIAGRAM_TYPES.some((t) => line.startsWith(t) && (line.length === t.length || /[\s;]/.test(line[t.length])));

/** 去掉註解行與雙引號字串後，各種括號的開閉數量要相同。 */
function bracketProblems(lines: readonly string[]): string[] {
  const body = lines.filter((l) => !isComment(l)).join("\n").replace(/"[^"\n]*"/g, "");
  return BRACKET_PAIRS.flatMap(([open, close]) => {
    const o = body.split(open).length - 1;
    const c = body.split(close).length - 1;
    return o === c ? [] : [`括號「${open}${close}」沒有成對（${open} 有 ${o} 個、${close} 有 ${c} 個）`];
  });
}

/** 檢查 flow.mmd 全文，回傳違規逐項說明（空陣列＝合格）。 */
export function checkMermaidText(text: string): string[] {
  const clean = text.replace(/^﻿/, "");
  if (clean.trim() === "") return [`${MERMAID_FILE_NAME} 是空的`];
  const violations: string[] = [];
  if (Buffer.byteLength(clean, "utf-8") > MERMAID_MAX_BYTES) violations.push(`${MERMAID_FILE_NAME} 超過大小上限 ${MERMAID_MAX_BYTES / 1024}KB`);
  const lines = clean.split(/\r\n|\r|\n/);
  const decl = firstDeclarationLine(lines);
  if (decl === null) violations.push("只有註解，沒有任何圖內容");
  else if (!startsWithType(decl)) violations.push(`第一個非註解行必須是已知的 Mermaid 圖類型宣告（例如 flowchart TD、graph TD、sequenceDiagram），目前是「${decl.slice(0, 40)}」`);
  for (const f of FORBIDDEN_MARKUP) if (f.re.test(clean)) violations.push(`不得含 ${f.label}`);
  // erDiagram 的關聯符號（o{、}| 等）本身就含不成對的大括號，不檢查括號。
  if (!decl?.startsWith("erDiagram")) violations.push(...bracketProblems(lines));
  return violations;
}

/** 讀取工作項目目錄下的 flow.mmd 並檢查；檔案不存在由一般交件檢查回報，這裡回空陣列。 */
export function checkMermaidFile(workItemDir: string): string[] {
  const file = path.join(workItemDir, MERMAID_FILE_NAME);
  try {
    if (!statSync(file).isFile()) return [];
    return checkMermaidText(readFileSync(file, "utf-8"));
  } catch {
    return [];
  }
}
