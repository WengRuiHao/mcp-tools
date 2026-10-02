import path from "node:path";
import { getSvnWorkCopiesConfigFile } from "./config-store.js";
import { readJsonFile, updateJsonFile } from "./atomic-store.js";

export interface SvnWorkCopyEntry {
  /** 這份工作副本的用途標籤（顯示在報告上，也是網頁按鈕指定操作對象的 key），同一個專案內不可重複。 */
  label: string;
  /** SVN 工作副本的本機絕對路徑。 */
  workCopyPath: string;
  /** svn-mcp 的連線 id 或名稱（帳密只存在 svn-mcp，這裡不碰）。 */
  connectionId: string;
}

function normalizeKey(projectDir: string): string {
  return path.resolve(projectDir).toLowerCase();
}

/** 這個專案目錄登記過的 SVN 工作副本；從未登記回傳 null。 */
export async function resolveSvnWorkCopies(projectDir: string): Promise<SvnWorkCopyEntry[] | null> {
  const config = await readJsonFile<Record<string, SvnWorkCopyEntry[]>>(getSvnWorkCopiesConfigFile(), {});
  return config[normalizeKey(projectDir)] ?? null;
}

/** 整份覆寫這個專案目錄的 SVN 工作副本登記。label 重複會直接拒絕（網頁按鈕靠 label 找操作對象）。 */
export async function registerSvnWorkCopies(projectDir: string, entries: SvnWorkCopyEntry[]): Promise<void> {
  const labels = entries.map((e) => e.label.trim());
  if (labels.some((l) => l === "")) throw new Error("label 不能是空的");
  if (new Set(labels.map((l) => l.toLowerCase())).size !== labels.length) throw new Error("同一個專案內 label 不可重複");
  const value = entries.map((e) => ({
    label: e.label.trim(),
    workCopyPath: path.resolve(e.workCopyPath),
    connectionId: e.connectionId,
  }));
  await updateJsonFile<Record<string, SvnWorkCopyEntry[]>>(getSvnWorkCopiesConfigFile(), {}, (config) => ({
    ...config,
    [normalizeKey(projectDir)]: value,
  }));
}
