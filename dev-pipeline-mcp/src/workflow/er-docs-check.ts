// 資料表結構文件內的 ER 圖檢查：每份文件一張模組 ER 圖（「## 模組 ER 圖」），另有系統 ER 圖文件 TableSchema/system-er.md（「## 系統 ER 圖」）。
// ER 圖的 Mermaid erDiagram 來源是內部檔 TableSchema/_src/<檔名>.mmd，轉成 PNG 放在 TableSchema/er/<檔名>.png；文件章節內只放圖片引用（路徑相對於文件：er/<檔名>.png），不放 mermaid。
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { checkErDiagram, expectedRelations, MARK_MODIFIED, MARK_NEW, type ExpectedRelation } from "./er-diagram-check.js";
import { EXISTING_HEADING, EXISTING_HEADER, parseExistingSection, scanProjectTables } from "./existing-tables.js";
import { kindOfForeignKey, isRequired, type Relation } from "./relation-list-check.js";
import { extractSection } from "./reuse-record-check.js";
import { IMAGE_RE } from "./sa-image-check.js";
import type { SqlTable } from "./sql-schema-parse.js";
import { mermaidBlocks } from "./table-schema-doc.js";
import { checkVersionHistory } from "./version-history-check.js";

export const MODULE_ER_HEADING = "模組 ER 圖";
export const SYSTEM_ER_HEADING = "系統 ER 圖";
export const SYSTEM_ER_PATH = "TableSchema/system-er.md";
export const ER_IMAGE_DIR = "TableSchema/er";
/** ER 圖 Mermaid 來源（內部檔，不交付、不放進任何文件）。 */
export const ER_SOURCE_DIR = "TableSchema/_src";
const PNG_STALE_TOLERANCE_MS = 1000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function isPng(file: string): boolean {
  try {
    if (!statSync(file).isFile() || statSync(file).size < 8) return false;
    const fd = openSync(file, "r");
    const head = Buffer.alloc(8);
    readSync(fd, head, 0, 8, 0);
    closeSync(fd);
    return head.equals(PNG_SIGNATURE);
  } catch {
    return false;
  }
}

/** 取出 ER 圖的 Mermaid 來源：新格式讀 TableSchema/_src/<stem>.mmd，文件章節內只放轉出的 PNG 引用（er/<stem>.png）；舊格式（legacy，章節內嵌 mermaid）仍可通過。回傳 Mermaid 全文（有問題時為 null）。 */
function embeddedDiagram(text: string, heading: string, where: string, imageName: string, dir: string, problems: string[], legacy: boolean): string | null {
  const stem = imageName.replace(/\.png$/, "");
  const srcRel = `${ER_SOURCE_DIR}/${stem}.mmd`;
  const srcFile = path.join(dir, ...srcRel.split("/"));
  const body = extractSection(text, heading);
  if (body === null) {
    problems.push(`${where} 缺少「## ${heading}」一節（放轉出的 ER 圖 PNG 引用 ![說明](er/${imageName})；Mermaid 來源寫在 ${srcRel}）`);
    return null;
  }
  const blocks = mermaidBlocks(body);
  const hasSrc = existsSync(srcFile);
  const embedded = legacy && !hasSrc && blocks.length === 1;
  if (blocks.length > 0 && !embedded) problems.push(`${where}「${heading}」不可放 \`\`\`mermaid 程式碼區塊：文件內只放圖片引用 ![說明](er/${imageName})，Mermaid 來源改寫在 ${srcRel}（write filename=${srcRel}，範本：work_item action=template template=${stem === "system-er" ? "system-er-source" : "er-source"}）`);
  if (!hasSrc && !embedded) problems.push(`${where}缺少 ER 圖來源 ${srcRel}（Mermaid erDiagram 原始碼，用 work_item write filename=${srcRel} 寫入，再用 render kind=mermaid src=${srcRel} out=${ER_IMAGE_DIR}/${imageName} 轉圖）`);
  const refs = [...body.matchAll(IMAGE_RE)].map((m) => m[1].replace(/^\.\//, ""));
  const pngFile = path.join(dir, ER_IMAGE_DIR, imageName);
  if (!refs.includes(`er/${imageName}`)) problems.push(`${where}「${heading}」要用圖片引用轉出的 PNG：![說明](er/${imageName})`);
  else if (!isPng(pngFile)) problems.push(`${where}「${heading}」引用的 ${ER_IMAGE_DIR}/${imageName} 不存在或不是有效的 PNG（用 work_item render 轉圖，或 attach destDir=er name=${imageName}）`);
  else if (hasSrc && statSync(pngFile).mtimeMs + PNG_STALE_TOLERANCE_MS < statSync(srcFile).mtimeMs) problems.push(`${where}「${heading}」的圖片 ${ER_IMAGE_DIR}/${imageName} 比來源 ${srcRel} 舊，來源改過後請重新轉圖（render kind=mermaid 或 attach destDir=er）`);
  if (hasSrc) {
    try {
      return readFileSync(srcFile, "utf-8");
    } catch {
      problems.push(`${where}讀不到 ER 圖來源 ${srcRel}`);
      return null;
    }
  }
  return embedded ? blocks[0] : null;
}

/** 一份分組文件的模組 ER 圖：圖上的表＝文件內的表，關聯線＝關聯清單內兩端都在文件內的列。 */
export function checkModuleEr(text: string, rel: string, dir: string, docTables: readonly SqlTable[], relations: readonly Relation[], noChange = false, legacy = false): string[] {
  const where = `${rel} 的${MODULE_ER_HEADING}`;
  const problems: string[] = [];
  const src = embeddedDiagram(text, MODULE_ER_HEADING, rel, `${path.posix.basename(rel, ".md")}.png`, dir, problems, legacy);
  if (src === null) return problems;
  const inDoc = (n: string): boolean => docTables.some((t) => t.name === n);
  return [...problems, ...checkErDiagram(src, where, { tables: docTables, relations: expectedRelations(relations, docTables, inDoc), ...(noChange ? { marks: new Map<string, string>(), noChange } : {}) })];
}

export interface SystemErInput {
  dir: string;
  sqlTables: readonly SqlTable[];
  sqlText: string;
  relations: readonly Relation[];
  brownfield: boolean;
  projectDir: string | null | undefined;
  existing: readonly SqlTable[];
  alteredTables: readonly string[];
  /** 02-db.sql 只有註解（本次無資料表異動）：表集合為既有資料表，不可有新增／修改標註。 */
  noChange?: boolean;
  /** 舊格式工作項目（ER 圖 Mermaid 內嵌在文件章節）仍接受。 */
  legacy?: boolean;
}

/** 既有資料表之間（子表為既有表）的外鍵，系統圖也要畫。 */
function existingRelations(existing: readonly SqlTable[], inScope: (n: string) => boolean, listed: readonly Relation[] = []): ExpectedRelation[] {
  return existing.flatMap((t) => t.foreignKeys.filter((f) => inScope(f.parentTable) && !listed.some((r) => r.child === t.name && r.parent === f.parentTable)).map((f) => ({ parent: f.parentTable, child: t.name, kind: kindOfForeignKey(t, f), required: isRequired(t, f.columns) })));
}

const hasExistingSource = (input: SystemErInput): boolean => scanProjectTables(input.projectDir).length > 0 || (existsSync(path.join(input.dir, SYSTEM_ER_PATH)) && parseExistingSection(readFileSync(path.join(input.dir, SYSTEM_ER_PATH), "utf-8")) !== null);
const noChangeSourceProblem = (): string => `02-db.sql 只有註解（本次無資料表異動），但取不到既有資料表（專案目錄掃不到 .sql 腳本；表結構若寫在程式碼內嵌字串，例如 src/db.js 的 SCHEMA，程式不會解析）：請在 ${SYSTEM_ER_PATH} 加「## ${EXISTING_HEADING}」表格（表頭：${EXISTING_HEADER.join("｜")}，可加選填「欄位」欄），列出本次用到與全系統的既有表，再依其畫系統 ER 圖，並把用到的既有表整理成分組文件`;

function existingSourceProblem(text: string, input: SystemErInput): string[] {
  const hasSection = parseExistingSection(text) !== null;
  if (!input.brownfield || hasSection || scanProjectTables(input.projectDir).length > 0) return [];
  return [`${SYSTEM_ER_PATH} 既有系統取不到既有資料表（專案目錄掃不到 .sql 腳本；表結構若寫在程式碼內嵌字串，例如 src/db.js 的 SCHEMA，程式不會解析）：請查 db_schema 或讀該內嵌定義，在文件加「## ${EXISTING_HEADING}」表格（表頭：${EXISTING_HEADER.join("｜")}；說明欄註明來源檔；外鍵格式「欄位→父表.欄位」，多筆用「；」，沒有填「無」；確實沒有既有表就只留表頭）`];
}

/** 系統 ER 圖文件：全系統所有表（brownfield 含既有表），只畫表名加主鍵與外鍵；brownfield 要標「本次新增」「本次修改」。 */
export function checkSystemEr(input: SystemErInput): string[] {
  const alteredExisting = input.alteredTables.some((n) => input.existing.some((t) => t.name === n));
  if (input.sqlTables.length === 0 && !input.noChange && !alteredExisting) return [];
  if (input.noChange && input.existing.length === 0) return input.brownfield && !hasExistingSource(input) ? [noChangeSourceProblem()] : [];
  const file = path.join(input.dir, SYSTEM_ER_PATH);
  if (!existsSync(file)) return [`缺少系統 ER 圖文件 ${SYSTEM_ER_PATH}（畫全系統所有資料表與關聯，格式見資料表結構文件範本）`];
  const text = readFileSync(file, "utf-8");
  const problems = [...checkVersionHistory(text, SYSTEM_ER_PATH), ...existingSourceProblem(text, input)];
  const src = embeddedDiagram(text, SYSTEM_ER_HEADING, SYSTEM_ER_PATH, "system-er.png", input.dir, problems, input.legacy === true);
  if (src === null) return problems;
  const tables = [...input.sqlTables, ...input.existing];
  const inScope = (n: string): boolean => tables.some((t) => t.name === n);
  const marks = new Map<string, string>(input.brownfield ? [...input.sqlTables.map((t): [string, string] => [t.name, MARK_NEW]), ...input.alteredTables.filter((n) => input.existing.some((t) => t.name === n)).map((n): [string, string] => [n, MARK_MODIFIED])] : []);
  const relations = [...expectedRelations(input.relations, tables, inScope), ...existingRelations(input.existing, inScope, input.relations)];
  return [...problems, ...checkErDiagram(src, `${SYSTEM_ER_PATH} 的${SYSTEM_ER_HEADING}`, { tables, relations, ...(input.brownfield ? { marks, ...(input.noChange ? { noChange: true } : {}) } : {}) })];
}
