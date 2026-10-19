/** 各個模組共用的小工具（沒有任何副作用，也不碰 svn）。 */
import path from "node:path";

/** 錯誤物件轉成給人看的訊息。 */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 路徑統一用 `/` 分隔（Windows 的反斜線轉成正斜線）。 */
export function toSlash(p: string): string {
  return p.split(path.sep).join("/");
}

/** 從 svn 輸出讀出「revision N」的版本號；讀不出來回傳 null。 */
export function parseRevision(output: Buffer | string): number | null {
  const match = /revision (\d+)/i.exec(String(output));
  return match ? Number(match[1]) : null;
}
