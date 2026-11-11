// 步驟 D：資料表結構文件檢查（DB 設計師 done 時）。
// 02-db.sql 內每個 CREATE TABLE 的資料表，都要有 TableSchema/<表名>.md；每份要有版本管控歷程、欄位清單表（表頭固定）、各規格使用欄位對照，
// 且欄位清單涵蓋 SQL 內該表的所有欄位。
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseTable } from "./md-table.js";
import { extractSection } from "./reuse-record-check.js";
import { checkVersionHistory } from "./version-history-check.js";

export const TABLE_SCHEMA_DIR = "TableSchema";
export const DB_SQL_FILE = "02-db.sql";
export const COLUMN_LIST_HEADING = "欄位清單";
export const USAGE_HEADING = "各規格使用欄位對照";
export const COLUMN_LIST_HEADER: readonly string[] = ["#", "欄位", "型別", "PK", "說明"];
export const USAGE_HEADER: readonly string[] = ["規格", "使用欄位"];

export interface SqlTable {
  name: string;
  columns: string[];
}

const NON_COLUMN_RE = /^(?:constraint|primary|foreign|unique|key|index|check|fulltext|spatial|exclude|like)\b/i;
const stripSqlComments = (sql: string): string => sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
const unquote = (id: string): string => id.replace(/^[`"[]+|[`"\]]+$/g, "");

/** 找出對應的右括號位置（text[open] 是左括號）；找不到回 -1。 */
function matchParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

/** 以最外層逗號切開欄位定義。 */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  return [...parts, cur].map((p) => p.trim()).filter(Boolean);
}

/** 解析 SQL 中所有 CREATE TABLE 的表名與欄位名稱（表名去掉 schema 前綴與引號）。 */
export function parseCreateTables(sql: string): SqlTable[] {
  const text = stripSqlComments(sql);
  const out: SqlTable[] = [];
  for (const m of text.matchAll(/CREATE\s+(?:(?:GLOBAL\s+|LOCAL\s+)?TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"[\]\w.]+)\s*\(/gi)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const close = matchParen(text, open);
    if (close < 0) continue;
    const name = unquote(m[1].split(".").pop() ?? "");
    const columns = splitTopLevel(text.slice(open + 1, close))
      .filter((item) => !NON_COLUMN_RE.test(item))
      .map((item) => unquote(/^([`"[\]\w]+)/.exec(item)?.[1] ?? ""))
      .filter(Boolean);
    out.push({ name, columns });
  }
  return out;
}

const clean = (c: string): string => c.replace(/[`*_]/g, "").trim();
const sameHeader = (header: readonly string[], want: readonly string[]): boolean => header.length === want.length && header.every((h, i) => clean(h) === want[i]);
const RELATIVE_LINK_RE = /\[[^\]]+\]\((?!https?:|\/|[a-z]:|mailto:|#)[^)\s]+\)/i;

function checkColumnList(text: string, where: string, columns: readonly string[]): string[] {
  const body = extractSection(text, COLUMN_LIST_HEADING);
  if (body === null) return [`${where} 缺少「## ${COLUMN_LIST_HEADING}」一節`];
  const table = parseTable(body);
  if (table === null || !sameHeader(table.header, COLUMN_LIST_HEADER)) return [`${where}「${COLUMN_LIST_HEADING}」必須是表格，表頭固定為：${COLUMN_LIST_HEADER.join("｜")}`];
  const listed = new Set(table.rows.map((r) => (r[1] ?? "").replace(/[`*]/g, "").trim().toLowerCase()));
  const missing = columns.filter((c) => !listed.has(c.toLowerCase()));
  return missing.length > 0 ? [`${where}「${COLUMN_LIST_HEADING}」缺少 02-db.sql 中的欄位：${missing.join("、")}`] : [];
}

function checkUsage(text: string, where: string): string[] {
  const body = extractSection(text, USAGE_HEADING);
  if (body === null) return [`${where} 缺少「## ${USAGE_HEADING}」一節`];
  const table = parseTable(body);
  if (table === null || !sameHeader(table.header, USAGE_HEADER)) return [`${where}「${USAGE_HEADING}」必須是表格，表頭固定為：${USAGE_HEADER.join("｜")}`];
  if (table.rows.length === 0) return [`${where}「${USAGE_HEADING}」至少要有一列（哪份規格使用哪些欄位）`];
  return table.rows.flatMap((r, i) => (RELATIVE_LINK_RE.test(r[0] ?? "") ? [] : [`${where}「${USAGE_HEADING}」第 ${i + 1} 列的規格要用相對路徑連結連回規格文件（例如 [規格名稱](../03-sd.md)）`]));
}

/** 檢查單一資料表結構文件全文。 */
export function checkTableSchemaText(text: string, fileName: string, columns: readonly string[]): string[] {
  return [...checkVersionHistory(text, fileName), ...checkColumnList(text, fileName, columns), ...checkUsage(text, fileName)];
}

/** 檢查工作項目：02-db.sql 的每個資料表都有結構文件且內容合格；沒有 02-db.sql 回空陣列（缺檔由一般交件檢查回報）。 */
export function checkTableSchemas(workItemDir: string): string[] {
  const sqlFile = path.join(workItemDir, DB_SQL_FILE);
  if (!existsSync(sqlFile)) return [];
  const problems: string[] = [];
  for (const t of parseCreateTables(readFileSync(sqlFile, "utf-8"))) {
    const rel = `${TABLE_SCHEMA_DIR}/${t.name}.md`;
    const file = path.join(workItemDir, TABLE_SCHEMA_DIR, `${t.name}.md`);
    if (!/^\w+$/.test(t.name)) problems.push(`資料表「${t.name}」的名稱不是英數字與底線，無法對應 ${TABLE_SCHEMA_DIR}/<表名>.md`);
    else if (!existsSync(file)) problems.push(`02-db.sql 的資料表 ${t.name} 缺少結構文件 ${rel}`);
    else problems.push(...checkTableSchemaText(readFileSync(file, "utf-8"), rel, t.columns));
  }
  return problems;
}
