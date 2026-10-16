/**
 * 刪除 SVN 上的檔案或資料夾（可一次刪多個）：在遠端直接 `svn delete <網址…>` 並 commit，不需要工作副本。
 *
 * **刻意不註冊成 MCP 工具**——跟 remote-edit-client 一樣只給 svn-edit 的網頁按鈕呼叫，AI 維持唯讀。
 *
 * 安全邊界：
 * - 檔案與資料夾都能刪（資料夾連同底下所有內容一起刪）；路徑檢查跟編輯共用（拒絕 `..`、完整網址、Windows 不允許的字元）；
 * - commit 訊息一定要填；一次最多 MAX_DELETE_BATCH 個；
 * - 全有或全無：每個項目都先檢查過（存在、沒在編輯（資料夾底下有編輯中的檔案也算）、檔案沒被鎖定），任何一個不符就整批拒絕、什麼都不刪；
 *   通過後用「一個 svn delete 指令」送出，只會產生一個 revision；
 * - SVN 刪除是一個新的 revision，歷史裡還找得回來；
 * - 成功之後依「同步本地端」開關更新本地工作目錄（失敗只提示，不影響刪除結果）；
 * - 每次刪除都寫一行稽核紀錄。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { syncLocalAfterChange, type LocalSyncResult } from "./local-sync.js";
import { audit, describeMessage, EditError, listEdits, longTimeout, MAX_COMMIT_MESSAGE_LENGTH, normalizeRemotePath, pegUrl, remoteInfo, resolveConn } from "./remote-edit-client.js";
import { buildFullUrl, runSvn, type SvnConnection } from "./svn-client.js";

export const MAX_DELETE_BATCH = 100;

export interface DeleteResult {
  /** 刪除所產生的新版本號；讀不出來是 null。 */
  deletedRevision: number | null;
  /** 被刪除的遠端路徑（相對於連線根目錄）。 */
  paths: string[];
  /** 第一個被刪除的路徑（單檔刪除時就是那個檔案）。 */
  path: string;
  /** 「同步本地端」的結果；開關關閉時沒有這個欄位。 */
  localSync?: LocalSyncResult;
}

export interface DeleteParams {
  connectionId?: string;
  /** 單一檔案路徑（跟 paths 擇一）。 */
  path?: unknown;
  /** 要刪除的檔案路徑清單。 */
  paths?: unknown;
  message: unknown;
}

/** commit 訊息用 UTF-8 暫存檔 + -F 傳給 svn（Windows 命令列傳中文會被轉成系統字碼頁，svn 會報訊息不是 UTF-8）。 */
async function deleteUrlsWithMessage(conn: SvnConnection, fileUrls: string[], message: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "svn-mcp-msg-"));
  try {
    const messageFile = path.join(dir, "message.txt");
    await writeFile(messageFile, message, "utf-8");
    const { stdout } = await runSvn(["delete", "--encoding", "UTF-8", "-F", messageFile, ...fileUrls.map(pegUrl)], conn, longTimeout());
    return stdout.toString("utf-8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 整理要刪的路徑清單：去重（不分大小寫）、檢查格式與數量。 */
function normalizePaths(params: DeleteParams): string[] {
  const raw = Array.isArray(params.paths) ? params.paths : [params.path];
  if (raw.length === 0 || raw.every((p) => typeof p !== "string" || p.trim() === "")) throw new EditError("INVALID_INPUT", "請選擇要刪除的檔案");
  if (raw.length > MAX_DELETE_BATCH) throw new EditError("INVALID_INPUT", `一次最多刪除 ${MAX_DELETE_BATCH} 個檔案`);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of raw) {
    const rawPath = typeof item === "string" ? item.replace(/\\/g, "/") : "";
    const ext = path.posix.extname(rawPath).slice(1).toLowerCase();
    const { subPath } = normalizeRemotePath(item, new Set([ext]), "刪除", true);
    if (!seen.has(subPath.toLowerCase())) {
      seen.add(subPath.toLowerCase());
      result.push(subPath);
    }
  }
  return result.filter((p) => !result.some((other) => other !== p && p.toLowerCase().startsWith(`${other.toLowerCase()}/`)));
}

async function assertDeletable(conn: SvnConnection, subPath: string, editingPaths: Set<string>): Promise<void> {
  const lower = subPath.toLowerCase();
  for (const editing of editingPaths) {
    if (editing === lower) throw new EditError("ALREADY_EDITING", `「${subPath}」正在編輯中，請先上傳或放棄後再刪除。`);
    if (editing.startsWith(`${lower}/`)) throw new EditError("ALREADY_EDITING", `資料夾「${subPath}」底下有檔案正在編輯中（${editing}），請先上傳或放棄後再刪除。`);
  }
  const info = await remoteInfo(conn, buildFullUrl(conn.url, subPath));
  if (info.kind !== "file" && info.kind !== "dir") throw new EditError("INVALID_INPUT", `「${subPath}」不是檔案或資料夾，無法刪除。`);
  if (info.lockOwner) {
    const who = info.lockOwner === conn.username ? `你自己的帳號（${conn.username}）` : `「${info.lockOwner}」`;
    throw new EditError("FILE_LOCKED", `「${subPath}」被${who}鎖定中，請先解除鎖定（或等對方上傳／解鎖）後再刪除。`);
  }
}

export async function deleteRemoteFiles(params: DeleteParams): Promise<DeleteResult & { conn: SvnConnection }> {
  const message = typeof params.message === "string" ? params.message.trim() : "";
  if (!message) throw new EditError("INVALID_INPUT", "刪除說明（commit 訊息）不能是空的");
  if (message.length > MAX_COMMIT_MESSAGE_LENGTH) throw new EditError("INVALID_INPUT", `刪除說明太長（上限 ${MAX_COMMIT_MESSAGE_LENGTH} 字）`);

  const subPaths = normalizePaths(params);
  const conn = await resolveConn(params.connectionId);

  try {
    const editingPaths = new Set((await listEdits()).filter((s) => s.connectionId === conn.id).map((s) => s.path.toLowerCase()));
    for (const subPath of subPaths) await assertDeletable(conn, subPath, editingPaths);

    const stdout = await deleteUrlsWithMessage(conn, subPaths.map((p) => buildFullUrl(conn.url, p)), message);
    const revision = /revision (\d+)/i.exec(stdout)?.[1];
    const deletedRevision = revision ? Number(revision) : null;
    await audit({ op: "delete", connection: conn.name, paths: subPaths, count: subPaths.length, deletedRevision, ok: true, ...describeMessage(message) });
    return { deletedRevision, paths: subPaths, path: subPaths[0], conn };
  } catch (e) {
    await audit({ op: "delete", connection: conn.name, paths: subPaths, count: subPaths.length, ok: false, error: e instanceof Error ? e.message : String(e), ...describeMessage(message) });
    throw e;
  }
}

const SEVERITY: Record<LocalSyncResult["status"], number> = { updated: 0, warning: 1, failed: 2 };

/** 多個資料夾各自同步的結果合併成一個：狀態取最嚴重的；有警示時列出所有不同的說明。 */
function mergeSyncResults(results: LocalSyncResult[]): LocalSyncResult {
  if (results.length === 1) return results[0];
  const status = results.reduce<LocalSyncResult["status"]>((worst, r) => (SEVERITY[r.status] > SEVERITY[worst] ? r.status : worst), "updated");
  if (status === "updated") return { status, message: `已同步本地端（${results.length} 個資料夾）` };
  const problems = [...new Set(results.filter((r) => r.status !== "updated").map((r) => r.message))];
  return { status, message: problems.join("\n") };
}

/** 刪除遠端檔案，成功後依開關同步本地端（更新被刪檔案所在的資料夾，讓本地的檔案跟著消失）。 */
export async function deleteRemoteFileAndSync(params: DeleteParams): Promise<DeleteResult> {
  const { conn, ...result } = await deleteRemoteFiles(params);
  const parents = [...new Map(result.paths.map((p) => [(p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "").toLowerCase(), p])).values()];
  const syncs: LocalSyncResult[] = [];
  for (const remotePath of parents) {
    const sync = await syncLocalAfterChange(conn, remotePath, "parent");
    if (!sync) return result; // 開關關閉
    syncs.push(sync);
  }
  return { ...result, localSync: mergeSyncResults(syncs) };
}
