// 既有系統（brownfield）的既有資料表來源：
//  1. 自動：掃描專案目錄內的 .sql 腳本（CREATE TABLE，含欄位層級與表層級外鍵），這是目前流程唯一能自動取得的既有表結構；
//  2. 手動：TableSchema/system-er.md 的「## 既有資料表」表格（資料表｜主鍵｜外鍵｜說明），DB 設計師查 db_schema 後列出，同名時以此為準。
// 兩者都沒有時，brownfield 的系統 ER 圖無法驗證既有表，交件檢查會要求補上「既有資料表」一節。
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseTable } from "./md-table.js";
import { extractSection } from "./reuse-record-check.js";
import { parseCreateTables, type SqlForeignKey, type SqlTable } from "./sql-schema-parse.js";

export const EXISTING_HEADING = "既有資料表";
export const EXISTING_HEADER: readonly string[] = ["資料表", "主鍵", "外鍵", "說明"];
const SKIP_DIRS = new Set(["node_modules", ".git", ".svn", ".dev-pipeline", ".asana-pipeline", "dist", "build", "target", "out", "bin", "obj", ".idea", ".vscode"]);
const MAX_FILES = 300;
const MAX_DEPTH = 8;
const MAX_BYTES = 2 * 1024 * 1024;

function collectSqlFiles(dir: string, depth: number, acc: string[]): string[] {
  if (depth > MAX_DEPTH || acc.length >= MAX_FILES) return acc;
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory() && !SKIP_DIRS.has(e.name)) collectSqlFiles(full, depth + 1, acc);
    else if (e.isFile() && e.name.toLowerCase().endsWith(".sql") && acc.length < MAX_FILES) acc.push(full);
  }
  return acc;
}

/** 掃描專案目錄的 .sql 腳本取得既有資料表（同名以後出現者為準）；目錄不存在回空陣列。 */
export function scanProjectTables(projectDir: string | null | undefined): SqlTable[] {
  if (!projectDir) return [];
  const byName = new Map<string, SqlTable>();
  for (const f of collectSqlFiles(projectDir, 0, [])) {
    try {
      if (statSync(f).size > MAX_BYTES) continue;
      for (const t of parseCreateTables(readFileSync(f, "utf-8"))) byName.set(t.name, t);
    } catch {
      // 讀不了的腳本略過
    }
  }
  return [...byName.values()];
}

const splitList = (c: string, sep: RegExp): string[] => c.replace(/[`*]/g, "").split(sep).map((x) => x.trim()).filter(Boolean);
const isNone = (c: string): boolean => /^[\s無无-]*$/.test(c.replace(/[`*]/g, "")) || /^none$/i.test(c.trim());

function parseForeignKeys(cell: string): SqlForeignKey[] {
  if (isNone(cell)) return [];
  return splitList(cell, /[；;\n]/).flatMap((item) => {
    const m = /^(.+?)\s*(?:→|->)\s*(\w+)\.(.+)$/.exec(item);
    return m ? [{ columns: splitList(m[1], /[、,，\s]+/), parentTable: m[2], parentColumns: splitList(m[3], /[、,，\s]+/) }] : [];
  });
}

/** 解析系統 ER 圖文件的「既有資料表」一節；沒有這一節回 null（有節但沒有資料列回空陣列）。欄位只知道主鍵與外鍵欄位。 */
export function parseExistingSection(text: string): SqlTable[] | null {
  const body = extractSection(text, EXISTING_HEADING);
  const table = body === null ? null : parseTable(body);
  if (table === null || table.header.length !== EXISTING_HEADER.length || table.header.some((h, i) => h.replace(/[`*]/g, "").trim() !== EXISTING_HEADER[i])) return null;
  return table.rows.map((r) => {
    const primaryKey = isNone(r[1] ?? "") ? [] : splitList(r[1] ?? "", /[、,，\s]+/);
    const foreignKeys = parseForeignKeys(r[2] ?? "");
    const columns = [...new Set([...primaryKey, ...foreignKeys.flatMap((f) => f.columns)])];
    return { name: (r[0] ?? "").replace(/[`*]/g, "").trim(), columns, primaryKey, foreignKeys, uniques: [], notNull: [] };
  });
}

/** 合併既有資料表：掃描結果為底，既有資料表一節同名時覆蓋；去掉這次 02-db.sql 新建的表（新建者以本次設計為準）。 */
export function mergeExisting(scanned: readonly SqlTable[], section: readonly SqlTable[] | null, created: readonly string[]): SqlTable[] {
  const byName = new Map<string, SqlTable>();
  for (const t of [...scanned, ...(section ?? [])]) byName.set(t.name, t);
  return [...byName.values()].filter((t) => !created.includes(t.name));
}

/** 讀取 TableSchema/system-er.md 的既有資料表一節（檔案不存在或沒有該節回 null）。 */
export function readExistingSection(systemErFile: string): SqlTable[] | null {
  try {
    return parseExistingSection(readFileSync(systemErFile, "utf-8"));
  } catch {
    return null;
  }
}
