// 追溯矩陣（批次 2M-a，高風險需求才啟用）：SA 基本資料表的「需求編號」→ SD 每支 API 的「**對應需求：**」→ 測試報告的「**對應需求：**」。
// 需求沒有對應 SD 擋住；需求沒有對應測試只警告（測試報告可用「**不需測試：** R2 理由」標記）。純文字檢查，不讀檔案。
import { headingMatches } from "./heading-match.js";
import { parseTable } from "./md-table.js";
import { listHeadings } from "./sa-image-check.js";

export const REQ_ID_ITEM = "需求編號";
export const REQ_LABEL = "對應需求";
export const NO_TEST_LABEL = "不需測試";
const REQ_ID_RE = /^R[1-9]\d*$/;
const SPLIT_RE = /[、,，;；\s]+/;
const API_SECTION = "API說明";
const TEST_PREFIX = "測試：";
const noSpace = (s: string): string => s.replace(/\s+/g, "");
const cleanCell = (s: string): string => s.replace(/[`*_]/g, "").trim();
const labelRe = (label: string): RegExp => new RegExp(`^\\s*\\*\\*${label}\\s*[:：]?\\s*\\*\\*\\s*[:：]?\\s*(.*)$`);

const splitIds = (value: string): string[] => [...new Set(value.split(SPLIT_RE).map((s) => s.trim()).filter(Boolean))];

/** SA 基本資料表（第一個二級標題之前的表格）的「需求編號」列；problems 是格式問題，沒有該列時 ids 為空。 */
export function parseSaRequirementIds(saText: string): { ids: string[]; problems: string[] } {
  const firstH2 = listHeadings(saText).find((h) => h.level === 2);
  const head = saText.split(/\r\n|\r|\n/).slice(0, firstH2 ? firstH2.line - 1 : undefined).join("\n");
  const table = parseTable(head);
  const row = table?.rows.find((r) => cleanCell(r[0] ?? "").replace(/\s+/g, "") === REQ_ID_ITEM);
  const hint = `SA 開頭基本資料表要有一列「${REQ_ID_ITEM}」，內容寫 R1、R2…（每個需求一個編號，用逗號或頓號分隔）`;
  if (!row) return { ids: [], problems: [`缺少「${REQ_ID_ITEM}」：${hint}`] };
  const raw = splitIds(cleanCell(row[1] ?? ""));
  if (raw.length === 0) return { ids: [], problems: [`「${REQ_ID_ITEM}」沒有填：${hint}`] };
  const bad = raw.filter((x) => !REQ_ID_RE.test(x));
  return { ids: raw.filter((x) => REQ_ID_RE.test(x)), problems: bad.map((x) => `「${REQ_ID_ITEM}」的「${x}」格式不對，要寫成 R1、R2…（大寫 R 加數字）`) };
}

export function checkSaRequirementIds(saText: string): string[] {
  const r = parseSaRequirementIds(saText);
  return r.problems;
}

interface Block {
  title: string;
  line: number;
  ids: string[] | null;
}

function scanLabel(lines: string[], from: number, to: number): string[] | null {
  const re = labelRe(REQ_LABEL);
  for (const raw of lines.slice(from, to)) {
    if (/^#{1,6}\s/.test(raw)) break;
    const m = re.exec(raw);
    if (m) return splitIds(cleanCell(m[1]));
  }
  return null;
}

/** SD「## API 說明」底下每支 API（### 標題）的「對應需求」；沒有這個標籤時 ids 為 null。 */
export function parseApiRequirements(sdText: string): Block[] {
  const heads = listHeadings(sdText);
  const at = heads.findIndex((h) => h.level === 2 && headingMatches(noSpace(h.title), API_SECTION));
  if (at < 0) return [];
  const lines = sdText.split(/\r\n|\r|\n/);
  const endH2 = heads.slice(at + 1).find((h) => h.level <= 2);
  const sectionEnd = endH2 ? endH2.line : lines.length + 1;
  const apiHeads = heads.filter((h) => h.level === 3 && h.line > heads[at].line && h.line < sectionEnd);
  return apiHeads.map((h, i) => ({ title: h.title, line: h.line, ids: scanLabel(lines, h.line, (apiHeads[i + 1]?.line ?? sectionEnd) - 1) }));
}

/** SD 追溯檢查（擋住）：每支 API 要有對應需求、對應的編號要在 SA 裡、SA 每個需求至少被一支 API 對應。saIds 為空（SA 沒編號）時略過。 */
export function checkSdTraceability(sdText: string, saIds: readonly string[]): string[] {
  if (saIds.length === 0) return [];
  const apis = parseApiRequirements(sdText);
  const out: string[] = [];
  const known = new Set(saIds);
  for (const a of apis) {
    if (a.ids === null || a.ids.length === 0) {
      out.push(`API「${a.title}」缺少「**${REQ_LABEL}：** R1」（寫這支 API 對應 SA 的哪些需求編號）`);
      continue;
    }
    for (const id of a.ids) if (!known.has(id)) out.push(`API「${a.title}」的${REQ_LABEL}「${id}」不在 SA 的需求編號裡（SA 的編號：${saIds.join("、")}）`);
  }
  const covered = new Set(apis.flatMap((a) => a.ids ?? []));
  for (const id of saIds) if (!covered.has(id)) out.push(`需求 ${id} 沒有任何 API 對應（SD 要有 API 的「${REQ_LABEL}」寫到 ${id}）`);
  return out;
}

interface TestBlock {
  name: string;
  ids: string[] | null;
}

function parseTestBlocks(testText: string): TestBlock[] {
  const heads = listHeadings(testText);
  const lines = testText.split(/\r\n|\r|\n/);
  const tests = heads.filter((h) => (h.level === 2 || h.level === 3) && h.title.trim().startsWith(TEST_PREFIX));
  return tests.map((h) => {
    const next = heads.find((x) => x.line > h.line && x.level <= h.level);
    return { name: h.title.trim().slice(TEST_PREFIX.length).trim(), ids: scanLabel(lines, h.line, (next ? next.line : lines.length + 1) - 1) };
  });
}

/** 「**不需測試：** R2 理由」：回傳已標記且寫了理由的需求編號。 */
function parseNoTest(testText: string): Set<string> {
  const re = labelRe(NO_TEST_LABEL);
  const out = new Set<string>();
  for (const raw of testText.split(/\r\n|\r|\n/)) {
    const m = re.exec(raw);
    if (!m) continue;
    const words = cleanCell(m[1]).split(/\s+/).filter(Boolean);
    const ids = words.filter((w) => REQ_ID_RE.test(w.replace(/[、,，]$/, "")));
    const reason = words.filter((w) => !REQ_ID_RE.test(w.replace(/[、,，]$/, ""))).join("");
    if (reason.length >= 2) for (const id of ids) out.add(id.replace(/[、,，]$/, ""));
  }
  return out;
}

/** 測試追溯警告（不擋）：測試項目沒有對應需求、對應不存在的編號、需求沒有任何測試且沒標不需測試。saIds 為空時略過。 */
export function testTraceabilityWarnings(testText: string, saIds: readonly string[]): string[] {
  if (saIds.length === 0) return [];
  const blocks = parseTestBlocks(testText);
  const known = new Set(saIds);
  const out: string[] = [];
  for (const b of blocks) {
    if (b.ids === null || b.ids.length === 0) out.push(`測試項目「${b.name}」沒有「**${REQ_LABEL}：** R1」（寫它對應 SA 的哪些需求編號）`);
    else for (const id of b.ids) if (!known.has(id)) out.push(`測試項目「${b.name}」的${REQ_LABEL}「${id}」不在 SA 的需求編號裡`);
  }
  const covered = new Set(blocks.flatMap((b) => b.ids ?? []));
  const noTest = parseNoTest(testText);
  for (const id of saIds) {
    if (!covered.has(id) && !noTest.has(id)) out.push(`需求 ${id} 沒有任何測試項目對應（真的不需測試請在測試報告寫「**${NO_TEST_LABEL}：** ${id} 理由」）`);
  }
  return out;
}

export interface MatrixRow {
  id: string;
  apis: string[];
  tests: string[];
}

/** 需求 → SD API → 測試 的對照表（給交付摘要用）。 */
export function traceabilityMatrix(saIds: readonly string[], sdText: string, testText: string): MatrixRow[] {
  const apis = parseApiRequirements(sdText);
  const blocks = parseTestBlocks(testText);
  return saIds.map((id) => ({
    id,
    apis: apis.filter((a) => a.ids?.includes(id)).map((a) => a.title),
    tests: blocks.filter((b) => b.ids?.includes(id)).map((b) => b.name),
  }));
}
