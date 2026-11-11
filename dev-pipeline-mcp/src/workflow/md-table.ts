// markdown 表格解析的共用函式（各種內容檢查共用）。

export const isSeparator = (cells: readonly string[]): boolean => cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c.trim()));
export const splitRow = (line: string): string[] => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

export interface ParsedTable {
  header: string[];
  /** 分隔列之後的列；全空白列已略過。 */
  rows: string[][];
}

/** 解析內容裡的第一個表格（表頭＋分隔列＋資料列）；沒有表頭加分隔列回 null。 */
export function parseTable(body: string): ParsedTable | null {
  const rows = body.split(/\r\n|\r|\n/).filter((l) => l.trim().startsWith("|")).map(splitRow);
  const sep = rows.findIndex(isSeparator);
  if (sep < 1) return null;
  return { header: rows[sep - 1], rows: rows.slice(sep + 1).filter((r) => r.some((c) => c !== "")) };
}

/** 表格資料列（分隔列之後的列）；沒有表頭加分隔列回 null。 */
export function tableDataRows(body: string): string[][] | null {
  return parseTable(body)?.rows ?? null;
}
