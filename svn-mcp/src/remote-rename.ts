/**
 * 直接改 SVN 上的檔案或資料夾名稱（原地改名）：在遠端 `svn move <原網址> <新網址>` 並 commit，不需要工作副本、不用先下載編輯。
 *
 * **刻意不註冊成 MCP 工具**——跟 remote-delete／remote-move 一樣只給 svn-edit 的網頁按鈕呼叫，AI 維持唯讀。
 *
 * 安全邊界：
 * - 新名稱檢查：不能是空的、不能含 `/ \ : * ? " < > |`；檔案的副檔名要跟原檔一樣（資料夾不檢查副檔名）；不能跟目前名稱完全一樣；
 * - 同一個目錄裡不能已有同名項目（不分大小寫；只改大小寫的話，不把自己算進去）——不會蓋掉別人的檔案；
 * - 項目不存在、正在編輯（資料夾底下有編輯中的檔案也算）、被鎖定都拒絕；
 * - 改名是一個 `svn move`、一個 revision，歷史保留；commit 訊息不用填，自動產生「重新命名：舊名 → 新名」；
 * - 成功之後依「同步本地端」開關更新本地工作目錄（失敗只提示，不影響改名結果）；
 * - 每次改名都寫一行稽核紀錄。
 */
import { syncLocalAfterChange, type LocalSyncResult } from "./local-sync.js";
import { assertMovable } from "./remote-move.js";
import {
  audit,
  EditError,
  listEdits,
  listRemoteEntries,
  newNameProblem,
  normalizeRemoteEntryPath,
  pegUrl,
  remoteInfo,
  resolveConn,
} from "./remote-edit-client.js";
import { getLongSvnTimeoutMs } from "./config-store.js";
import { buildFullUrl, runSvnWithMessage } from "./svn-client.js";
import { errorMessage, parseRevision } from "./util.js";

export interface RenameRemoteResult {
  /** 改名所產生的新版本號；讀不出來是 null。 */
  renamedRevision: number | null;
  /** 改名前、改名後的遠端路徑（相對於連線根目錄）。 */
  from: string;
  to: string;
  newName: string;
  /** 「同步本地端」的結果；開關關閉時沒有這個欄位。 */
  localSync?: LocalSyncResult;
}

export interface RenameRemoteParams {
  connectionId?: string;
  /** 要改名的檔案或資料夾路徑。 */
  path?: unknown;
  newName?: unknown;
}

export async function renameRemoteEntryAndSync(params: RenameRemoteParams): Promise<RenameRemoteResult> {
  const from = normalizeRemoteEntryPath(params.path, "改名");
  const slash = from.lastIndexOf("/");
  const parent = slash >= 0 ? from.slice(0, slash) : "";
  const oldName = slash >= 0 ? from.slice(slash + 1) : from;
  const newName = typeof params.newName === "string" ? params.newName.trim() : "";
  const to = parent ? `${parent}/${newName}` : newName;
  const conn = await resolveConn(params.connectionId);
  const message = `重新命名：${oldName} → ${newName}`;

  try {
    const info = await remoteInfo(conn, buildFullUrl(conn.url, from));
    if (info.kind !== "file" && info.kind !== "dir") throw new EditError("INVALID_INPUT", `「${from}」不是檔案或資料夾，無法改名。`);
    const problem = newNameProblem(oldName, newName, "新名稱", info.kind === "file");
    if (problem) throw new EditError("INVALID_INPUT", problem);
    if (newName === oldName) throw new EditError("INVALID_INPUT", "新名稱跟目前的名稱一樣，請改成不同的名稱。");

    const siblings = (await listRemoteEntries(conn, buildFullUrl(conn.url, parent))) ?? [];
    const clash = siblings.find((e) => e.name.toLowerCase() === newName.toLowerCase() && e.name.toLowerCase() !== oldName.toLowerCase());
    if (clash) throw new EditError("ALREADY_EXISTS", `這個目錄已經有「${clash.name}」了，不會覆蓋，請改成別的名稱。`);

    const editingPaths = new Set((await listEdits()).filter((s) => s.connectionId === conn.id).map((s) => s.path.toLowerCase()));
    await assertMovable(conn, from, editingPaths);

    const { stdout } = await runSvnWithMessage("move", conn, message, [pegUrl(buildFullUrl(conn.url, from)), buildFullUrl(conn.url, to)], getLongSvnTimeoutMs());
    const renamedRevision = parseRevision(stdout);
    await audit({ op: "rename", connection: conn.name, from, to, kind: info.kind, renamedRevision, ok: true });
    const result: RenameRemoteResult = { renamedRevision, from, to, newName };
    const localSync = await syncLocalAfterChange(conn, to, "parent");
    return localSync ? { ...result, localSync } : result;
  } catch (e) {
    await audit({ op: "rename", connection: conn.name, from, to, ok: false, error: errorMessage(e) });
    throw e;
  }
}
