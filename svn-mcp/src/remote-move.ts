/**
 * 移動 SVN 上的檔案或資料夾（可一次移多個）到另一個資料夾：在遠端直接 `svn move <網址…> <目標資料夾網址>` 並 commit，不需要工作副本。
 *
 * **刻意不註冊成 MCP 工具**——跟 remote-delete 一樣只給 svn-edit 的網頁按鈕呼叫，AI 維持唯讀。
 *
 * 安全邊界：
 * - 路徑檢查跟刪除共用（拒絕 `..`、完整網址、Windows 不允許的字元）；commit 訊息選填（留空自動補）；一次最多 MAX_MOVE_BATCH 個；
 * - 全有或全無：每個項目都先檢查過（存在、沒在編輯（資料夾底下有編輯中的檔案也算）、沒被鎖定），
 *   目標資料夾要已存在、不能是被移動資料夾本身或它的子孫、目標裡不能已有同名項目（不分大小寫，不會蓋掉別人的檔案）、
 *   項目本來就在目標資料夾也算錯誤；任何一個不符就整批拒絕、什麼都不動；
 *   通過後用「一個 svn move 指令」送出，只會產生一個 revision，歷史紀錄保留；
 * - 成功之後依「同步本地端」開關更新本地工作目錄（失敗只提示，不影響移動結果）；
 * - 每次移動都寫一行稽核紀錄。
 */
import { syncLocalAfterChange, type LocalSyncResult } from "./local-sync.js";
import { mergeSyncResults } from "./remote-delete.js";
import {
  audit,
  describeMessage,
  EditError,
  listEdits,
  listRemoteEntries,
  MAX_COMMIT_MESSAGE_LENGTH,
  normalizeRemoteEntryPath,
  pegUrl,
  remoteInfo,
  resolveConn,
} from "./remote-edit-client.js";
import { getLongSvnTimeoutMs } from "./config-store.js";
import { buildFullUrl, runSvnWithMessage, type SvnConnection } from "./svn-client.js";
import { errorMessage, parseRevision } from "./util.js";

export const MAX_MOVE_BATCH = 100;

export interface MoveResult {
  /** 移動所產生的新版本號；讀不出來是 null。 */
  movedRevision: number | null;
  /** 被移動的項目：原本與移動後的遠端路徑（相對於連線根目錄）。 */
  moved: Array<{ from: string; to: string }>;
  /** 目標資料夾（相對於連線根目錄，連線根目錄是空字串）。 */
  targetDir: string;
  /** 「同步本地端」的結果；開關關閉時沒有這個欄位。 */
  localSync?: LocalSyncResult;
}

export interface MoveParams {
  connectionId?: string;
  /** 要移動的檔案或資料夾路徑清單。 */
  paths?: unknown;
  /** 目標資料夾；空字串＝連線根目錄。 */
  targetDir?: unknown;
  message: unknown;
}

const parentOf = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const baseOf = (p: string): string => (p.includes("/") ? p.slice(p.lastIndexOf("/") + 1) : p);

/** 整理要移動的路徑清單：去重（不分大小寫）、檢查格式與數量；已經跟著上層資料夾一起移動的子項目不重複處理。 */
function normalizeSources(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : [];
  if (list.length === 0 || list.every((p) => typeof p !== "string" || p.trim() === "")) throw new EditError("INVALID_INPUT", "請選擇要移動的檔案或資料夾");
  if (list.length > MAX_MOVE_BATCH) throw new EditError("INVALID_INPUT", `一次最多移動 ${MAX_MOVE_BATCH} 個項目`);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of list) {
    const subPath = normalizeRemoteEntryPath(item, "移動");
    if (!seen.has(subPath.toLowerCase())) {
      seen.add(subPath.toLowerCase());
      result.push(subPath);
    }
  }
  return result.filter((p) => !result.some((other) => other !== p && p.toLowerCase().startsWith(`${other.toLowerCase()}/`)));
}

/** 目標資料夾：空字串＝連線根目錄，其餘跟來源路徑用同一套檢查。 */
function normalizeTargetDir(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim().replace(/[\\/]+/g, "") === "") return "";
  return normalizeRemoteEntryPath(raw, "移動");
}

export async function assertMovable(conn: SvnConnection, subPath: string, editingPaths: Set<string>): Promise<void> {
  const lower = subPath.toLowerCase();
  for (const editing of editingPaths) {
    if (editing === lower) throw new EditError("ALREADY_EDITING", `「${subPath}」正在編輯中，請先上傳或放棄後再移動。`);
    if (editing.startsWith(`${lower}/`)) throw new EditError("ALREADY_EDITING", `資料夾「${subPath}」底下有檔案正在編輯中（${editing}），請先上傳或放棄後再移動。`);
  }
  const info = await remoteInfo(conn, buildFullUrl(conn.url, subPath));
  if (info.kind !== "file" && info.kind !== "dir") throw new EditError("INVALID_INPUT", `「${subPath}」不是檔案或資料夾，無法移動。`);
  if (info.lockOwner) {
    const who = info.lockOwner === conn.username ? `你自己的帳號（${conn.username}）` : `「${info.lockOwner}」`;
    throw new EditError("FILE_LOCKED", `「${subPath}」被${who}鎖定中，請先解除鎖定（或等對方上傳／解鎖）後再移動。`);
  }
}

/** 目標資料夾本身的檢查：要存在、是資料夾，而且不是被移動資料夾本身或它的子孫；回傳目標裡現有的項目。 */
async function assertTargetDir(conn: SvnConnection, targetDir: string, sources: string[]): Promise<Array<{ name: string }>> {
  const lowerTarget = targetDir.toLowerCase();
  for (const src of sources) {
    const lowerSrc = src.toLowerCase();
    if (lowerTarget === lowerSrc || lowerTarget.startsWith(`${lowerSrc}/`)) {
      throw new EditError("INVALID_INPUT", `不能把資料夾「${src}」移動到它自己或它的子資料夾裡。`);
    }
  }
  if (targetDir) {
    const info = await remoteInfo(conn, buildFullUrl(conn.url, targetDir)).catch(() => null);
    if (info?.kind !== "dir") throw new EditError("NOT_FOUND", `目標資料夾「${targetDir}」不存在（或不是資料夾），請先建立或改選別的資料夾。`);
  }
  return (await listRemoteEntries(conn, buildFullUrl(conn.url, targetDir))) ?? [];
}

export async function moveRemoteFiles(params: MoveParams): Promise<MoveResult & { conn: SvnConnection }> {
  const typed = typeof params.message === "string" ? params.message.trim() : "";
  if (typed.length > MAX_COMMIT_MESSAGE_LENGTH) throw new EditError("INVALID_INPUT", `移動說明太長（上限 ${MAX_COMMIT_MESSAGE_LENGTH} 字）`);

  const sources = normalizeSources(params.paths);
  const targetDir = normalizeTargetDir(params.targetDir);
  // 說明不是必填：留空時自動補一句（SVN 的 commit 一定要有訊息）
  const message = typed || `移動 ${sources.length} 個項目到「${targetDir || "根目錄"}」`;
  const conn = await resolveConn(params.connectionId);
  const moved = sources.map((from) => ({ from, to: targetDir ? `${targetDir}/${baseOf(from)}` : baseOf(from) }));

  try {
    const existingNames = new Set((await assertTargetDir(conn, targetDir, sources)).map((e) => e.name.toLowerCase()));
    const incoming = new Set<string>();
    for (const { from } of moved) {
      if (parentOf(from).toLowerCase() === targetDir.toLowerCase()) throw new EditError("INVALID_INPUT", `「${from}」本來就在「${targetDir || "根目錄"}」裡，不需要移動。`);
      const name = baseOf(from).toLowerCase();
      if (existingNames.has(name)) throw new EditError("ALREADY_EXISTS", `目標資料夾已經有「${baseOf(from)}」了，不會覆蓋，請先處理掉那個項目或改選別的資料夾。`);
      if (incoming.has(name)) throw new EditError("INVALID_INPUT", `選到的項目裡有兩個同名的「${baseOf(from)}」，移到同一個資料夾會衝突，請分開移動。`);
      incoming.add(name);
    }
    const editingPaths = new Set((await listEdits()).filter((s) => s.connectionId === conn.id).map((s) => s.path.toLowerCase()));
    for (const src of sources) await assertMovable(conn, src, editingPaths);

    const urls = [...sources.map((p) => pegUrl(buildFullUrl(conn.url, p))), buildFullUrl(conn.url, targetDir)];
    const { stdout } = await runSvnWithMessage("move", conn, message, urls, getLongSvnTimeoutMs());
    const movedRevision = parseRevision(stdout);
    await audit({ op: "move", connection: conn.name, moved, targetDir, count: moved.length, movedRevision, ok: true, ...describeMessage(message) });
    return { movedRevision, moved, targetDir, conn };
  } catch (e) {
    await audit({ op: "move", connection: conn.name, moved, targetDir, count: moved.length, ok: false, error: errorMessage(e), ...describeMessage(message) });
    throw e;
  }
}

/** 移動遠端檔案，成功後依開關同步本地端（更新原本所在與移動後所在的資料夾）。 */
export async function moveRemoteFilesAndSync(params: MoveParams): Promise<MoveResult> {
  const { conn, ...result } = await moveRemoteFiles(params);
  const dirs = new Map<string, string>();
  for (const { from, to } of result.moved) {
    dirs.set(parentOf(from).toLowerCase(), from);
    dirs.set(parentOf(to).toLowerCase(), to);
  }
  const syncs: LocalSyncResult[] = [];
  for (const remotePath of dirs.values()) {
    const sync = await syncLocalAfterChange(conn, remotePath, "parent");
    if (!sync) return result; // 開關關閉
    syncs.push(sync);
  }
  return { ...result, localSync: mergeSyncResults(syncs) };
}
