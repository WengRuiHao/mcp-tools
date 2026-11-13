import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * 解析 sa-notes.md「待確認問題」章節（標題含「待確認」的章節）。每一項可以是：
 * 子標題（### Q1 標題）、頂層清單項（- … 或 1. …）、表格資料列。內文有「建議預設：…」就取為建議。
 * 標示「已確認」「需求規定」的項目、「無」之類的占位項目不算待確認。
 */

export const SA_NOTES_FILE = "sa-notes.md";

export interface PendingQuestion {
  /** 編號，例如 Q3；沒有明寫編號時依出現順序補。 */
  id: string;
  title: string;
  /** 項目內文寫的「建議預設」；沒寫為 undefined。 */
  suggestion?: string;
}

const MAX_TITLE_CHARS = 80;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const LIST_RE = /^(?:[-*+]\s+|\d+[.)、．]\s*|Q\s*\d+\s*[:：.、)）]\s*)/i;
const TABLE_SEP_RE = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const PLACEHOLDER_RE = /^[（(]?\s*(無|没有|沒有|無待確認(問題|事項)?|none|n\/a|無問題)\s*[）)]?[。.]?$/i;
const RESOLVED_RE = /^[【\[（(]?\s*(已確認|需求規定)/;
const SUGGESTION_RE = /(?:建議預設|建議)\s*[:：]\s*([^\n]+)/;
const EXPLICIT_NO_RE = /^\s*Q\s*(\d+)/i;
const NUMBERED_RE = /^(\d+)[.)、．]/;

const stripMark = (s: string): string => s.replace(/\*\*|__|`/g, "").trim();

interface RawItem {
  head: string;
  explicitNo?: number;
  lines: string[];
}

function sectionBody(lines: string[]): { level: number; body: string[] } | undefined {
  const start = lines.findIndex((l) => {
    const m = HEADING_RE.exec(l);
    return m !== null && (m[2] ?? "").includes("待確認");
  });
  if (start < 0) return undefined;
  const level = (HEADING_RE.exec(lines[start] ?? "")?.[1] ?? "#").length;
  const body: string[] = [];
  for (const l of lines.slice(start + 1)) {
    const m = HEADING_RE.exec(l);
    if (m && (m[1] ?? "").length <= level) break;
    body.push(l);
  }
  return { level, body };
}

function startOfItem(line: string, level: number, tableHeaderSkipped: boolean): { head: string; explicitNo?: number; isTable?: boolean } | undefined {
  const h = HEADING_RE.exec(line);
  if (h && (h[1] ?? "").length > level) {
    const text = stripMark(h[2] ?? "");
    const q = EXPLICIT_NO_RE.exec(text);
    return { head: text.replace(/^Q\s*\d+\s*[:：.、)）\-－—]?\s*/i, "").trim() || text, ...(q ? { explicitNo: Number(q[1]) } : {}) };
  }
  if (line.startsWith("|")) {
    if (TABLE_SEP_RE.test(line.trim()) || !tableHeaderSkipped) return undefined;
    const cells = line.split("|").map((c) => stripMark(c)).filter((c) => c !== "");
    return cells.length === 0 ? undefined : { head: cells.join("｜"), isTable: true };
  }
  const lm = LIST_RE.exec(line);
  if (lm) {
    const num = NUMBERED_RE.exec(line)?.[1] ?? /^Q\s*(\d+)/i.exec(line)?.[1];
    const rest = stripMark(line.slice(lm[0].length));
    return { head: rest, ...(num ? { explicitNo: Number(num) } : {}) };
  }
  return undefined;
}

function collectItems(body: string[], level: number): RawItem[] {
  const items: RawItem[] = [];
  let current: RawItem | undefined;
  for (let i = 0; i < body.length; i++) {
    const line = body[i] ?? "";
    const isTableLine = line.startsWith("|");
    // 表格：第一列（表頭）後面緊接分隔列才算表頭；資料列才是項目
    const headerSkipped = !isTableLine || !TABLE_SEP_RE.test((body[i + 1] ?? "").trim());
    const s = startOfItem(line, level, headerSkipped);
    if (s) {
      current = { head: s.head, ...(s.explicitNo !== undefined ? { explicitNo: s.explicitNo } : {}), lines: [] };
      items.push(current);
    } else if (current && line.trim() !== "" && !isTableLine && !HEADING_RE.test(line)) {
      current.lines.push(line.trim());
    }
  }
  return items;
}

/** 從 sa-notes.md 全文取出待確認問題（沒有該章節或全是占位／已確認項目時回空陣列）。 */
export function parsePendingQuestions(text: string): PendingQuestion[] {
  const sec = sectionBody(text.split(/\r?\n/));
  if (!sec) return [];
  const result: PendingQuestion[] = [];
  let seq = 0;
  for (const it of collectItems(sec.body, sec.level)) {
    seq += 1;
    const full = [it.head, ...it.lines].join("\n");
    if (PLACEHOLDER_RE.test(stripMark(it.head)) || RESOLVED_RE.test(stripMark(it.head))) continue;
    const m = SUGGESTION_RE.exec(full);
    const suggestion = m ? stripMark((m[1] ?? "").replace(/[）)]\s*$/, "")) : undefined;
    const title = stripMark((it.head.split(/[（(]?\s*建議(?:預設)?\s*[:：]/)[0] ?? "").trim() || it.head).slice(0, MAX_TITLE_CHARS);
    result.push({ id: `Q${it.explicitNo ?? seq}`, title, ...(suggestion ? { suggestion } : {}) });
  }
  return result;
}

/** 讀工作項目目錄的 sa-notes.md 並解析；檔案不存在回空陣列。 */
export async function readPendingQuestions(dir: string): Promise<PendingQuestion[]> {
  const text = await readFile(path.join(dir, SA_NOTES_FILE), "utf-8").catch(() => undefined);
  return text === undefined ? [] : parsePendingQuestions(text);
}
