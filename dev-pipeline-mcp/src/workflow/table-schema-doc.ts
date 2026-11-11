// 資料表結構文件（分組格式）的章節解析：一份文件含一張或多張有關聯的表，每張表一個「## 資料表：<表名>」小節。
// 錨點規則：SD 連結 TableSchema/<文件>.md#<表名>，表名對應文件內的「## 資料表：<表名>」小節（不分大小寫）。
import { headingMatches, stripHeadingNumber } from "./heading-match.js";
import { parseTable } from "./md-table.js";
import { extractSection } from "./reuse-record-check.js";
import { listHeadings } from "./sa-image-check.js";

export const TABLE_SECTION_PREFIX = "資料表";
export const INCLUDED_HEADING = "本文件包含的資料表";
export const INCLUDED_HEADER: readonly string[] = ["資料表", "說明"];
const TABLE_TITLE_RE = /^資料表\s*[：:]\s*([^\s<]+)/;

export interface TableSection {
  table: string;
  /** 小節全文（含「## 資料表：」標題行）。 */
  body: string;
}

/** 取出所有「## 資料表：<表名>」小節（依出現順序）。 */
export function tableSections(text: string): TableSection[] {
  const lines = text.split(/\r\n|\r|\n/);
  const heads = listHeadings(text);
  return heads.flatMap((h, i) => {
    const m = h.level === 2 ? TABLE_TITLE_RE.exec(stripHeadingNumber(h.title)) : null;
    if (!m) return [];
    const end = heads.slice(i + 1).find((x) => x.level <= 2);
    return [{ table: m[1], body: lines.slice(h.line - 1, end ? end.line - 1 : lines.length).join("\n") }];
  });
}

/** 文件是否含該表的小節（錨點驗證用，表名不分大小寫）。 */
export const hasTableSection = (text: string, table: string): boolean => tableSections(text).some((s) => s.table.toLowerCase() === table.toLowerCase());

/** 「本文件包含的資料表」清單的表名（依列順序）；缺章節或不是表格回 null。 */
export function includedTables(text: string): string[] | null {
  const body = extractSection(text, INCLUDED_HEADING);
  const table = body === null ? null : parseTable(body);
  return table === null ? null : table.rows.map((r) => (r[0] ?? "").replace(/[`*]/g, "").trim()).filter(Boolean);
}

/** 文件的 mermaid 程式碼區塊（依序）。 */
export function mermaidBlocks(text: string): string[] {
  return [...text.matchAll(/^```mermaid[^\n]*\n([\s\S]*?)^```/gm)].map((m) => m[1]);
}

export { headingMatches };
