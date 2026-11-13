// 資料表結構文件檢查（DB 設計師 done 時）：分組格式。有關聯的表放同一份 TableSchema/<主表名>.md，單獨的表各一份。
// 每份文件：本文件包含的資料表清單、版本管控歷程（整份一次）、每張表一個「## 資料表：<表名>」小節（欄位清單、索引、各規格使用欄位對照）。
// 02-db.sql 的每個 CREATE TABLE 必須恰好出現在一份文件的一個小節；欄位清單涵蓋 SQL 全部欄位。
// 無異動模式：02-db.sql 只有註解（沒有任何語句）＝本次沒有資料表異動，表來源改為「既有資料表」（專案 .sql 掃描或 system-er.md「## 既有資料表」一節），其餘規則比照。
// 分組由 DB 設計師判斷，程式只擋明顯不合理：同一份文件內的表之間必須有關聯連通。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseTable } from "./md-table.js";
import { checkModuleEr, checkSystemEr } from "./er-docs-check.js";
import { EXISTING_HEADING, applyAlterChanges, declaresNoTables, mergeExisting, readExistingSection, scanProjectTables } from "./existing-tables.js";
import { checkRelationList, type Relation } from "./relation-list-check.js";
import { classifySql, parseAlterChanges, parseAlteredTables, parseCreateTables, type SqlTable } from "./sql-schema-parse.js";
import { INCLUDED_HEADING, INCLUDED_HEADER, includedTables, tableSections } from "./table-schema-doc.js";
import { extractSection } from "./reuse-record-check.js";
import { checkVersionHistory } from "./version-history-check.js";

export { parseCreateTables, type SqlTable };
export const TABLE_SCHEMA_DIR = "TableSchema";
export const DB_SQL_FILE = "02-db.sql";
export const COLUMN_LIST_HEADING = "欄位清單";
export const USAGE_HEADING = "各規格使用欄位對照";
export const COLUMN_LIST_HEADER: readonly string[] = ["#", "欄位", "型別", "PK", "說明"];
export const USAGE_HEADER: readonly string[] = ["規格", "使用欄位"];
/** 系統 ER 圖文件（檔名固定、含連字號，不會與表名衝突）。 */
export const SYSTEM_ER_FILE = "system-er.md";

const SYSTEM_ER_PATH_HINT = `${TABLE_SCHEMA_DIR}/${SYSTEM_ER_FILE}`;
const clean = (c: string): string => c.replace(/[`*_]/g, "").trim();
const sameHeader = (header: readonly string[], want: readonly string[]): boolean => header.length === want.length && header.every((h, i) => clean(h) === want[i]);
const RELATIVE_LINK_RE = /\[[^\]]+\]\((?!https?:|\/|[a-z]:|mailto:|#)[^)\s]+\)/i;

function checkColumnList(text: string, where: string, columns: readonly string[], source = `${DB_SQL_FILE} 中`): string[] {
  const body = extractSection(text, COLUMN_LIST_HEADING);
  if (body === null) return [`${where} 缺少「### ${COLUMN_LIST_HEADING}」一節`];
  const table = parseTable(body);
  if (table === null || !sameHeader(table.header, COLUMN_LIST_HEADER)) return [`${where}「${COLUMN_LIST_HEADING}」必須是表格，表頭固定為：${COLUMN_LIST_HEADER.join("｜")}`];
  const listed = new Set(table.rows.map((r) => (r[1] ?? "").replace(/[`*]/g, "").trim().toLowerCase()));
  const missing = columns.filter((c) => !listed.has(c.toLowerCase()));
  return missing.length > 0 ? [`${where}「${COLUMN_LIST_HEADING}」缺少 ${source}的欄位：${missing.join("、")}`] : [];
}

function checkUsage(text: string, where: string): string[] {
  const body = extractSection(text, USAGE_HEADING);
  if (body === null) return [`${where} 缺少「### ${USAGE_HEADING}」一節`];
  const table = parseTable(body);
  if (table === null || !sameHeader(table.header, USAGE_HEADER)) return [`${where}「${USAGE_HEADING}」必須是表格，表頭固定為：${USAGE_HEADER.join("｜")}`];
  if (table.rows.length === 0) return [`${where}「${USAGE_HEADING}」至少要有一列（哪份規格使用哪些欄位）`];
  return table.rows.flatMap((r, i) => (RELATIVE_LINK_RE.test(r[0] ?? "") ? [] : [`${where}「${USAGE_HEADING}」第 ${i + 1} 列的規格要用相對路徑連結連回規格文件（例如 [規格名稱](../03-sd.md)）`]));
}

/** 檢查單一表小節（欄位清單、各規格使用欄位對照）。 */
export function checkTableSection(body: string, where: string, columns: readonly string[], source?: string): string[] {
  return [...checkColumnList(body, where, columns, source), ...checkUsage(body, where)];
}

/** 一份文件結構檢查：包含清單、版本管控歷程、每個小節；回傳違規與文件內的表名。 */
export function checkDocStructure(text: string, rel: string, sqlTables: readonly SqlTable[], noChange = false, created?: readonly string[]): { problems: string[]; tables: string[] } {
  const problems = checkVersionHistory(text, rel);
  const sections = tableSections(text);
  const listed = includedTables(text);
  const incBody = extractSection(text, INCLUDED_HEADING);
  const incTable = incBody === null ? null : parseTable(incBody);
  if (listed === null || incTable === null || !sameHeader(incTable.header, INCLUDED_HEADER)) problems.push(`${rel} 缺少「## ${INCLUDED_HEADING}」表格（表頭固定為：${INCLUDED_HEADER.join("｜")}），列出本文件包含的每張表`);
  if (sections.length === 0) problems.push(`${rel} 沒有任何「## 資料表：<表名>」小節`);
  const names = sections.map((s) => s.table);
  names.forEach((n, i) => names.indexOf(n) !== i && problems.push(`${rel} 的資料表 ${n} 小節重複出現`));
  if (listed !== null && [...listed].sort().join(",") !== [...names].sort().join(",")) problems.push(`${rel}「${INCLUDED_HEADING}」（${listed.join("、")}）必須與文件內的「資料表：」小節（${names.join("、")}）一致`);
  const stem = path.posix.basename(rel, ".md");
  if (listed && listed.length > 0 && listed[0] !== stem) problems.push(`${rel} 檔名必須是主表名：「${INCLUDED_HEADING}」第一列是 ${listed[0]}，檔名應為 ${TABLE_SCHEMA_DIR}/${listed[0]}.md`);
  for (const s of sections) {
    const t = sqlTables.find((x) => x.name === s.table);
    const fromExisting = noChange || (created !== undefined && !created.includes(s.table));
    if (!t) problems.push(noChange ? `${rel} 的資料表 ${s.table} 不在既有資料表內（${DB_SQL_FILE} 只有註解、無 CREATE TABLE）：只能寫既有的表；請確認表名，或在 ${SYSTEM_ER_PATH_HINT} 的「## ${EXISTING_HEADING}」補上這張表` : `${rel} 的資料表 ${s.table} 不在 ${DB_SQL_FILE} 的 CREATE TABLE 內，也不是既有資料表（既有表要在 ${SYSTEM_ER_PATH_HINT} 的「## ${EXISTING_HEADING}」列出，或在專案 .sql 腳本內）`);
    else problems.push(...checkTableSection(s.body, `${rel}「資料表：${s.table}」`, t.columns, fromExisting ? "既有資料表宣告（主鍵、外鍵與「欄位」欄）中" : undefined));
  }
  return { problems, tables: names };
}

/** 同一份文件內的表必須經由外鍵（或關聯清單的邏輯關聯）連通。links 為額外的關聯對（子表, 父表）。 */
export function checkConnected(tables: readonly string[], sqlTables: readonly SqlTable[], rel: string, links: readonly [string, string][] = []): string[] {
  if (tables.length < 2) return [];
  const edges: [string, string][] = [...links, ...sqlTables.filter((t) => tables.includes(t.name)).flatMap((t) => t.foreignKeys.map((f): [string, string] => [t.name, f.parentTable]))];
  const seen = new Set<string>([tables[0]]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [a, b] of edges) {
      if (seen.has(a) !== seen.has(b) && tables.includes(a) && tables.includes(b)) {
        seen.add(a).add(b);
        grew = true;
      }
    }
  }
  const apart = tables.filter((t) => !seen.has(t));
  return apart.length > 0 ? [`${rel} 內的資料表 ${apart.join("、")} 與其他表沒有任何關聯（外鍵或關聯清單），不可硬湊在同一份文件；沒有關聯的表請各自一份`] : [];
}

/** 全部分組文件的關聯清單列（供 ER 圖比對與邏輯關聯清單使用）。 */
export function collectRelations(workItemDir: string, sqlTables: readonly SqlTable[]): Relation[] {
  return schemaDocFiles(workItemDir).flatMap((f) => {
    const text = readFileSync(path.join(workItemDir, TABLE_SCHEMA_DIR, f), "utf-8");
    return checkRelationList(text, f, tableSections(text).map((s) => s.table), sqlTables, () => undefined).relations;
  });
}

/** 邏輯關聯清單：程式無法驗證真偽，列給規格驗證師對照程式碼確認。 */
export function listLogicalRelations(workItemDir: string): string[] {
  const sqlFile = path.join(workItemDir, DB_SQL_FILE);
  if (!existsSync(sqlFile)) return [];
  const rels = collectRelations(workItemDir, parseCreateTables(readFileSync(sqlFile, "utf-8")));
  return rels.filter((r) => r.basis === "邏輯關聯").map((r) => `${r.child}.${r.childCols.join("、")} → ${r.parent}.${r.parentCols.join("、")}（${r.kind}）`);
}

/** TableSchema/ 內的分組文件檔名（不含系統 ER 圖）。 */
export function schemaDocFiles(workItemDir: string): string[] {
  try {
    return readdirSync(path.join(workItemDir, TABLE_SCHEMA_DIR)).filter((f) => f.toLowerCase().endsWith(".md") && f !== SYSTEM_ER_FILE).sort();
  } catch {
    return [];
  }
}

export interface SchemaCheckOptions {
  /** brownfield 才需要既有資料表（外鍵可指向既有表）。 */
  baseline?: string | undefined;
  /** 掃描既有 DB 腳本用的專案目錄。 */
  projectDir?: string | null | undefined;
}

/** 既有資料表（僅 brownfield）：專案 .sql 掃描，加上 system-er.md「既有資料表」一節。 */
export function loadExistingTables(workItemDir: string, sqlTables: readonly SqlTable[], opts: SchemaCheckOptions, sqlText = ""): SqlTable[] {
  if (opts.baseline !== "brownfield") return [];
  const section = readExistingSection(path.join(workItemDir, TABLE_SCHEMA_DIR, SYSTEM_ER_FILE));
  const created = sqlTables.map((t) => t.name);
  return applyAlterChanges(mergeExisting(scanProjectTables(opts.projectDir), section, created), parseAlterChanges(sqlText), created);
}

/** 欄位清單表格內列出的欄位名（章節缺少或表頭不符回空陣列；格式問題由 checkColumnList 回報）。 */
export function listedColumns(sectionBody: string): string[] {
  const body = extractSection(sectionBody, COLUMN_LIST_HEADING);
  const table = body === null ? null : parseTable(body);
  if (table === null || !sameHeader(table.header, COLUMN_LIST_HEADER)) return [];
  return table.rows.map((r) => (r[1] ?? "").replace(/[`*]/g, "").trim()).filter(Boolean);
}

const BLANK_SQL_PROBLEM = `${DB_SQL_FILE} 是空白的：本次有資料表異動就寫 SQL；沒有異動也不能留空，請只寫註解說明「本次無資料庫異動」與理由（例如只讀既有表 xxx），並在 ${SYSTEM_ER_PATH_HINT} 加「## ${EXISTING_HEADING}」章節、把用到的既有表整理成分組文件`;

/** 無異動模式（02-db.sql 只有註解）的整體要求：用到既有表就至少要有一份分組文件。 */
function noChangeProblems(existing: readonly SqlTable[], docCount: number): string[] {
  return existing.length > 0 && docCount === 0 ? [`${DB_SQL_FILE} 只有註解（本次無資料表異動），但 ${TABLE_SCHEMA_DIR}/ 沒有任何分組文件：用到的既有表要整理成 ${TABLE_SCHEMA_DIR}/<主表名>.md（版本管控歷程寫本規格建立的初版或更新、各規格使用欄位對照寫本規格用到的欄位），既有表來源見 ${SYSTEM_ER_PATH_HINT} 的「## ${EXISTING_HEADING}」`] : [];
}

/** 檢查工作項目：02-db.sql 的每個資料表恰好在一份文件的一個小節；沒有 02-db.sql 回空陣列（缺檔由一般交件檢查回報）。只有註解時為無異動模式（表集合＝既有資料表）。 */
export function checkTableSchemas(workItemDir: string, opts: SchemaCheckOptions = {}): string[] {
  const sqlFile = path.join(workItemDir, DB_SQL_FILE);
  if (!existsSync(sqlFile)) return [];
  const sqlText = readFileSync(sqlFile, "utf-8");
  const kind = classifySql(sqlText);
  if (kind === "blank") return [BLANK_SQL_PROBLEM];
  const noChange = kind === "comment-only";
  const sqlTables = parseCreateTables(sqlText);
  const allRelations: Relation[] = [];
  const created = sqlTables.map((t) => t.name);
  const existing = loadExistingTables(workItemDir, sqlTables, opts, sqlText);
  const known = [...sqlTables, ...existing];
  const lookup = (n: string) => known.find((t) => t.name === n);
  const problems: string[] = [];
  const owner = new Map<string, string[]>();
  for (const t of sqlTables) if (!/^\w+$/.test(t.name)) problems.push(`資料表「${t.name}」的名稱不是英數字與底線，無法作為小節名稱與檔名`);
  const files = schemaDocFiles(workItemDir);
  // 本次沒有使用任何資料表：無異動、既有資料表章節明確為空或寫「無」、也沒有分組文件 → 不要求文件與系統 ER 圖。
  if (noChange && files.length === 0 && declaresNoTables(readExistingSection(path.join(workItemDir, TABLE_SCHEMA_DIR, SYSTEM_ER_FILE)))) return problems;
  if (noChange) problems.push(...noChangeProblems(existing, files.length));
  const docs = files.map((f) => ({ rel: `${TABLE_SCHEMA_DIR}/${f}`, text: readFileSync(path.join(workItemDir, TABLE_SCHEMA_DIR, f), "utf-8") }));
  // 只知道部分欄位的既有表：欄位清單是圖上欄位的依據（ER 圖欄位必須在欄位清單內）。
  const docColumns = new Map<string, string[]>();
  for (const d of docs) for (const s of tableSections(d.text)) docColumns.set(s.table, [...(docColumns.get(s.table) ?? []), ...listedColumns(s.body)]);
  const withListed = (t: SqlTable): SqlTable => (t.columnsPartial ? { ...t, columns: [...new Set([...t.columns, ...(docColumns.get(t.name) ?? [])])] } : t);
  const knownEr = known.map(withListed);
  for (const { rel, text } of docs) {
    const r = checkDocStructure(text, rel, known, noChange, created);
    const rels = checkRelationList(text, rel, r.tables, known, lookup);
    allRelations.push(...rels.relations);
    problems.push(...checkModuleEr(text, rel, workItemDir, knownEr.filter((t) => r.tables.includes(t.name)), rels.relations, noChange));
    problems.push(...r.problems, ...rels.problems, ...checkConnected(r.tables, known, rel, rels.relations.map((x): [string, string] => [x.child, x.parent])));
    for (const n of new Set(r.tables)) owner.set(n, [...(owner.get(n) ?? []), rel]);
  }
  for (const t of sqlTables) {
    const owners = owner.get(t.name) ?? [];
    if (owners.length === 0) problems.push(`${DB_SQL_FILE} 的資料表 ${t.name} 沒有出現在任何 ${TABLE_SCHEMA_DIR}/ 文件的小節（每張表都要有「## 資料表：${t.name}」）`);
    else if (owners.length > 1) problems.push(`資料表 ${t.name} 同時出現在多份文件（${owners.join("、")}），每張表只能在一份文件的一個小節`);
  }
  for (const [n, owners] of owner) if (!created.includes(n) && owners.length > 1) problems.push(`資料表 ${n} 同時出現在多份文件（${owners.join("、")}），每張表只能在一份文件的一個小節`);
  const alteredFk = [...new Set(parseAlterChanges(sqlText).map((c) => c.table))].filter((n) => !created.includes(n) && existing.some((t) => t.name === n));
  for (const n of alteredFk) if (!owner.has(n)) problems.push(`${DB_SQL_FILE} 以 ALTER TABLE 對既有資料表 ${n} 新增了外鍵，${n} 要整理進 ${TABLE_SCHEMA_DIR}/ 的分組文件（「## 資料表：${n}」），並在該文件的「關聯清單」與系統 ER 圖列出新外鍵`);
  problems.push(...checkSystemEr({ dir: workItemDir, sqlTables, sqlText, relations: allRelations, brownfield: opts.baseline === "brownfield", projectDir: opts.projectDir, existing: existing.map(withListed), alteredTables: parseAlteredTables(sqlText), noChange }));
  return problems;
}
