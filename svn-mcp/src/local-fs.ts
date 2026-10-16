/**
 * 本機資料夾瀏覽與檢查：給控制頁的「選擇本地資料夾」用（點選一層一層找，不用複製貼上路徑）。
 *
 * - 只列「資料夾」（不列檔案），也不會寫入或刪除任何東西；
 * - 每個資料夾標出是不是 SVN 工作目錄（資料夾裡有 `.svn`），讓使用者不容易選錯；
 * - svn-edit 只綁 127.0.0.1，而且所有 /api/* 都要 token，所以只有這台電腦上開著控制頁的人看得到這份清單。
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { getSvnTimeoutMs } from "./config-store.js";
import { EditError } from "./remote-edit-client.js";

export const MAX_LOCAL_ENTRIES = 500;
/** 不是使用者的資料夾、列出來只會造成混亂的系統資料夾。 */
const HIDDEN_NAMES: ReadonlySet<string> = new Set([".svn", "$recycle.bin", "system volume information", "$winreagent", "recovery"]);

export interface LocalDirEntry {
  name: string;
  /** 完整路徑（一律用 `/` 分隔）。 */
  path: string;
  /** 這個資料夾本身就是 SVN 工作目錄（裡面有 .svn）。 */
  isWc: boolean;
}

export interface LocalListing {
  /** 目前列的是哪個資料夾；空字串代表「本機」（磁碟機清單）。 */
  path: string;
  /** 上一層；已經在磁碟機根目錄時是空字串（回到磁碟機清單）；在「本機」時是 null。 */
  parent: string | null;
  /** 目前這個資料夾在 SVN 工作目錄裡面（它自己或上層有 .svn）。 */
  inWc: boolean;
  entries: LocalDirEntry[];
  truncated: boolean;
}

function slash(p: string): string {
  return p.split(path.sep).join("/");
}

/** 這個資料夾自己有 .svn 嗎。 */
export function hasSvnMetadata(dir: string): boolean {
  return existsSync(path.join(dir, ".svn"));
}

/** 這個資料夾或它的任何一層上層是 SVN 工作目錄。 */
export function isInsideWorkCopy(dir: string): boolean {
  let current = path.resolve(dir);
  for (;;) {
    if (hasSvnMetadata(current)) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function listDrives(): LocalListing {
  if (process.platform !== "win32") return listDirectory("/");
  const entries: LocalDirEntry[] = [];
  for (let code = 65; code <= 90; code++) {
    const letter = String.fromCharCode(code);
    if (existsSync(`${letter}:/`)) entries.push({ name: `${letter}:`, path: `${letter}:/`, isWc: false });
  }
  return { path: "", parent: null, inWc: false, entries, truncated: false };
}

function listDirectory(raw: string): LocalListing {
  const dir = path.resolve(raw);
  let stat;
  try {
    stat = statSync(dir);
  } catch {
    throw new EditError("NOT_FOUND", `找不到這個資料夾：${raw}`);
  }
  if (!stat.isDirectory()) throw new EditError("INVALID_INPUT", `這不是資料夾：${raw}`);

  const entries: LocalDirEntry[] = [];
  let truncated = false;
  let dirents;
  try {
    dirents = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    throw new EditError("INVALID_INPUT", `讀不到這個資料夾的內容（可能沒有權限）：${e instanceof Error ? e.message : String(e)}`);
  }
  const folders = dirents.filter((d) => d.isDirectory() && !HIDDEN_NAMES.has(d.name.toLowerCase())).sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
  for (const folder of folders) {
    if (entries.length >= MAX_LOCAL_ENTRIES) {
      truncated = true;
      break;
    }
    const full = path.join(dir, folder.name);
    entries.push({ name: folder.name, path: slash(full), isWc: hasSvnMetadata(full) });
  }

  const parentDir = path.dirname(dir);
  return { path: slash(dir), parent: parentDir === dir ? "" : slash(parentDir), inWc: isInsideWorkCopy(dir), entries, truncated };
}

/** 列出一個本機資料夾底下的子資料夾；`raw` 為空字串時列出磁碟機。 */
export function listLocalDirs(raw: unknown): LocalListing {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text === "") return listDrives();
  if (!path.isAbsolute(text)) throw new EditError("INVALID_INPUT", `必須是完整路徑：${text}`);
  return listDirectory(text);
}

export interface LocalInspect {
  path: string;
  exists: boolean;
  /** 是 SVN 工作目錄（讀得出對應的網址）。 */
  isWc: boolean;
  /** 工作目錄對應的 SVN 網址。 */
  url: string | null;
  /** 資料夾裡面有東西（Checkout 不能放進有內容的資料夾）。 */
  nonEmpty: boolean;
  /** 這個位置在 SVN 工作目錄裡面（自己或上層有 .svn；不存在的路徑看它存在的最近一層上層）。 */
  inWc: boolean;
}

/** 讀出一個工作目錄對應的 SVN 網址；不是工作目錄或讀不出來回傳 null（不需要帳密，只讀本機）。 */
export function workCopyUrlOf(dir: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("svn", ["info", "--show-item", "url", "--non-interactive", dir.includes("@") ? `${dir}@` : dir], { timeout: getSvnTimeoutMs(), windowsHide: true }, (error, stdout) => {
      resolve(error ? null : String(stdout).trim() || null);
    });
  });
}

export const MAX_INSPECT_PATHS = 50;

/** 檢查一批本地目錄的狀態（管理連線畫面列出每個目錄有沒有 SVN 追蹤、對應哪個遠端位置）。 */
export async function inspectLocalDirs(paths: unknown): Promise<LocalInspect[]> {
  if (!Array.isArray(paths)) throw new EditError("INVALID_INPUT", "paths 必須是清單");
  const results: LocalInspect[] = [];
  for (const item of paths.slice(0, MAX_INSPECT_PATHS)) {
    const dir = typeof item === "string" ? item : "";
    const exists = !!dir && path.isAbsolute(dir) && existsSync(dir) && statSync(dir).isDirectory();
    const url = exists ? await workCopyUrlOf(dir) : null;
    const nonEmpty = exists && readdirSync(dir).length > 0;
    results.push({ path: dir, exists, isWc: url !== null, url, nonEmpty, inWc: !!dir && path.isAbsolute(dir) && isInsideWorkCopy(dir) });
  }
  return results;
}
