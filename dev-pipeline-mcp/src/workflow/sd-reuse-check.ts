// SD 交件的「事實核對」：共用方法清單的「重用既有」列要指向真的存在的檔案與方法；API INPUT 的「對應 DB 欄位」要對得上資料表結構文件。
// 兩項都需要專案目錄；沒有專案目錄時呼叫端略過（向下相容）。純讀檔、不改檔，回傳違規逐項說明（空陣列＝合格）。
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseTable } from "./md-table.js";
import { scanProjectTables, readExistingSection } from "./existing-tables.js";
import type { SdApi } from "./sd-api-parse.js";
import { splitCommonMethods } from "./sd-api-parse.js";
import { hasWord, insideProject } from "./sd-layer-check.js";
import { DB_SQL_FILE, listedColumns, parseCreateTables, schemaDocFiles, SYSTEM_ER_FILE, TABLE_SCHEMA_DIR } from "./table-schema-check.js";
import { tableSections } from "./table-schema-doc.js";

/** 「重用既有」列的說明欄：去除空白後至少幾個字元（作為「為什麼適用」的證據）。 */
export const MIN_REUSE_NOTE_CHARS = 8;
export const REUSE_EXISTING_TYPE = "重用既有";

const clean = (c: string): string => c.replace(/[`*]/g, "").trim();

/** 共用方法名稱可能寫成 Class.method、Class#method、Class::method：完整名稱或最後一段出現在檔案內都算。 */
function methodAppears(text: string, name: string): boolean {
  if (hasWord(text, name)) return true;
  const last = name.split(/[.#:]+/).filter(Boolean).pop();
  return last !== undefined && last !== name && hasWord(text, last);
}

/** 共用方法清單的「重用既有」列：位置檔案存在於專案內、方法名在檔案內出現、說明至少 MIN_REUSE_NOTE_CHARS 字元。 */
export function checkReuseExistingRows(rows: readonly string[][], projectDir: string, file: string): string[] {
  const out: string[] = [];
  rows.forEach((r, i) => {
    const [method, loc, type, , note] = r.map(clean);
    if (type !== REUSE_EXISTING_TYPE) return;
    const w = `${file}「共用方法清單」第 ${i + 1} 列（${method || "共用方法空白"}，重用既有）`;
    if ((note ?? "").replace(/\s/g, "").length < MIN_REUSE_NOTE_CHARS) {
      out.push(`${w}的說明至少要 ${MIN_REUSE_NOTE_CHARS} 個字元：請寫明這個既有方法為什麼適用（它做什麼、這支 API 為什麼能直接沿用），不能只寫「既有工具」這類空話`);
    }
    if (!loc || !/[/\\]|\.[A-Za-z0-9]+$/.test(loc)) return; // 位置不像路徑：由結構檢查回報
    const full = insideProject(projectDir, loc);
    if (full === null) {
      out.push(`${w}的位置 ${loc} 超出專案目錄，只能寫相對於專案目錄的檔案路徑`);
      return;
    }
    if (!existsSync(full) || !statSync(full).isFile()) {
      out.push(`${w}的位置 ${loc} 在專案目錄裡找不到這個檔案：重用既有必須指向真的存在的程式；若是新寫的請把類型改成「新建共用」或「新建專用」，若路徑寫錯請更正`);
      return;
    }
    let text: string;
    try {
      text = readFileSync(full, "utf-8");
    } catch {
      return; // 讀不了（例如二進位或權限）：不誤擋
    }
    const missing = splitCommonMethods(method ?? "").filter((n) => !methodAppears(text, n));
    if (missing.length > 0) out.push(`${w}在 ${loc} 裡找不到方法名稱：${missing.join("、")}（要以完整詞出現；請確認方法名與檔案是否寫對，或改成「新建共用」）`);
  });
  return out;
}

interface KnownTable {
  columns: Set<string>;
  /** 只知道部分欄位：欄位比對不到時不能證明不存在。 */
  partial: boolean;
}

/** 工作項目本身的資料表來源：TableSchema/ 分組文件的欄位清單、02-db.sql 的 CREATE TABLE（表名與欄位一律小寫）。 */
function localTables(workItemDir: string): Map<string, KnownTable> {
  const out = new Map<string, KnownTable>();
  const add = (name: string, cols: readonly string[], partial: boolean): void => {
    const key = name.toLowerCase();
    const cur = out.get(key) ?? { columns: new Set<string>(), partial: false };
    cols.forEach((c) => cur.columns.add(c.toLowerCase()));
    out.set(key, { columns: cur.columns, partial: cur.partial || partial });
  };
  for (const f of schemaDocFiles(workItemDir)) {
    try {
      for (const s of tableSections(readFileSync(path.join(workItemDir, TABLE_SCHEMA_DIR, f), "utf-8"))) add(s.table, listedColumns(s.body), false);
    } catch {
      // 讀不了的文件略過
    }
  }
  try {
    for (const t of parseCreateTables(readFileSync(path.join(workItemDir, DB_SQL_FILE), "utf-8"))) add(t.name, t.columns, false);
  } catch {
    // 沒有 02-db.sql
  }
  return out;
}

/** 既有資料表來源：專案 .sql 腳本掃描，加上 system-er.md「既有資料表」一節（只知道部分欄位）。 */
function existingTables(workItemDir: string, projectDir: string): Map<string, KnownTable> {
  const out = new Map<string, KnownTable>();
  for (const t of scanProjectTables(projectDir)) out.set(t.name.toLowerCase(), { columns: new Set(t.columns.map((c) => c.toLowerCase())), partial: false });
  for (const t of readExistingSection(path.join(workItemDir, TABLE_SCHEMA_DIR, SYSTEM_ER_FILE)) ?? []) {
    const key = t.name.toLowerCase();
    const cur = out.get(key);
    out.set(key, { columns: new Set([...(cur?.columns ?? []), ...t.columns.map((c) => c.toLowerCase())]), partial: true });
  }
  return out;
}

const DB_COLUMN_RE = /^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/;

/** 「對應 DB 欄位」儲存格裡的「表.欄位」；其他寫法（—、無、不涉及、說明文字、三段式）不檢查。 */
export function dbColumnRefs(cell: string): { table: string; column: string; text: string }[] {
  return clean(cell)
    .replace(/[（(][^）)]*[）)]/g, " ")
    .split(/[、,，;；/\s]+/)
    .flatMap((tok) => {
      const m = DB_COLUMN_RE.exec(tok);
      return m ? [{ table: m[1], column: m[2], text: tok }] : [];
    });
}

/**
 * API INPUT 表「對應 DB 欄位」若寫成「表.欄位」，表與欄位必須存在於工作項目的資料表結構文件、02-db.sql 或既有資料表（忽略大小寫完全比對）。
 * 工作項目本身的來源查不到時，才掃描專案目錄的 .sql 腳本與系統 ER 圖的既有資料表。
 */
export function checkInputDbColumns(apis: readonly SdApi[], workItemDir: string, projectDir: string, file: string): string[] {
  const refsByApi = apis.map((api) => {
    const table = api.subsections.input === null ? null : parseTable(api.subsections.input);
    if (table === null || clean(table.header[3] ?? "") !== "對應 DB 欄位") return { api, items: [] as { row: number; name: string; ref: ReturnType<typeof dbColumnRefs>[number] }[] };
    const items = table.rows.flatMap((r, i) => dbColumnRefs(r[3] ?? "").map((ref) => ({ row: i + 1, name: clean(r[0] ?? ""), ref })));
    return { api, items };
  });
  if (refsByApi.every((x) => x.items.length === 0)) return [];
  const local = localTables(workItemDir);
  let existing: Map<string, KnownTable> | undefined;
  const lookupExisting = (): Map<string, KnownTable> => (existing ??= existingTables(workItemDir, projectDir));
  const out: string[] = [];
  for (const { api, items } of refsByApi) {
    for (const { row, name, ref } of items) {
      const w = `${file} API「${api.title}」INPUT 第 ${row} 列（${name || "ElementName 空白"}）的對應 DB 欄位「${ref.text}」`;
      const t = ref.table.toLowerCase();
      const c = ref.column.toLowerCase();
      const sources = [local.get(t), lookupExisting().get(t)].filter((x): x is KnownTable => x !== undefined);
      if (sources.length === 0) {
        out.push(`${w}：資料表 ${ref.table} 不存在於 ${TABLE_SCHEMA_DIR}/ 文件、${DB_SQL_FILE} 或既有資料表；請改成真的存在的「表.欄位」，沒有對應的 DB 欄位就寫「—」`);
      } else if (!sources.some((s) => s.columns.has(c)) && !sources.some((s) => s.partial)) {
        const known = [...new Set(sources.flatMap((s) => [...s.columns]))].slice(0, 12).join("、");
        out.push(`${w}：資料表 ${ref.table} 沒有欄位 ${ref.column}${known ? `（已知欄位：${known}）` : ""}；請更正欄位名稱，或在 ${TABLE_SCHEMA_DIR}/ 對應文件的欄位清單補上`);
      }
    }
  }
  return out;
}
