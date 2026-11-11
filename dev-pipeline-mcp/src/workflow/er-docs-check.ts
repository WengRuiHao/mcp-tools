// 資料表結構文件內的 ER 圖檢查：每份文件一張模組 ER 圖（「## 模組 ER 圖」），另有系統 ER 圖文件 TableSchema/system-er.md（「## 系統 ER 圖」）。
// 圖以 Mermaid erDiagram 寫在 md 內，並轉成 PNG 放在 TableSchema/er/<檔名>.png（圖片路徑相對於文件：er/<檔名>.png）。
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
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isPng(file: string): boolean {
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

/** 取出文件指定章節內的唯一 Mermaid 圖，並檢查對應 PNG（er/<imageName>）存在且是有效 PNG；回傳 Mermaid 全文（有問題時為 null）。 */
function embeddedDiagram(text: string, heading: string, where: string, imageName: string, dir: string, problems: string[]): string | null {
  const body = extractSection(text, heading);
  if (body === null) {
    problems.push(`${where} 缺少「## ${heading}」一節（Mermaid erDiagram 程式碼區塊加上轉出的 PNG）`);
    return null;
  }
  const blocks = mermaidBlocks(body);
  if (blocks.length !== 1) problems.push(`${where}「${heading}」要有且只有一個 \`\`\`mermaid 程式碼區塊（目前 ${blocks.length} 個）`);
  const refs = [...body.matchAll(IMAGE_RE)].map((m) => m[1].replace(/^\.\//, ""));
  if (!refs.includes(`er/${imageName}`)) problems.push(`${where}「${heading}」要用圖片引用轉出的 PNG：![說明](er/${imageName})`);
  else if (!isPng(path.join(dir, ER_IMAGE_DIR, imageName))) problems.push(`${where}「${heading}」引用的 ${ER_IMAGE_DIR}/${imageName} 不存在或不是有效的 PNG（用 work_item render 轉圖，或 attach destDir=er name=${imageName}）`);
  return blocks.length === 1 ? blocks[0] : null;
}

/** 一份分組文件的模組 ER 圖：圖上的表＝文件內的表，關聯線＝關聯清單內兩端都在文件內的列。 */
export function checkModuleEr(text: string, rel: string, dir: string, docTables: readonly SqlTable[], relations: readonly Relation[]): string[] {
  const where = `${rel} 的${MODULE_ER_HEADING}`;
  const problems: string[] = [];
  const src = embeddedDiagram(text, MODULE_ER_HEADING, rel, `${path.posix.basename(rel, ".md")}.png`, dir, problems);
  if (src === null) return problems;
  const inDoc = (n: string): boolean => docTables.some((t) => t.name === n);
  return [...problems, ...checkErDiagram(src, where, { tables: docTables, relations: expectedRelations(relations, docTables, inDoc) })];
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
}

/** 既有資料表之間（子表為既有表）的外鍵，系統圖也要畫。 */
function existingRelations(existing: readonly SqlTable[], inScope: (n: string) => boolean): ExpectedRelation[] {
  return existing.flatMap((t) => t.foreignKeys.filter((f) => inScope(f.parentTable)).map((f) => ({ parent: f.parentTable, child: t.name, kind: kindOfForeignKey(t, f), required: isRequired(t, f.columns) })));
}

function existingSourceProblem(text: string, input: SystemErInput): string[] {
  const hasSection = parseExistingSection(text) !== null;
  if (!input.brownfield || hasSection || scanProjectTables(input.projectDir).length > 0) return [];
  return [`${SYSTEM_ER_PATH} 既有系統取不到既有資料表（專案目錄沒有 .sql 腳本）：請查 db_schema，在文件加「## ${EXISTING_HEADING}」表格（表頭：${EXISTING_HEADER.join("｜")}；外鍵格式「欄位→父表.欄位」，多筆用「；」，沒有填「無」；確實沒有既有表就只留表頭）`];
}

/** 系統 ER 圖文件：全系統所有表（brownfield 含既有表），只畫表名加主鍵與外鍵；brownfield 要標「本次新增」「本次修改」。 */
export function checkSystemEr(input: SystemErInput): string[] {
  if (input.sqlTables.length === 0) return [];
  const file = path.join(input.dir, SYSTEM_ER_PATH);
  if (!existsSync(file)) return [`缺少系統 ER 圖文件 ${SYSTEM_ER_PATH}（畫全系統所有資料表與關聯，格式見資料表結構文件範本）`];
  const text = readFileSync(file, "utf-8");
  const problems = [...checkVersionHistory(text, SYSTEM_ER_PATH), ...existingSourceProblem(text, input)];
  const src = embeddedDiagram(text, SYSTEM_ER_HEADING, SYSTEM_ER_PATH, "system-er.png", input.dir, problems);
  if (src === null) return problems;
  const tables = [...input.sqlTables, ...input.existing];
  const inScope = (n: string): boolean => tables.some((t) => t.name === n);
  const marks = new Map<string, string>(input.brownfield ? [...input.sqlTables.map((t): [string, string] => [t.name, MARK_NEW]), ...input.alteredTables.filter((n) => input.existing.some((t) => t.name === n)).map((n): [string, string] => [n, MARK_MODIFIED])] : []);
  const relations = [...expectedRelations(input.relations, tables, inScope), ...existingRelations(input.existing, inScope)];
  return [...problems, ...checkErDiagram(src, `${SYSTEM_ER_PATH} 的${SYSTEM_ER_HEADING}`, { tables, relations, ...(input.brownfield ? { marks } : {}) })];
}
