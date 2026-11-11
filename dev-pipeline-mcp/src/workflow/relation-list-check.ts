// 資料表結構文件的「## 關聯清單」檢查：表頭固定「子表｜子表欄位｜父表｜父表欄位｜關係｜依據」。
// 依據只能是「外鍵約束」或「邏輯關聯」：
//  - 外鍵約束：SQL 內每個外鍵都必須列出、列出的也必須對得上 SQL（含關係種類）；
//  - 邏輯關聯：程式無法驗證真偽，只檢查格式與表、欄位存在；真偽由規格驗證師對照程式碼確認（檢查結果會列出邏輯關聯清單供參照）。
// 關係種類由 SQL 判定：外鍵欄位組恰為 UNIQUE（欄位或單欄約束）或主鍵＝一對一，否則一對多；外鍵欄位全為 NOT NULL（或主鍵）＝必選，否則可選。
import { parseTable } from "./md-table.js";
import type { SqlForeignKey, SqlTable } from "./sql-schema-parse.js";
import { extractSection } from "./reuse-record-check.js";

export const RELATION_HEADING = "關聯清單";
export const RELATION_HEADER: readonly string[] = ["子表", "子表欄位", "父表", "父表欄位", "關係", "依據"];
export const BASIS_FK = "外鍵約束";
export const BASIS_LOGICAL = "邏輯關聯";
export const RELATION_BASES: readonly string[] = [BASIS_FK, BASIS_LOGICAL];
export const KIND_MANY = "一對多";
export const KIND_ONE = "一對一";
export const RELATION_KINDS: readonly string[] = [KIND_MANY, KIND_ONE];

export interface Relation {
  child: string;
  childCols: string[];
  parent: string;
  parentCols: string[];
  kind: string;
  basis: string;
}
/** 表查詢：回傳欄位與主鍵；查不到回 undefined。 */
export type TableLookup = (name: string) => { columns: readonly string[]; primaryKey: readonly string[] } | undefined;

const clean = (c: string): string => c.replace(/[`*]/g, "").trim();
const cols = (c: string): string[] => clean(c).split(/[、,，\s]+/).filter(Boolean);
const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x) => b.some((y) => y.toLowerCase() === x.toLowerCase()));

/** 外鍵判定的關係種類。 */
export function kindOfForeignKey(t: SqlTable, fk: SqlForeignKey): string {
  return sameSet(t.primaryKey, fk.columns) || t.uniques.some((u) => sameSet(u, fk.columns)) ? KIND_ONE : KIND_MANY;
}

/** 外鍵欄位全為 NOT NULL（或屬於主鍵）＝必選關聯。 */
export const isRequired = (t: SqlTable, columns: readonly string[]): boolean => columns.every((c) => [...t.notNull, ...t.primaryKey].some((n) => n.toLowerCase() === c.toLowerCase()));

/** 解析文件「關聯清單」的資料列；缺章節或表頭不符回 null。 */
export function parseRelations(text: string): Relation[] | null {
  const body = extractSection(text, RELATION_HEADING);
  const table = body === null ? null : parseTable(body);
  if (table === null || table.header.length !== RELATION_HEADER.length || table.header.some((h, i) => clean(h) !== RELATION_HEADER[i])) return null;
  return table.rows.map((r) => ({ child: clean(r[0] ?? ""), childCols: cols(r[1] ?? ""), parent: clean(r[2] ?? ""), parentCols: cols(r[3] ?? ""), kind: clean(r[4] ?? ""), basis: clean(r[5] ?? "") }));
}

const rowText = (r: Relation): string => `${r.child}.${r.childCols.join("、")} → ${r.parent}.${r.parentCols.join("、")}`;
const hasCols = (info: { columns: readonly string[] } | undefined, wanted: readonly string[]): string[] => (info ? wanted.filter((c) => !info.columns.some((x) => x.toLowerCase() === c.toLowerCase())) : []);

function checkRow(r: Relation, where: string, docTables: readonly string[], sql: readonly SqlTable[], lookup: TableLookup): string[] {
  const out: string[] = [];
  const w = `${where}「${RELATION_HEADING}」${rowText(r)}`;
  if (!docTables.includes(r.child)) out.push(`${w} 的子表 ${r.child} 不在本文件內（關聯清單只列子表屬於本文件的關聯）`);
  if (!RELATION_KINDS.includes(r.kind)) out.push(`${w} 的關係「${r.kind}」不合法（只能是：${RELATION_KINDS.join("、")}）`);
  if (!RELATION_BASES.includes(r.basis)) out.push(`${w} 的依據「${r.basis}」不合法（只能是：${RELATION_BASES.join("、")}）`);
  if (r.childCols.length === 0 || r.parentCols.length === 0) out.push(`${w} 的子表欄位與父表欄位都要填`);
  const [child, parent] = [lookup(r.child), lookup(r.parent)];
  if (!parent) out.push(`${w} 的父表 ${r.parent} 不存在（不在 02-db.sql，也不是既有資料表）`);
  const [badChild, badParent] = [hasCols(child, r.childCols), hasCols(parent, r.parentCols)];
  if (badChild.length > 0) out.push(`${w} 的子表欄位 ${badChild.join("、")} 不存在於 ${r.child}`);
  if (badParent.length > 0) out.push(`${w} 的父表欄位 ${badParent.join("、")} 不存在於 ${r.parent}`);
  const t = sql.find((x) => x.name === r.child);
  if (r.basis === BASIS_FK && t) {
    const fk = t.foreignKeys.find((f) => sameSet(f.columns, r.childCols) && f.parentTable === r.parent);
    if (!fk) out.push(`${w} 標示為外鍵約束，但 02-db.sql 沒有這個外鍵（沒有外鍵約束的關聯請標「${BASIS_LOGICAL}」）`);
    else if (RELATION_KINDS.includes(r.kind) && r.kind !== kindOfForeignKey(t, fk)) out.push(`${w} 的關係應為「${kindOfForeignKey(t, fk)}」（外鍵欄位${kindOfForeignKey(t, fk) === KIND_ONE ? "是 UNIQUE 或主鍵" : "不是 UNIQUE"}）`);
  }
  return out;
}

/** 檢查一份文件的關聯清單；docTables 為文件內的表。回傳違規、關聯（供連通與 ER 圖比對）。 */
export function checkRelationList(text: string, where: string, docTables: readonly string[], sql: readonly SqlTable[], lookup: TableLookup): { problems: string[]; relations: Relation[] } {
  const relations = parseRelations(text);
  if (relations === null) return { problems: [`${where} 缺少「## ${RELATION_HEADING}」表格（表頭固定為：${RELATION_HEADER.join("｜")}；沒有任何關聯也要保留表頭）`], relations: [] };
  const problems = relations.flatMap((r) => checkRow(r, where, docTables, sql, lookup));
  for (const t of sql.filter((x) => docTables.includes(x.name))) {
    for (const fk of t.foreignKeys) {
      const listed = relations.some((r) => r.basis === BASIS_FK && r.child === t.name && r.parent === fk.parentTable && sameSet(r.childCols, fk.columns));
      if (!listed) problems.push(`${where}「${RELATION_HEADING}」缺少外鍵 ${t.name}.${fk.columns.join("、")} → ${fk.parentTable}（SQL 內每個外鍵都要列出，依據填「${BASIS_FK}」）`);
    }
  }
  return { problems, relations };
}
