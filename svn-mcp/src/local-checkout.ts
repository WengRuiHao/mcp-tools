/**
 * Checkout 到本地：把 SVN 上的某個目錄取到使用者電腦的資料夾，建立 SVN 追蹤（之後「同步本地端」才有地方可更新）。
 *
 * **刻意不註冊成 MCP 工具**——只給 svn-edit 的網頁按鈕呼叫，AI 維持唯讀。
 *
 * 安全邊界（不能弄亂使用者原有的檔案）：
 * - 只能 Checkout「遠端的資料夾」；放到的位置（上層資料夾 + 新資料夾名稱）必須是**還不存在或是空的**資料夾，
 *   已經有內容、或已經是工作目錄就拒絕；
 * - 目標在另一個 SVN 工作目錄裡面也拒絕（工作目錄巢狀會讓 update 和提交的範圍變得難懂）；
 * - 新資料夾名稱只能是單一名稱（不含路徑分隔、Windows 不允許的字元、`.`／`..`）；
 * - 失敗時，這次新建立的資料夾會清掉，不留下半套工作目錄；
 * - 每次都寫稽核紀錄。
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { getSvnTimeoutMs } from "./config-store.js";
import { isInsideWorkCopy } from "./local-fs.js";
import { cleanLocalDir } from "./prefs-model.js";
import { audit, EditError, normalizeRemoteEntryPath, pegUrl, remoteInfo, resolveConn } from "./remote-edit-client.js";
import { addLocalPath } from "./repo-prefs.js";
import { buildFullUrl, runSvn } from "./svn-client.js";
import { errorMessage } from "./util.js";
import { parseRevision, toSlash } from "./util.js";

export type CheckoutScope = "all" | "files" | "empty";
const SCOPES: ReadonlySet<string> = new Set(["all", "files", "empty"]);
/** 整個目錄可能很大，給 svn 的時間比一般操作長很多（預設逾時的 120 倍，約一小時）。 */
const CHECKOUT_TIMEOUT_MULTIPLIER = 120;
const CHECKOUT_MAX_BUFFER_BYTES = 200 * 1024 * 1024;
const MAX_FOLDER_NAME_LENGTH = 100;
const FORBIDDEN_NAME_CHARS = /[<>:"|?*\u0000-\u001f]/;

export interface CheckoutParams {
  connectionId?: string;
  /** 要 Checkout 的遠端資料夾（相對於連線根目錄）；空字串代表整個專案。 */
  remotePath: unknown;
  /** 放在本地哪個資料夾底下（必須已存在）。 */
  parent: unknown;
  /** 新資料夾名稱。 */
  name: unknown;
  scope: unknown;
  /** 完成後設為這個專案的同步目錄。 */
  setSync: unknown;
}

export interface CheckoutResult {
  /** 取出的版本號；讀不出來是 null。 */
  revision: number | null;
  /** svn 回報新增了幾個項目（檔案與資料夾）。 */
  itemCount: number;
  /** 建立好的本地工作目錄（用 `/` 分隔）。 */
  target: string;
  remotePath: string;
  /** 有沒有設為同步目錄。 */
  synced: boolean;
}

function normalizeRemoteDir(raw: unknown): string {
  const text = typeof raw === "string" ? raw.trim() : "";
  return text === "" || text === "/" ? "" : normalizeRemoteEntryPath(text, "Checkout");
}

function normalizeFolderName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name) throw new EditError("INVALID_INPUT", "請填資料夾名稱");
  if (name.length > MAX_FOLDER_NAME_LENGTH) throw new EditError("INVALID_INPUT", `資料夾名稱太長（上限 ${MAX_FOLDER_NAME_LENGTH} 字）`);
  if (name === "." || name === ".." || name.includes("/") || name.includes(path.sep) || FORBIDDEN_NAME_CHARS.test(name) || name.endsWith(".") || name.endsWith(" ")) {
    throw new EditError("INVALID_INPUT", "資料夾名稱不能含路徑分隔或 Windows 不允許的字元（: * ? \" < > |），也不能以點或空白結尾");
  }
  return name;
}

/** 檢查放置的位置；回傳「目標資料夾是否原本就存在（空的）」。 */
function assertTargetUsable(parent: string, target: string): boolean {
  if (!existsSync(parent) || !statSync(parent).isDirectory()) throw new EditError("INVALID_INPUT", `選擇的位置不存在或不是資料夾：${parent}`);
  const existed = existsSync(target);
  if (existed) {
    if (!statSync(target).isDirectory()) throw new EditError("ALREADY_EXISTS", `「${target}」已經有一個同名的檔案，請換一個資料夾名稱。`);
    if (isInsideWorkCopy(target)) throw new EditError("ALREADY_EXISTS", `「${target}」已經是 SVN 工作目錄，不需要再 Checkout；可以直接到「管理連線」指定它。`);
    if (readdirSync(target).length > 0) throw new EditError("ALREADY_EXISTS", `「${target}」已經有內容，為了不弄亂你原有的檔案，不能 Checkout 到這裡。請換一個新的資料夾名稱。`);
  } else if (isInsideWorkCopy(parent)) {
    throw new EditError("ALREADY_EXISTS", `「${parent}」已經在另一個 SVN 工作目錄裡面，不能在裡面再 Checkout 一層。請換一個不在 SVN 工作目錄內的位置。`);
  }
  return existed;
}

export async function checkoutToLocal(params: CheckoutParams): Promise<CheckoutResult> {
  const scope = typeof params.scope === "string" && SCOPES.has(params.scope) ? (params.scope as CheckoutScope) : "all";
  const remotePath = normalizeRemoteDir(params.remotePath);
  const name = normalizeFolderName(params.name);
  const parentText = cleanLocalDir(params.parent);
  if (!parentText) throw new EditError("INVALID_INPUT", "請先選擇要放在本地哪個資料夾底下");
  const parent = path.resolve(parentText);
  const target = path.join(parent, name);
  const conn = await resolveConn(params.connectionId);
  const remoteUrl = buildFullUrl(conn.url, remotePath);

  const existed = assertTargetUsable(parent, target);
  const info = await remoteInfo(conn, remoteUrl);
  if (info.kind !== "dir") throw new EditError("INVALID_INPUT", `「${remotePath || "（整個專案）"}」不是資料夾，只能 Checkout 資料夾。`);

  const args = ["checkout", ...(scope === "all" ? [] : ["--depth", scope === "files" ? "files" : "empty"]), pegUrl(remoteUrl), target];
  try {
    const { stdout } = await runSvn(args, conn, getSvnTimeoutMs() * CHECKOUT_TIMEOUT_MULTIPLIER, undefined, CHECKOUT_MAX_BUFFER_BYTES);
    const output = stdout.toString("utf-8");
    const itemCount = output.split(/\r?\n/).filter((line) => /^A\s/.test(line)).length;
    const targetText = toSlash(target);
    if (params.setSync) await addLocalPath(conn.name, targetText);
    await audit({ op: "checkout", connection: conn.name, path: remotePath, target: targetText, scope, itemCount, ok: true, synced: !!params.setSync });
    return { revision: parseRevision(output), itemCount, target: targetText, remotePath, synced: !!params.setSync };
  } catch (e) {
    // 這次新建立的資料夾（或原本是空的）清掉，不留下半套工作目錄
    if (existsSync(target)) await rm(target, { recursive: true, force: true }).catch(() => undefined);
    if (existed) await mkdir(target, { recursive: true }).catch(() => undefined);
    await audit({ op: "checkout", connection: conn.name, path: remotePath, target: toSlash(target), scope, ok: false, error: errorMessage(e) });
    throw e;
  }
}
