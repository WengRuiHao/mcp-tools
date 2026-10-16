/**
 * 刪除 SVN 上的單一檔案（在遠端直接 `svn delete <網址>` 並 commit，不需要工作副本）。
 *
 * **刻意不註冊成 MCP 工具**——跟 remote-edit-client 一樣只給 svn-edit 的網頁按鈕呼叫，AI 維持唯讀。
 *
 * 安全邊界：
 * - 只能刪「單一檔案」（資料夾一律拒絕），路徑檢查跟編輯共用（拒絕 `..`、完整網址、Windows 不允許的字元）；
 * - commit 訊息一定要填；
 * - 檔案正在被編輯（有未結束的編輯項目）、或被鎖定時拒絕；
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

export interface DeleteResult {
  /** 刪除所產生的新版本號；讀不出來是 null。 */
  deletedRevision: number | null;
  /** 被刪除的遠端路徑（相對於連線根目錄）。 */
  path: string;
  /** 「同步本地端」的結果；開關關閉時沒有這個欄位。 */
  localSync?: LocalSyncResult;
}

export interface DeleteParams {
  connectionId?: string;
  path: unknown;
  message: unknown;
}

/** commit 訊息用 UTF-8 暫存檔 + -F 傳給 svn（Windows 命令列傳中文會被轉成系統字碼頁，svn 會報訊息不是 UTF-8）。 */
async function deleteUrlWithMessage(conn: SvnConnection, fileUrl: string, message: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "svn-mcp-msg-"));
  try {
    const messageFile = path.join(dir, "message.txt");
    await writeFile(messageFile, message, "utf-8");
    const { stdout } = await runSvn(["delete", "--encoding", "UTF-8", "-F", messageFile, pegUrl(fileUrl)], conn, longTimeout());
    return stdout.toString("utf-8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function deleteRemoteFile(params: DeleteParams): Promise<DeleteResult & { conn: SvnConnection }> {
  const message = typeof params.message === "string" ? params.message.trim() : "";
  if (!message) throw new EditError("INVALID_INPUT", "刪除說明（commit 訊息）不能是空的");
  if (message.length > MAX_COMMIT_MESSAGE_LENGTH) throw new EditError("INVALID_INPUT", `刪除說明太長（上限 ${MAX_COMMIT_MESSAGE_LENGTH} 字）`);

  const rawPath = typeof params.path === "string" ? params.path.replace(/\\/g, "/") : "";
  const ext = path.posix.extname(rawPath).slice(1).toLowerCase();
  const { subPath } = normalizeRemotePath(params.path, new Set([ext]), "刪除", true);
  const conn = await resolveConn(params.connectionId);
  const fileUrl = buildFullUrl(conn.url, subPath);

  try {
    const editing = (await listEdits()).find((s) => s.connectionId === conn.id && s.path.toLowerCase() === subPath.toLowerCase());
    if (editing) throw new EditError("ALREADY_EDITING", `這個檔案正在編輯中（${editing.id}），請先上傳或放棄後再刪除。`);

    const info = await remoteInfo(conn, fileUrl);
    if (info.kind !== "file") throw new EditError("INVALID_INPUT", `「${subPath}」不是檔案，只能刪除單一檔案（不能刪資料夾）。`);
    if (info.lockOwner) {
      const who = info.lockOwner === conn.username ? `你自己的帳號（${conn.username}）` : `「${info.lockOwner}」`;
      throw new EditError("FILE_LOCKED", `這個檔案被${who}鎖定中，請先解除鎖定（或等對方上傳／解鎖）後再刪除。`);
    }

    const stdout = await deleteUrlWithMessage(conn, fileUrl, message);
    const revision = /revision (\d+)/i.exec(stdout)?.[1];
    const deletedRevision = revision ? Number(revision) : null;
    await audit({ op: "delete", connection: conn.name, path: subPath, deletedRevision, ok: true, ...describeMessage(message) });
    return { deletedRevision, path: subPath, conn };
  } catch (e) {
    await audit({ op: "delete", connection: conn.name, path: subPath, ok: false, error: e instanceof Error ? e.message : String(e), ...describeMessage(message) });
    throw e;
  }
}

/** 刪除遠端檔案，成功後依開關同步本地端（更新該檔案所在的資料夾，讓本地的檔案跟著消失）。 */
export async function deleteRemoteFileAndSync(params: DeleteParams): Promise<DeleteResult> {
  const { conn, ...result } = await deleteRemoteFile(params);
  const localSync = await syncLocalAfterChange(conn, result.path, "parent");
  return localSync ? { ...result, localSync } : result;
}
