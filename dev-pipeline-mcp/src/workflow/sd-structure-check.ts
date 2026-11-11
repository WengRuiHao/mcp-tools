// SD 新標準檢查（取代舊 C3「重用與共用設計」標題檢查）。格式以 docs/sasd-standard/SD-範本.md 為準。
// 純文字檢查，回傳違規逐項說明（空陣列＝合格）；帶 workItemDir 時另檢查「使用資料表」連結的 TableSchema 檔案存在。
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { headingMatches } from "./heading-match.js";
import { parseTable } from "./md-table.js";
import { extractSection } from "./reuse-record-check.js";
import { eachLine, listHeadings } from "./sa-image-check.js";
import { META_SENTENCES, termRe } from "./sa-standard-check.js";
import { checkSdApis, parseSdApis, splitCommonMethods } from "./sd-api-parse.js";
import { TABLE_SCHEMA_DIR } from "./table-schema-check.js";
import { checkVersionHistory } from "./version-history-check.js";

export const SD_FILE_NAME = "03-sd.md";
export const SD_BASIC_ITEMS: readonly string[] = ["程式代號", "程式名稱", "使用技術", "系統分析者", "上層程式名稱", "程式設計者", "程式類別", "審查者"];
/** 規格說明底下的四節（依序）與各表的固定表頭。 */
export const SD_SPEC_SECTIONS: readonly { name: string; header: readonly string[] }[] = [
  { name: "使用資料表", header: ["Table", "功能", "說明", "結構文件"] },
  { name: "前端功能與API對應表", header: ["前端功能", "觸發時機", "呼叫的 API", "成功時", "失敗時", "前端位置"] },
  { name: "共用方法清單", header: ["共用方法", "位置", "類型", "被誰使用", "說明"] },
  { name: "共用回應與錯誤碼", header: ["HTTP", "code", "message", "說明", "檢核位置", "前端提示位置"] },
];
/** 共用方法清單的類型，對應 impl 重用檢查紀錄（reuse-record-check 的 REUSE_DECISIONS）可填的決定。 */
export const SD_TYPE_DECISIONS: Readonly<Record<string, readonly string[]>> = {
  重用既有: ["重用", "擴充既有"],
  新建共用: ["新建"],
  新建專用: ["新建"],
};
const REASON_REQUIRED_TYPES: readonly string[] = ["新建共用", "新建專用"];
const TOP_SECTIONS: readonly string[] = ["版本管控歷程", "目錄", "規格說明", "API說明"];
/** 不確定寫法（SD 的每一項都要寫定案）。 */
export const UNCERTAIN_TERMS: readonly string[] = ["選用", "視情況", "可能", "或許", "也許", "酌情", "視需要", "必要時", "看情況", "待定", "暫定", "TBD"];
/** 內部過程檔名，不可出現在正式交付物。 */
export const SD_INTERNAL_FILES: readonly string[] = ["01-sa", "02-db", "03-sd", "spec-check", "sa-notes", "impl-fe", "impl-be", "dup-report", ".dev-pipeline", "verify.md", "test.md", "impact.md", "baseline.md", "tech-stack.md"];
const WORD_RES = [...UNCERTAIN_TERMS.map((t) => ({ t, re: termRe(t), kind: "不確定寫法" })), ...SD_INTERNAL_FILES.map((t) => ({ t, re: termRe(t), kind: "內部檔名" }))];
const LINK_RE = /\[[^\]]*\]\(([^)\s]+)\)/;

const noSpace = (s: string): string => s.replace(/\s+/g, "");
const clean = (c: string): string => c.replace(/[`*]/g, "").trim();
const sameHeader = (h: readonly string[], want: readonly string[]): boolean => h.length === want.length && h.every((x, i) => noSpace(clean(x)) === noSpace(want[i]));
const shorten = (t: string): string => (t.trim().length <= 40 ? t.trim() : `${t.trim().slice(0, 39)}…`);

function checkBasicInfo(text: string): string[] {
  const firstH2 = listHeadings(text).find((h) => h.level === 2);
  const head = text.split(/\r\n|\r|\n/).slice(0, firstH2 ? firstH2.line - 1 : undefined).join("\n");
  const table = parseTable(head);
  if (table === null) return [`${SD_FILE_NAME} 開頭缺少程式基本資料表（${SD_BASIC_ITEMS.join("、")}）`];
  const cells = [table.header, ...table.rows].flat().map(clean);
  const missing = SD_BASIC_ITEMS.filter((i) => !cells.includes(i));
  const out = missing.length > 0 ? [`${SD_FILE_NAME} 程式基本資料表缺少項目：${missing.join("、")}`] : [];
  const valueOf = (item: string): string => {
    const all = [table.header, ...table.rows];
    for (const r of all) {
      const i = r.map(clean).indexOf(item);
      if (i >= 0 && i % 2 === 0) return clean(r[i + 1] ?? "");
    }
    return "";
  };
  for (const item of ["程式代號", "程式名稱"]) if (cells.includes(item) && valueOf(item) === "") out.push(`${SD_FILE_NAME} 程式基本資料表的「${item}」沒有填`);
  return out;
}

function checkTopOrder(text: string): string[] {
  const heads = listHeadings(text).filter((h) => h.level === 2);
  const out: string[] = [];
  let last = 0;
  for (const name of TOP_SECTIONS) {
    const h = heads.find((x) => headingMatches(noSpace(x.title), name));
    if (!h) out.push(`${SD_FILE_NAME} 缺少必備章節「## ${name}」（順序：基本資料表→${TOP_SECTIONS.join("→")}）`);
    else if (h.line < last) out.push(`${SD_FILE_NAME} 章節「${name}」順序不對，要依序是：${TOP_SECTIONS.join("→")}`);
    else last = h.line;
  }
  const toc = extractSection(text, "目錄");
  if (toc !== null && toc.trim() === "") out.push(`${SD_FILE_NAME}「目錄」是空的`);
  return out;
}

/** 規格說明底下四節的內容（依 SD_SPEC_SECTIONS 順序）；缺的節回 null，並回報缺節與順序問題。 */
function specSections(text: string, out: string[]): (string | null)[] {
  const heads = listHeadings(text);
  const start = heads.findIndex((h) => h.level === 2 && headingMatches(noSpace(h.title), "規格說明"));
  const lines = text.split(/\r\n|\r|\n/);
  const endH2 = start < 0 ? undefined : heads.slice(start + 1).find((h) => h.level <= 2);
  const subs = start < 0 ? [] : heads.filter((h) => h.level === 3 && h.line > heads[start].line && (!endH2 || h.line < endH2.line));
  let last = 0;
  return SD_SPEC_SECTIONS.map((s) => {
    const i = subs.findIndex((h) => headingMatches(noSpace(h.title), s.name));
    if (i < 0) {
      if (start >= 0) out.push(`${SD_FILE_NAME} 「規格說明」缺少「### ${s.name}」（順序：${SD_SPEC_SECTIONS.map((x) => x.name).join("→")}）`);
      return null;
    }
    if (subs[i].line < last) out.push(`${SD_FILE_NAME}「${s.name}」順序不對，規格說明底下要依序是：${SD_SPEC_SECTIONS.map((x) => x.name).join("→")}`);
    last = subs[i].line;
    const next = subs[i + 1]?.line ?? endH2?.line ?? lines.length + 1;
    return lines.slice(subs[i].line, next - 1).join("\n");
  });
}

function sectionTable(body: string, idx: number, out: string[], allowEmpty: boolean): string[][] | null {
  const { name, header } = SD_SPEC_SECTIONS[idx];
  const table = parseTable(body);
  if (table === null || !sameHeader(table.header, header)) {
    out.push(`${SD_FILE_NAME}「${name}」必須是表格，表頭固定為：${header.join("｜")}`);
    return null;
  }
  if (table.rows.length === 0 && !allowEmpty) out.push(`${SD_FILE_NAME}「${name}」至少要有一列`);
  return table.rows;
}

function hasTableSchemas(dir: string): boolean {
  try {
    return readdirSync(path.join(dir, TABLE_SCHEMA_DIR)).some((f) => f.endsWith(".md"));
  } catch {
    return false;
  }
}

function checkTables(rows: string[][], dir: string | undefined, out: string[]): void {
  rows.forEach((r, i) => {
    const w = `${SD_FILE_NAME}「使用資料表」第 ${i + 1} 列`;
    const name = clean(r[0] ?? "");
    const target = LINK_RE.exec(r[3] ?? "")?.[1]?.replace(/^\.\//, "");
    if (name === "") out.push(`${w}的 Table 空白`);
    else if (!target) out.push(`${w}（${name}）的結構文件要用相對路徑連結連到 ${TABLE_SCHEMA_DIR}/${name}.md（只放連結，不放欄位）`);
    else if (target !== `${TABLE_SCHEMA_DIR}/${name}.md`) out.push(`${w}（${name}）的連結 ${target} 必須是 ${TABLE_SCHEMA_DIR}/${name}.md`);
    else if (dir && !existsSync(path.join(dir, TABLE_SCHEMA_DIR, `${name}.md`))) out.push(`${w}（${name}）連到的 ${target} 不存在於工作項目的 ${TABLE_SCHEMA_DIR}/`);
  });
}

function checkCommon(rows: string[][], out: string[]): Set<string> {
  const known = new Set<string>();
  rows.forEach((r, i) => {
    const w = `${SD_FILE_NAME}「共用方法清單」第 ${i + 1} 列`;
    const [method, loc, type, , note] = r.map(clean);
    splitCommonMethods(method ?? "").forEach((n) => known.add(n));
    if (!method) out.push(`${w}的共用方法空白`);
    if (!loc || !/[/\\]|\.[A-Za-z0-9]+$/.test(loc)) out.push(`${w}的位置要寫檔案路徑`);
    if (!Object.prototype.hasOwnProperty.call(SD_TYPE_DECISIONS, type ?? "")) out.push(`${w}的類型「${type ?? ""}」不合法（只能是：${Object.keys(SD_TYPE_DECISIONS).join("、")}）`);
    else if (REASON_REQUIRED_TYPES.includes(type) && !note) out.push(`${w}類型為「${type}」，說明必填（寫明用途；新建專用要寫為什麼無法共用）`);
  });
  return known;
}

function checkResponses(rows: string[][], out: string[]): void {
  rows.forEach((r, i) => {
    const w = `${SD_FILE_NAME}「共用回應與錯誤碼」第 ${i + 1} 列`;
    if (!/^\d{3}$/.test(clean(r[0] ?? ""))) out.push(`${w}的 HTTP 要是三位數字`);
    if (!clean(r[1] ?? "") || !clean(r[2] ?? "")) out.push(`${w}的 code 與 message 都要填`);
    if (!clean(r[4] ?? "")) out.push(`${w}的「檢核位置」沒有填（前端即時檢核或僅後端）`);
    if (!clean(r[5] ?? "")) out.push(`${w}的「前端提示位置」沒有填`);
  });
}

function checkWording(text: string): string[] {
  const out: string[] = [];
  const tableHeaders = (line: string): boolean => line.trim().startsWith("|") && /\bPK\b/.test(line) && /欄位/.test(line);
  eachLine(text, (line, no) => {
    for (const w of WORD_RES) if (w.re.test(line)) out.push(`${SD_FILE_NAME} 第 ${no} 行出現${w.kind}「${w.t}」：${shorten(line)}`);
    for (const m of META_SENTENCES) if (m.re.test(line)) out.push(`${SD_FILE_NAME} 第 ${no} 行有後設句（${m.label}），不寫說明本文件用途的句子：${shorten(line)}`);
    if (tableHeaders(line) || /CREATE\s+TABLE/i.test(line)) out.push(`${SD_FILE_NAME} 第 ${no} 行是資料表欄位定義，欄位只放資料表結構文件，SD 只放連結：${shorten(line)}`);
  });
  return out;
}

/** 檢查 03-sd.md 全文是否符合 SD 新標準；workItemDir 有帶才檢查 TableSchema 檔案是否存在。 */
export function checkSdStructure(text: string, workItemDir?: string): string[] {
  const out = [...checkBasicInfo(text), ...checkVersionHistory(text, SD_FILE_NAME), ...checkTopOrder(text)];
  const secs = specSections(text, out);
  // 沒有動資料庫的工作項目（TableSchema/ 內沒有任何結構文件）：使用資料表可以沒有資料列，表頭仍要在
  const noDb = workItemDir !== undefined && !hasTableSchemas(workItemDir);
  const rows = secs.map((b, i) => (b === null ? null : sectionTable(b, i, out, i === 0 && noDb)));
  if (rows[0]) checkTables(rows[0], workItemDir, out);
  const known = rows[2] ? checkCommon(rows[2], out) : new Set<string>();
  if (rows[3]) checkResponses(rows[3], out);
  const apis = parseSdApis(text);
  if (apis) out.push(...checkSdApis(apis, known, SD_FILE_NAME));
  return [...out, ...checkWording(text)];
}
