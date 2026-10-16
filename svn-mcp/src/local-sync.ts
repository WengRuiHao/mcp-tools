/**
 * 「同步本地端」：遠端編輯上傳（commit）或刪除成功之後，自動對使用者本機的 SVN 工作目錄做 svn update，
 * 讓本地端的檔案跟遠端一致。開關與每個專案的本地目錄存在偏好設定裡（prefs.syncLocal、prefs.localPaths）。
 *
 * 原則：
 * - 遠端的 commit／刪除已經成功了，同步只是事後補做——同步失敗**絕不能**讓上傳看起來失敗，一律回傳 warning／failed 讓畫面提示；
 * - 開關關閉時完全不碰本機（回傳 null），行為跟沒有這個功能時一樣；
 * - 更新前先檢查本地目錄真的是這個專案的 SVN 工作目錄（有被 SVN 追蹤、而且包含要更新的位置），不是就不更新並警示，
 *   不會對一個無關的資料夾亂跑 svn update；
 * - 只更新「這次動到的檔案（或它所在的資料夾）」，不會把整個專案拉下來。
 */
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { getSvnTimeoutMs } from "./config-store.js";
import { commitEdit, getEditStatus, longTimeout, resolveConn, type EditCommitResult, type UpgradeOptions } from "./remote-edit-client.js";
import { readRepoPrefs } from "./repo-prefs.js";
import { buildFullUrl, runSvn, type SvnConnection } from "./svn-client.js";
import { pegSafe, withWcLock } from "./workcopy-client.js";

export type LocalSyncStatus = "updated" | "warning" | "failed";

export interface LocalSyncResult {
  status: LocalSyncStatus;
  /** 給使用者看的說明（繁體中文）。warning／failed 時畫面會跳出警示。 */
  message: string;
  /** 實際更新的本地路徑（沒有更新就沒有）。 */
  localPath?: string;
}

/** file＝更新這個檔案本身（本地沒有也會取回）；parent＝更新它所在的資料夾（刪除檔案、升級版本時用，讓檔案消失／出現）。 */
export type LocalSyncScope = "file" | "parent";

const NEWLINE = String.fromCharCode(10);
const NOT_A_WORKING_COPY = /E155007|not a working copy/i;

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** 取網址的路徑部分（解碼、去尾端斜線、不分大小寫）：本機用 IP 或別的主機名稱 checkout 時，仍能對得上同一個專案。 */
function urlPathOf(url: string): string {
  let pathname = url;
  try {
    pathname = new URL(url).pathname;
  } catch {
    // file:// 之類解析不了的網址就整串比對
  }
  return decode(pathname).replace(/\/+$/, "").toLowerCase();
}

function warn(message: string, localPath?: string): LocalSyncResult {
  return { status: "warning", message, ...(localPath ? { localPath } : {}) };
}

/** 回傳工作目錄根的 URL；不是工作目錄回傳 null；其他錯誤（需要升級、被鎖住…）往外丟。 */
async function workCopyUrl(conn: SvnConnection, dir: string): Promise<string | null> {
  try {
    const { stdout } = await runSvn(["info", "--show-item", "url", pegSafe(dir)], conn, getSvnTimeoutMs());
    return stdout.toString("utf-8").trim();
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    if (NOT_A_WORKING_COPY.test(text)) return null;
    throw e;
  }
}

function summarizeUpdate(output: string, localPath: string): LocalSyncResult {
  const revision = /(?:Updated to|At) revision (\d+)/i.exec(output)?.[1];
  const conflicted = /Summary of conflicts:|^\s*C\s{2,}\S/m.test(output) || /Skipped .* -- (?:Node remains in conflict|.*conflict)/i.test(output);
  if (conflicted) {
    return warn(`已更新本地目錄，但有檔案發生衝突（通常是你本機的同一個檔案也有修改）：${localPath}。請用 TortoiseSVN 開啟該資料夾，右鍵「解決衝突」。`, localPath);
  }
  return { status: "updated", message: `已同步本地端${revision ? `（r${revision}）` : ""}：${localPath}`, localPath };
}

interface RootCheck {
  dir: string;
  kind: "missing" | "notwc" | "mismatch" | "match";
  /** 工作目錄對應的 SVN 網址（有追蹤才有）。 */
  url?: string;
  /** 工作目錄對應的 SVN 路徑（比對用，已解碼、小寫）。 */
  urlPath?: string;
}

/** 檢查一個本地目錄：存在嗎、有 SVN 追蹤嗎、對應的 SVN 位置包不包含這個檔案。 */
async function checkRoot(conn: SvnConnection, dir: string, filePath: string): Promise<RootCheck> {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return { dir, kind: "missing" };
  const url = await workCopyUrl(conn, dir);
  if (url === null) return { dir, kind: "notwc" };
  const urlPath = urlPathOf(url);
  const inside = filePath === urlPath || filePath.startsWith(`${urlPath}/`);
  return { dir, kind: inside ? "match" : "mismatch", url, urlPath };
}

/** 一個目錄都沒辦法更新時，告訴使用者為什麼。只設定一個目錄時說得最具體；有多個時逐一列出。 */
function explainNoMatch(conn: SvnConnection, remotePath: string, checks: RootCheck[]): LocalSyncResult {
  const text = (check: RootCheck): string => {
    if (check.kind === "missing") return `專案「${conn.name}」設定的本地目錄不存在：${check.dir}，所以沒有更新本地端。請到「管理連線」確認路徑。`;
    if (check.kind === "notwc") return `本地目錄「${check.dir}」沒有 SVN 追蹤（不是 SVN 工作目錄，找不到 .svn），所以沒有更新。請先用 TortoiseSVN 或「瀏覽 SVN 目錄」的「Checkout 到本地」建立追蹤，或到「管理連線」改成正確的目錄。`;
    return `本地目錄「${check.dir}」對應的 SVN 位置（${check.url}）不包含這個檔案（${remotePath}），所以沒有更新。請確認這個目錄是不是專案「${conn.name}」的工作目錄。`;
  };
  if (checks.length === 1) return warn(text(checks[0]), checks[0].kind === "missing" ? undefined : checks[0].dir);
  const lines = checks.map((check) => `• ${check.dir}：${check.kind === "missing" ? "目錄不存在" : check.kind === "notwc" ? "沒有 SVN 追蹤" : "對應的 SVN 位置不包含這個檔案"}`);
  return warn(`專案「${conn.name}」設定的 ${checks.length} 個本地目錄，沒有一個能更新這個檔案（${remotePath}），所以沒有更新本地端：${NEWLINE}${lines.join(NEWLINE)}`);
}

/**
 * 開關開啟時，把本地工作目錄更新到跟遠端一致；開關關閉回傳 null。**不會丟錯誤**。
 * `remotePath` 是這次動到的遠端檔案路徑（相對於連線根目錄）。專案設定了多個本地目錄時，
 * 挑「對應的 SVN 位置包含這個檔案、而且最深的那一個」來更新。
 */
export async function syncLocalAfterChange(conn: SvnConnection, remotePath: string, scope: LocalSyncScope): Promise<LocalSyncResult | null> {
  try {
    const prefs = await readRepoPrefs();
    if (!prefs.syncLocal) return null;

    const roots = prefs.localPaths[conn.name] ?? [];
    if (roots.length === 0) {
      return warn(`已開啟「同步本地端」，但專案「${conn.name}」還沒設定本地目錄，所以沒有更新本地端。請到「管理連線」設定這個專案的本地目錄。`);
    }

    const filePath = urlPathOf(buildFullUrl(conn.url, remotePath));
    const checks: RootCheck[] = [];
    for (const dir of roots) checks.push(await checkRoot(conn, dir, filePath));
    const matches = checks.filter((check) => check.kind === "match").sort((a, b) => (b.urlPath?.length ?? 0) - (a.urlPath?.length ?? 0));
    if (matches.length === 0) return explainNoMatch(conn, remotePath, checks);

    const best = matches[0];
    const relative = filePath.slice((best.urlPath ?? "").length).split("/").filter(Boolean);
    const fileLocal = path.join(best.dir, ...relative);
    const target = scope === "parent" ? path.dirname(fileLocal) : fileLocal;
    const inside = path.relative(best.dir, target);
    if (inside.startsWith("..") || path.isAbsolute(inside)) {
      return warn(`要更新的位置不在本地目錄「${best.dir}」之內，已略過。`, best.dir);
    }
    if (scope === "parent" && !existsSync(target)) {
      return { status: "updated", message: `本地端沒有這個位置（${target}），不需要更新。`, localPath: target };
    }

    const args = ["update", ...(existsSync(target) ? [] : ["--parents"]), pegSafe(target)];
    const stdout = await withWcLock(best.dir, async () => (await runSvn(args, conn, longTimeout())).stdout.toString("utf-8"));
    return summarizeUpdate(stdout, target);
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    return { status: "failed", message: `遠端已經完成，但更新本地端失敗：${text}` };
  }
}

export interface SyncedCommitResult extends EditCommitResult {
  /** 「同步本地端」的結果；開關關閉時沒有這個欄位。 */
  localSync?: LocalSyncResult;
}

/** 上傳（commit）編輯結果，成功之後依開關同步本地端。commit 失敗照常丟錯誤，不會進到同步。 */
export async function commitEditAndSync(id: string, message: string, upgrade?: UpgradeOptions | boolean): Promise<SyncedCommitResult> {
  const { session } = await getEditStatus(id);
  const result = await commitEdit(id, message, upgrade);
  const conn = await resolveConn(session.connectionId).catch(() => null);
  if (!conn) return result;
  const localSync = await syncLocalAfterChange(conn, result.path, result.upgrade ? "parent" : "file");
  return localSync ? { ...result, localSync } : result;
}
