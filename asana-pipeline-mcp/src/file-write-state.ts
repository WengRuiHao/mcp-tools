import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { getFileWriteStateFile, getConflictBackupsDir } from "./config-store.js";
import { readJsonFile, updateJsonFile } from "./atomic-store.js";

export interface FileWriteRecord {
  hash: string;
  writtenAt: string;
  writtenByTaskGid: string | null;
}

/** Formats the current local time as "yyyy-MM-dd HH:mm:ss" (24-hour). */
function nowIso(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 短雜湊（前 16 碼 sha256 hex），只用來比對內容有沒有真的變過，不需要密碼學強度。 */
export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex").slice(0, 16);
}

/** Windows 路徑不分大小寫，同一個檔案可能被不同呼叫用不同大小寫的路徑指到——正規化成小寫再當 key，避免同一個檔案在這份 state 裡分裂成兩筆互不相認的紀錄。 */
function normalizeKey(absPath: string): string {
  return path.resolve(absPath).toLowerCase();
}

/** 查這個絕對路徑上次是不是這個 MCP 自己寫的、寫的時候內容雜湊是多少。沒有記錄代表這個 MCP 從沒寫過這個檔案（或還沒升級到這個機制之前寫的）。 */
export async function getWriteRecord(absPath: string): Promise<FileWriteRecord | null> {
  const state = await readJsonFile<Record<string, FileWriteRecord>>(getFileWriteStateFile(), {});
  return state[normalizeKey(absPath)] ?? null;
}

/** write_project_file 實際寫入成功後呼叫，記錄「這個 MCP 剛剛寫入的內容雜湊是多少」，供下次讀寫這個檔案時比對有沒有被外部動過手。 */
export async function recordFileWrite(absPath: string, content: string, taskGid: string | null): Promise<void> {
  const key = normalizeKey(absPath);
  const record: FileWriteRecord = { hash: hashContent(content), writtenAt: nowIso(), writtenByTaskGid: taskGid };
  await updateJsonFile<Record<string, FileWriteRecord>>(getFileWriteStateFile(), {}, (state) => ({ ...state, [key]: record }));
}

function sanitizePathForDirName(absPath: string): string {
  return hashContent(normalizeKey(absPath));
}

/**
 * 偵測到外部修改、即將被覆蓋掉的磁碟內容，備份到這個 MCP 自己的 data 目錄底下（不是專案目錄），
 * 確保不會被誤 commit 進使用者專案的 git 版控。回傳備份檔案的絕對路徑，供錯誤訊息/覆蓋確認提示使用者去哪裡找。
 */
export async function backupConflictingContent(absPath: string, currentContent: string): Promise<string> {
  const dir = path.join(getConflictBackupsDir(), sanitizePathForDirName(absPath));
  await mkdir(dir, { recursive: true });
  const stamp = nowIso().replace(/[: ]/g, "-");
  const backupPath = path.join(dir, `${stamp}.bak`);
  const manifestPath = path.join(dir, `${stamp}.meta.json`);
  await writeFile(backupPath, currentContent, "utf-8");
  await writeFile(manifestPath, JSON.stringify({ originalPath: absPath, backedUpAt: stamp }, null, 2), "utf-8");
  return backupPath;
}
