/**
 * 遠端單一檔案編輯：不需要使用者手動 checkout，就能把 SVN 上的一個檔案取到暫存資料夾、用本機軟體
 * （Word／Excel／編輯器）改完，再 commit 回遠端。
 *
 * **刻意不註冊成 MCP 工具**——跟 workcopy-client 一樣，svn-mcp 對 AI 呼叫端維持唯讀；這份模組只提供函式，
 * 由 `svn-edit` 執行檔（使用者在網頁上按按鈕）呼叫。`tests/read-only-surface.test.mjs` 會鎖住這件事。
 *
 * 一次編輯（session）的流程：openEdit（取出單一檔案、記下基準版本、必要時上鎖）→ 使用者編輯 →
 * commitEdit（檢查後送出、清理）或 discardEdit（解鎖、清理）。session 狀態寫在暫存資料夾的 session.json，
 * 所以程式重開後 listEdits 仍找得到殘留的 session（當機復原）。
 *
 * 安全邊界：
 * - 只能操作指定連線 URL 底下的「單一檔案」（路徑拒絕 `..` 與完整 URL，由 buildFullUrl 把關），副檔名白名單、大小上限；
 * - commit 一定要有非空訊息；遠端已被別人改過一律拒絕（不自動合併，Word／Excel 本來就不能合併）；
 * - Word／Excel／LibreOffice 的暫存鎖定檔還在，代表檔案還開著，拒絕上傳；
 * - 內容跟開啟時完全相同就不產生空 commit；
 * - 每次開啟／上傳／放棄都寫一行稽核紀錄（commit 訊息只記長度與前 80 字）。
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { appendFile, chmod, copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getAuditLogPath, getEditTempDir, getSvnTimeoutMs } from "./config-store.js";
import { buildFullUrl, resolveConnection, runSvn, svnBrowse, type SvnConnection } from "./svn-client.js";
import { removeDirWithRetry } from "./temp-clean.js";
import { archiveFileName, parseVersion, suggestUpgradeName } from "./version-bump.js";
import { commitWithMessage, pegSafe, withWcLock } from "./workcopy-client.js";

export const ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set(["docx", "xlsx", "xls", "md", "txt", "csv"]);
/** 只能開啟檢視（唯讀）、不能編輯上傳的檔案類型：取出最新版放到暫存資料夾，用預設程式開啟，不會動到 SVN。 */
export const VIEW_EXTENSIONS: ReadonlySet<string> = new Set(["pdf"]);
/** 無法自動合併的格式，預設開啟時就上鎖，避免兩個人同時改。 */
export const LOCK_EXTENSIONS: ReadonlySet<string> = new Set(["docx", "xlsx", "xls"]);
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_COMMIT_MESSAGE_LENGTH = 4000;
const LONG_OPERATION_TIMEOUT_MULTIPLIER = 10;
/** Word／Excel 是 `~$`，LibreOffice 是 `.~lock.`；暫存資料夾裡只有一個被編輯的檔案，出現這些就代表還開著。 */
const EDITOR_LOCK_PREFIXES = ["~$", ".~lock."];
/**
 * Word／Excel／LibreOffice 開著文件時自動產生的暫存標記檔（`~$xxx.docx`、`.~lock.xxx#`）。它們不是文件本身，
 * 偶爾會被人用 TortoiseSVN 連資料夾一起誤提交進 SVN；瀏覽時要標示出來，也不能被開啟編輯或新增。
 */
export function isEditorTempFile(fileName: string): boolean {
  return EDITOR_LOCK_PREFIXES.some((prefix) => fileName.startsWith(prefix));
}
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type EditErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "ALREADY_EDITING"
  | "FILE_LOCKED"
  | "FILE_TOO_LARGE"
  | "EDITOR_STILL_OPEN"
  | "NO_CHANGES"
  | "REMOTE_CHANGED"
  | "ALREADY_EXISTS"
  | "UNLOCK_FAILED";

/** 帶錯誤代碼的錯誤，讓控制頁能依情況顯示不同的處理選項（例如 REMOTE_CHANGED 顯示「下載最新版另存」）。 */
export class EditError extends Error {
  constructor(public readonly code: EditErrorCode, message: string) {
    super(message);
    this.name = "EditError";
  }
}

export interface EditSession {
  id: string;
  /** 連線 id（不含帳密）。 */
  connectionId: string;
  connectionName: string;
  /** 相對於連線 URL、以 `/` 分隔的遠端路徑。 */
  path: string;
  fileName: string;
  /** 暫存工作副本裡被編輯的檔案的絕對路徑。 */
  filePath: string;
  sessionDir: string;
  wcDir: string;
  /** 開啟當下，這個檔案最後一次被修改的遠端版本號。 */
  baseRevision: number;
  /** 開啟當下的內容雜湊（sha256），用來判斷有沒有改過。 */
  baseHash: string;
  locked: boolean;
  ticket: string | null;
  openedAt: string;
}

export interface OpenEditParams {
  connectionId?: string;
  path: string;
  ticket?: string;
  /** 不指定時依副檔名決定（docx、xlsx、xls 預設上鎖）。 */
  lock?: boolean;
}

export interface EditStatus {
  session: EditSession;
  /** 內容跟開啟時不同。 */
  modified: boolean;
  /** 偵測到 Word／Excel 的暫存鎖定檔，代表檔案還開著。 */
  editorStillOpen: boolean;
  /** 遠端是否已有新版本；沒有要求連遠端檢查時是 null。 */
  remoteChanged: boolean | null;
}

export interface EditCommitResult {
  committedRevision: number | null;
  path: string;
  /** 暫存資料夾是否已清乾淨（commit 成功但清不掉時是 false，不影響 commit 結果）。 */
  cleanedUp: boolean;
  /** 這次有「升級版本」時的結果：舊版放去哪、新版叫什麼。 */
  upgrade?: { archivedTo: string; renamedTo: string; newName: string; fromVersion: string | null; toVersion: string | null };
}

/** 上傳時要不要「升級版本」：舊版複製到同目錄的 old 資料夾，新內容以版本號 +1 的新檔名上傳（同一個 commit）。 */
export interface UpgradeOptions {
  /** 新版檔名；不給就用自動 +1 的結果。 */
  newName?: string;
}

export interface UpgradePlan {
  /** 這個檔案現在能不能升級（沒有版本號、新檔名已存在、old 裡已有舊版…都不能）。 */
  applicable: boolean;
  /** 不能升級（或需要注意）的原因。 */
  reason: string | null;
  currentName: string;
  currentVersion: string | null;
  /** 新版檔名（預設是版本號 +1；原檔名沒有版本號就自動加上 _v0.2）。 */
  newName: string | null;
  newVersion: string | null;
  /** 原檔名沒有版本號，新版檔名的版次是自動加上的（舊版放進 old 時仍用原檔名）。 */
  implicitVersion: boolean;
  /** 遠端放舊版的資料夾名稱：已經有 old／Old（不分大小寫）就沿用它原本的大小寫，沒有就叫 old。 */
  archiveDirName: string;
  /** 這個資料夾遠端已經存在（false 代表上傳時會自動建立）。 */
  archiveDirExists: boolean;
  /** 舊版放進 old 時的檔名：原檔名沒有版本號就自動補上 _v0.1，有版本號就維持原檔名。 */
  archiveFileName: string;
  /** 舊版會放到的遠端路徑、新版的遠端路徑（相對於連線根目錄）。 */
  archivePath: string | null;
  newPath: string | null;
}

// ---- 路徑、session 儲存 ----

/**
 * 把路徑解析成「真實的長路徑」：Windows 的 8.3 短檔名（例如 C:\\Users\\RUIHAO~1\\…）svn 會當成另一個位置，
 * 工作副本放在這種路徑底下時 `svn move` 之類的指令會回 E155004（工作副本被鎖住）。
 * 路徑還不存在時，解析最近一個存在的上層資料夾，再接上剩下的部分。
 */
export function toRealPath(target: string): string {
  const rest: string[] = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      return rest.length ? path.join(realpathSync.native(current), ...rest.reverse()) : realpathSync.native(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

export function getEditBaseDir(): string {
  return toRealPath(getEditTempDir());
}

function assertSessionId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !SESSION_ID_RE.test(id)) {
    throw new EditError("INVALID_INPUT", "session id 格式不正確");
  }
}

function sessionDirOf(id: string): string {
  return path.join(getEditBaseDir(), id);
}

async function saveSession(session: EditSession): Promise<void> {
  await writeFile(path.join(session.sessionDir, "session.json"), JSON.stringify(session, null, 2), "utf-8");
}

async function loadSession(id: string): Promise<EditSession> {
  assertSessionId(id);
  try {
    const raw = await readFile(path.join(sessionDirOf(id), "session.json"), "utf-8");
    return JSON.parse(raw) as EditSession;
  } catch {
    throw new EditError("NOT_FOUND", `找不到編輯項目 ${id}（可能已經上傳或放棄）`);
  }
}

/** 列出所有殘留的編輯項目（含當機後留下的），讓使用者決定繼續上傳或放棄。 */
export async function listEdits(): Promise<EditSession[]> {
  let names: string[];
  try {
    names = await readdir(getEditBaseDir());
  } catch {
    return [];
  }
  const sessions: EditSession[] = [];
  for (const name of names.filter((n) => SESSION_ID_RE.test(n))) {
    try {
      sessions.push(await loadSession(name));
    } catch {
      // session.json 不見或壞掉的資料夾略過，不讓一個壞項目擋住整份清單
    }
  }
  return sessions.sort((a, b) => a.openedAt.localeCompare(b.openedAt));
}

// ---- 稽核紀錄 ----

export async function audit(record: Record<string, unknown>): Promise<void> {
  try {
    const file = getAuditLogPath();
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, "utf-8");
  } catch (e) {
    console.error(`[svn-edit] 寫稽核紀錄失敗：${e instanceof Error ? e.message : String(e)}`);
  }
}

export function describeMessage(message: string | undefined): Record<string, unknown> {
  return message === undefined ? {} : { messagePreview: message.slice(0, 80), messageLength: message.length };
}

// ---- 輔助 ----

/** 連線解析失敗（沒指定連線而有多個、找不到名稱）是呼叫端的輸入問題，統一轉成 INVALID_INPUT，不要變成 500。 */
export async function resolveConn(connectionId?: string): Promise<SvnConnection> {
  try {
    return await resolveConnection(connectionId);
  } catch (e) {
    throw new EditError("INVALID_INPUT", e instanceof Error ? e.message : String(e));
  }
}

export function pegUrl(url: string): string {
  return url.includes("@") ? `${url}@` : url;
}

export function xmlUnescape(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

async function hashFile(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

export function longTimeout(): number {
  return getSvnTimeoutMs() * LONG_OPERATION_TIMEOUT_MULTIPLIER;
}

/** 把使用者傳來的路徑整理成 `a/b/c.docx` 形式，並檢查是個允許的檔案類型；跳出連線範圍的寫法由 buildFullUrl 拒絕。 */
export function normalizeRemotePath(raw: unknown, allowed: ReadonlySet<string> = ALLOWED_EXTENSIONS, purpose = "編輯", allowTempFile = false): { subPath: string; fileName: string; ext: string } {
  if (typeof raw !== "string" || raw.trim() === "") throw new EditError("INVALID_INPUT", "檔案路徑不能是空的");
  const segments = raw.trim().replace(/\\/g, "/").split("/").filter((seg) => seg !== "" && seg !== ".");
  if (segments.length === 0) throw new EditError("INVALID_INPUT", "檔案路徑不能是空的");
  if (segments.some((seg) => seg === "..")) throw new EditError("INVALID_INPUT", `路徑不能包含 ".."：${raw}`);
  // Windows 不允許的字元一律拒絕：同事在 Windows 上取出時會失敗；也擋掉 `file:///x` 被整理成 `file:/x` 繞過完整 URL 檢查的寫法
  if (segments.some((seg) => /[<>:"|?*\u0000-]/.test(seg))) {
    throw new EditError("INVALID_INPUT", `路徑含有不允許的字元（: * ? " < > |）：${raw}`);
  }
  const fileName = segments[segments.length - 1];
  if (!allowTempFile && isEditorTempFile(fileName)) {
    throw new EditError("INVALID_INPUT", `「${fileName}」是 Word／Excel 開著文件時自動產生的暫存檔，不是文件本身，不能編輯或新增。如果它被誤提交進了 SVN，請用 TortoiseSVN 把它刪除。`);
  }
  const dot = fileName.lastIndexOf(".");
  const ext = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : "";
  if (!allowed.has(ext)) {
    throw new EditError("INVALID_INPUT", `不支援${purpose}這種檔案（.${ext || "無副檔名"}），目前只支援：${[...allowed].map((e) => `.${e}`).join("、")}`);
  }
  return { subPath: segments.join("/"), fileName, ext };
}

export interface RemoteInfo {
  kind: string | null;
  lockOwner: string | null;
}

export async function remoteInfo(conn: SvnConnection, fileUrl: string): Promise<RemoteInfo> {
  let xml: string;
  try {
    const { stdout } = await runSvn(["info", "--xml", pegUrl(fileUrl)], conn, getSvnTimeoutMs());
    xml = stdout.toString("utf-8");
  } catch (e) {
    throw new EditError("NOT_FOUND", `遠端找不到這個檔案或讀取失敗：${e instanceof Error ? e.message : String(e)}`);
  }
  const owner = xml.match(/<lock>[\s\S]*?<owner>([^<]*)<\/owner>/);
  return { kind: (xml.match(/<entry[^>]*\bkind="([^"]+)"/) ?? [])[1] ?? null, lockOwner: owner ? xmlUnescape(owner[1]) : null };
}

async function remoteLastChangedRevision(conn: SvnConnection, fileUrl: string): Promise<number> {
  const { stdout } = await runSvn(["info", "--show-item", "last-changed-revision", pegUrl(fileUrl)], conn, getSvnTimeoutMs());
  return Number(stdout.toString("utf-8").trim());
}

async function localLastChangedRevision(conn: SvnConnection, filePath: string): Promise<number> {
  const { stdout } = await runSvn(["info", "--show-item", "last-changed-revision", pegSafe(filePath)], conn, getSvnTimeoutMs());
  return Number(stdout.toString("utf-8").trim());
}

async function findEditorLockFiles(filePath: string): Promise<string[]> {
  const names = await readdir(path.dirname(filePath));
  return names.filter((n) => EDITOR_LOCK_PREFIXES.some((p) => n.startsWith(p)));
}

function remoteUrlOf(conn: SvnConnection, session: EditSession): string {
  return buildFullUrl(conn.url, session.path);
}

// ---- 開啟 ----

export async function openEdit(params: OpenEditParams): Promise<EditSession> {
  const { subPath, fileName, ext } = normalizeRemotePath(params.path);
  const conn = await resolveConn(params.connectionId);
  const fileUrl = buildFullUrl(conn.url, subPath);
  const parentUrl = fileUrl.slice(0, fileUrl.lastIndexOf("/"));
  const wantLock = params.lock ?? LOCK_EXTENSIONS.has(ext);

  const existing = (await listEdits()).find((s) => s.connectionId === conn.id && s.path.toLowerCase() === subPath.toLowerCase());
  if (existing) {
    throw new EditError("ALREADY_EDITING", `這個檔案已經有進行中的編輯（${existing.id}，開啟於 ${existing.openedAt}），請先上傳或放棄。`);
  }

  const info = await remoteInfo(conn, fileUrl);
  if (info.kind !== "file") throw new EditError("INVALID_INPUT", `「${subPath}」不是檔案，只能編輯單一檔案。`);
  if (wantLock && info.lockOwner && info.lockOwner !== conn.username) {
    throw new EditError("FILE_LOCKED", `這個檔案已被「${info.lockOwner}」鎖定編輯中，請等對方上傳或解鎖後再試。`);
  }
  if (wantLock && info.lockOwner === conn.username) {
    throw new EditError("FILE_LOCKED", `這個檔案已被你自己的帳號（${conn.username}）鎖定，可能是上次編輯沒有正常結束；請先處理殘留的編輯項目，或在小烏龜手動解除鎖定。`);
  }

  const id = randomUUID();
  const sessionDir = sessionDirOf(id);
  const wcDir = path.join(sessionDir, "wc");
  const filePath = path.join(wcDir, fileName);
  let locked = false;
  try {
    await mkdir(sessionDir, { recursive: true });
    await runSvn(["checkout", "--depth", "empty", pegUrl(parentUrl), wcDir], conn, longTimeout());
    await runSvn(["update", "--set-depth", "infinity", pegSafe(filePath)], conn, longTimeout());

    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat || !fileStat.isFile()) throw new EditError("NOT_FOUND", `取出「${subPath}」失敗：暫存資料夾裡沒有這個檔案`);
    if (fileStat.size > MAX_FILE_BYTES) {
      throw new EditError("FILE_TOO_LARGE", `檔案太大（${Math.round(fileStat.size / 1024 / 1024)} MB），上限 ${MAX_FILE_BYTES / 1024 / 1024} MB`);
    }

    const baseRevision = await localLastChangedRevision(conn, filePath);
    const baseHash = await hashFile(filePath);

    if (wantLock) {
      await runSvn(["lock", "-m", "svn-edit", pegSafe(filePath)], conn, getSvnTimeoutMs());
      locked = true;
    }

    const session: EditSession = {
      id,
      connectionId: conn.id,
      connectionName: conn.name,
      path: subPath,
      fileName,
      filePath,
      sessionDir,
      wcDir,
      baseRevision,
      baseHash,
      locked,
      ticket: params.ticket?.trim() || null,
      openedAt: new Date().toISOString(),
    };
    await saveSession(session);
    await audit({ op: "open", id, connection: conn.name, path: subPath, baseRevision, locked, ticket: session.ticket, ok: true });
    return session;
  } catch (e) {
    if (locked) await runSvn(["unlock", pegSafe(filePath)], conn, getSvnTimeoutMs()).catch(() => undefined);
    await removeDirWithRetry(sessionDir);
    await audit({ op: "open", id, connection: conn.name, path: subPath, ok: false, error: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

// ---- 狀態 ----

export async function getEditStatus(id: string, options: { checkRemote?: boolean } = {}): Promise<EditStatus> {
  const session = await loadSession(id);
  const modified = (await hashFile(session.filePath).catch(() => session.baseHash)) !== session.baseHash;
  const editorStillOpen = (await findEditorLockFiles(session.filePath).catch(() => [])).length > 0;
  let remoteChanged: boolean | null = null;
  if (options.checkRemote) {
    const conn = await resolveConn(session.connectionId);
    remoteChanged = (await remoteLastChangedRevision(conn, remoteUrlOf(conn, session))) !== session.baseRevision;
  }
  return { session, modified, editorStillOpen, remoteChanged };
}

// ---- 上傳 ----

const ARCHIVE_DIR_NAME = "old";
const FORBIDDEN_NAME_CHARS = /[<>:"|?*\u0000-\u001f]/;

/** 列出遠端資料夾裡的項目名稱與型別；資料夾不存在回傳 null，其他錯誤（連線、權限）照實丟出。 */
async function listRemoteEntries(conn: SvnConnection, dirUrl: string): Promise<Array<{ name: string; kind: "file" | "dir" }> | null> {
  try {
    const { stdout } = await runSvn(["list", "--xml", pegUrl(dirUrl)], conn, getSvnTimeoutMs());
    const entries: Array<{ name: string; kind: "file" | "dir" }> = [];
    for (const m of stdout.toString("utf-8").matchAll(/<entry\s+kind="(file|dir)">([\s\S]*?)<\/entry>/g)) {
      const name = /<name>([^<]*)<\/name>/.exec(m[2]);
      if (name) entries.push({ name: xmlUnescape(name[1]), kind: m[1] as "file" | "dir" });
    }
    return entries;
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    if (/E170000|E160013|E200009|non-existent|doesn't exist|does not exist|path not found|not found/i.test(text)) return null;
    throw new EditError("NOT_FOUND", `讀取遠端目錄失敗：${text}`);
  }
}

/**
 * 預覽「升級版本」會做什麼，並檢查能不能做：
 * 舊版（SVN 上現在這個檔案）複製到同目錄的 old 資料夾，新內容上傳成版本號 +1 的新檔名。
 * `newNameOverride` 是使用者自己改的新檔名（要跟原檔同副檔名、不能跟目錄裡既有的檔案同名）。
 */
export async function getUpgradePlan(id: string, newNameOverride?: string): Promise<UpgradePlan> {
  const session = await loadSession(id);
  const conn = await resolveConn(session.connectionId);
  const parsed = parseVersion(session.fileName);
  const dirSub = session.path.includes("/") ? session.path.slice(0, session.path.lastIndexOf("/")) : "";
  const join = (...parts: string[]): string => parts.filter(Boolean).join("/");
  const base: UpgradePlan = {
    applicable: false,
    reason: null,
    currentName: session.fileName,
    currentVersion: parsed ? `${parsed.marker}${parsed.parts.join(".")}` : null,
    newName: null,
    newVersion: null,
    implicitVersion: false,
    archiveDirName: ARCHIVE_DIR_NAME,
    archiveDirExists: false,
    archiveFileName: archiveFileName(session.fileName).name,
    archivePath: null,
    newPath: null,
  };
  // 沒有版本號的檔案：原檔當第一版，新版檔名自動加上 _v0.2（有版本號就把版本號 +1）
  const suggestion = suggestUpgradeName(session.fileName);
  const newName = (newNameOverride ?? "").trim() || suggestion.name;
  const withName: UpgradePlan = {
    ...base,
    implicitVersion: suggestion.implicit,
    newName,
    newVersion: (() => {
      const p = parseVersion(newName);
      return p ? `${p.marker}${p.parts.join(".")}` : null;
    })(),
    newPath: join(dirSub, newName),
  };

  const ext = (/\.[A-Za-z][A-Za-z0-9]{0,7}$/.exec(session.fileName)?.[0] ?? "").toLowerCase();
  if (newName.includes("/") || newName.includes("\\") || newName === "." || newName === ".." || FORBIDDEN_NAME_CHARS.test(newName)) {
    return { ...withName, reason: "新版檔名不能包含 / \\ : * ? \" < > | 這些字元。" };
  }
  if (ext && !newName.toLowerCase().endsWith(ext)) return { ...withName, reason: `新版檔名的副檔名要跟原檔一樣（${ext}）。` };
  if (newName.toLowerCase() === session.fileName.toLowerCase()) return { ...withName, reason: "新版檔名跟目前的檔名一樣，請改成不同的版本號。" };

  const dirUrl = buildFullUrl(conn.url, dirSub);
  const entries = (await listRemoteEntries(conn, dirUrl)) ?? [];
  if (entries.some((e) => e.name.toLowerCase() === newName.toLowerCase())) {
    return { ...withName, reason: `這個目錄已經有「${newName}」了，請改成別的新版檔名（或先處理掉那個檔案）。` };
  }
  const archive = entries.find((e) => e.name.toLowerCase() === ARCHIVE_DIR_NAME);
  if (archive && archive.kind !== "dir") return { ...withName, reason: `這個目錄裡有一個叫「${archive.name}」的檔案，不是資料夾，沒辦法拿來放舊版。` };
  const archiveDirName = archive?.name ?? ARCHIVE_DIR_NAME;
  const archivePath = join(dirSub, archiveDirName, base.archiveFileName);
  const planned: UpgradePlan = { ...withName, archiveDirName, archiveDirExists: Boolean(archive), archivePath };
  if (archive) {
    const inside = (await listRemoteEntries(conn, buildFullUrl(conn.url, join(dirSub, archiveDirName)))) ?? [];
    if (inside.some((e) => e.name.toLowerCase() === base.archiveFileName.toLowerCase())) {
      return { ...planned, reason: `「${archiveDirName}」資料夾裡已經有「${base.archiveFileName}」了，舊版沒辦法再放進去（避免蓋掉之前存的舊版）。` };
    }
  }
  return { ...planned, applicable: true };
}

/**
 * 升級版本的上傳（同一個 commit）：
 * 1. old 資料夾（遠端已有就沿用，沒有就新建）；
 * 2. 把 SVN 上「開啟編輯當時的版本」複製進 old（svn copy，保留歷史）；
 * 3. 把編輯好的檔案改名成新版檔名（svn move，保留歷史）；
 * 4. 一起 commit。
 * 中途任何一步失敗，都會把工作副本還原，並把使用者編輯好的內容放回去——絕不能因為升級失敗弄丟編輯。
 */
async function commitWithUpgrade(conn: SvnConnection, session: EditSession, plan: UpgradePlan, message: string): Promise<Buffer> {
  const timeout = longTimeout();
  const newName = plan.newName as string;
  // 舊版程式建立的編輯項目可能記著 8.3 短檔名路徑（svn move 會失敗），這裡一律改用真實長路徑操作
  const wcDir = await realpath(session.wcDir).catch(() => session.wcDir);
  const filePath = path.join(wcDir, session.fileName);
  const oldDirWc = path.join(wcDir, plan.archiveDirName);
  const archivedWc = path.join(oldDirWc, plan.archiveFileName);
  const newWc = path.join(wcDir, newName);
  const backupFile = path.join(session.sessionDir, "upgrade-backup", session.fileName);
  await mkdir(path.dirname(backupFile), { recursive: true });
  await copyFile(session.filePath, backupFile); // 使用者編輯好的內容先備份一份
  try {
    if (plan.archiveDirExists) await runSvn(["update", "--depth", "empty", pegSafe(oldDirWc)], conn, timeout);
    else await runSvn(["mkdir", pegSafe(oldDirWc)], conn, timeout);
    await runSvn(["copy", `${remoteUrlOf(conn, session)}@${session.baseRevision}`, pegSafe(archivedWc)], conn, timeout);
    await runSvn(["move", pegSafe(filePath), pegSafe(newWc)], conn, timeout);
    return await commitWithMessage(conn, message, [wcDir], timeout);
  } catch (e) {
    await runSvn(["revert", "-R", pegSafe(wcDir)], conn, timeout).catch(() => undefined);
    await rm(archivedWc, { force: true }).catch(() => undefined);
    await rm(newWc, { force: true }).catch(() => undefined);
    if (!plan.archiveDirExists) await rm(oldDirWc, { recursive: true, force: true }).catch(() => undefined);
    await chmod(filePath, 0o666).catch(() => undefined);
    await copyFile(backupFile, filePath).catch(() => undefined);
    throw e;
  }
}

export async function commitEdit(id: string, message: string, upgrade?: UpgradeOptions | boolean): Promise<EditCommitResult> {
  const trimmed = typeof message === "string" ? message.trim() : "";
  if (!trimmed) throw new EditError("INVALID_INPUT", "commit message 不能是空的");
  if (trimmed.length > MAX_COMMIT_MESSAGE_LENGTH) throw new EditError("INVALID_INPUT", `commit message 太長（上限 ${MAX_COMMIT_MESSAGE_LENGTH} 字）`);
  const session = await loadSession(id);
  const conn = await resolveConn(session.connectionId);

  return withWcLock(session.wcDir, async () => {
    try {
      const openFiles = await findEditorLockFiles(session.filePath);
      if (openFiles.length > 0) {
        throw new EditError("EDITOR_STILL_OPEN", "Word／Excel 還開著這個檔案，請先存檔並關閉後再上傳。");
      }
      if ((await hashFile(session.filePath)) === session.baseHash) {
        throw new EditError("NO_CHANGES", "檔案內容沒有任何修改，不需要上傳。");
      }
      const remoteRevision = await remoteLastChangedRevision(conn, remoteUrlOf(conn, session));
      if (remoteRevision !== session.baseRevision) {
        throw new EditError(
          "REMOTE_CHANGED",
          `遠端這個檔案在你開啟之後已經被別人更新（你開啟時是 r${session.baseRevision}，現在是 r${remoteRevision}），為避免蓋掉對方的修改，已拒絕上傳。你的修改仍保留在暫存資料夾；可以先下載最新版另存、手動比對後再處理。`
        );
      }

      let plan: UpgradePlan | null = null;
      if (upgrade) {
        plan = await getUpgradePlan(id, typeof upgrade === "object" ? upgrade.newName : undefined);
        if (!plan.applicable || !plan.newName) {
          throw new EditError(/已經有/.test(plan.reason ?? "") ? "ALREADY_EXISTS" : "INVALID_INPUT", plan.reason ?? "這個檔案沒辦法升級版本");
        }
      }
      const stdout = plan ? await commitWithUpgrade(conn, session, plan, trimmed) : await commitWithMessage(conn, trimmed, [session.filePath]);
      const lastLine = stdout.toString("utf-8").trim().split(/\r?\n/).pop() ?? "";
      const revMatch = lastLine.match(/(\d+)\D*$/);
      const committedRevision = revMatch ? Number(revMatch[1]) : null;

      let cleanedUp = true;
      await removeDirWithRetry(session.sessionDir).then((ok) => {
        cleanedUp = ok;
      });
      const upgradeResult = plan
        ? { archivedTo: plan.archivePath as string, renamedTo: plan.newPath as string, newName: plan.newName as string, fromVersion: plan.currentVersion, toVersion: plan.newVersion }
        : undefined;
      await audit({ op: "commit", id, connection: conn.name, path: session.path, committedRevision, ok: true, ...(upgradeResult ? { upgrade: upgradeResult } : {}), ...describeMessage(trimmed) });
      return { committedRevision, path: plan ? (plan.newPath as string) : session.path, cleanedUp, ...(upgradeResult ? { upgrade: upgradeResult } : {}) };
    } catch (e) {
      await audit({ op: "commit", id, connection: conn.name, path: session.path, ok: false, error: e instanceof Error ? e.message : String(e), ...describeMessage(trimmed) });
      throw e;
    }
  });
}

// ---- 放棄 ----

export async function discardEdit(id: string): Promise<{ path: string; cleanedUp: boolean }> {
  const session = await loadSession(id);
  const conn = await resolveConn(session.connectionId);

  return withWcLock(session.wcDir, async () => {
    try {
      if (session.locked) {
        try {
          await runSvn(["unlock", pegSafe(session.filePath)], conn, getSvnTimeoutMs());
        } catch (e) {
          // 鎖已經不在了（被別人用管理權限解開，或前一次放棄做到一半）就不必擋著，其他錯誤才擋
          const remote = await remoteInfo(conn, remoteUrlOf(conn, session)).catch(() => null);
          if (!remote || remote.lockOwner === conn.username) {
            throw new EditError("UNLOCK_FAILED", `解除鎖定失敗，暫存資料夾已保留，請稍後再試：${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
      // 資料夾被別的程式（TortoiseSVN 快取、防毒）短暫鎖住時會自動重試；真的刪不掉也不算放棄失敗（鎖已經解了），改在背景繼續清
      const cleanedUp = await removeDirWithRetry(session.sessionDir);
      await audit({ op: "discard", id, connection: conn.name, path: session.path, ok: true, cleanedUp });
      return { path: session.path, cleanedUp };
    } catch (e) {
      await audit({ op: "discard", id, connection: conn.name, path: session.path, ok: false, error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  });
}

// ---- 暫存資料夾清理 ----

/**
 * 清掉暫存資料夾裡「不再需要」的東西：檢視用的 view-*、批次上傳殘留的 batch-*、以及沒有 session.json 的空殼編輯資料夾
 * （開啟中途失敗留下的）。**絕對不碰有 session.json 的編輯項目**——那是進行中的編輯，程式重開後還要能復原。
 * 同步執行，因為要能在 process.on("exit") 裡呼叫；刪不掉的（例如 PDF 還被閱讀器開著）略過，下次啟動再清。
 */
export function cleanupTransientDirs(): { removed: number } {
  const base = getEditBaseDir();
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    return { removed };
  }
  for (const name of names) {
    const dir = path.join(base, name);
    const transient = name.startsWith(VIEW_DIR_PREFIX) || name.startsWith("batch-") || (SESSION_ID_RE.test(name) && !existsSync(path.join(dir, "session.json")));
    if (!transient) continue;
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      removed++;
    } catch {
      // 檔案被別的程式占用，之後再清
    }
  }
  return { removed };
}

// ---- 唯讀檢視（PDF 等不能編輯的檔案）----

const VIEW_DIR_PREFIX = "view-";
const STALE_VIEW_MS = 24 * 60 * 60 * 1000;

/** 清掉超過一天的檢視暫存資料夾；失敗不影響主流程。 */
async function removeStaleViews(): Promise<void> {
  try {
    const base = getEditBaseDir();
    for (const name of await readdir(base)) {
      if (!name.startsWith(VIEW_DIR_PREFIX)) continue;
      const dir = path.join(base, name);
      const info = await stat(dir).catch(() => null);
      if (info && Date.now() - info.mtimeMs > STALE_VIEW_MS) await rm(dir, { recursive: true, force: true });
    }
  } catch {
    // 沒有暫存資料夾就沒有東西要清
  }
}

/**
 * 把遠端檔案的最新版匯出到暫存資料夾給使用者「看」（不建立編輯項目、不上鎖、不會上傳任何東西）。
 * 只允許 VIEW_EXTENSIONS 內的類型；回傳匯出後的本機路徑，由呼叫端用預設程式開啟。
 */
export async function viewRemoteFile(params: { connectionId?: string; path: unknown }): Promise<{ path: string; revision: number }> {
  const { subPath, fileName } = normalizeRemotePath(params.path, VIEW_EXTENSIONS, "檢視");
  const conn = await resolveConn(params.connectionId);
  const fileUrl = buildFullUrl(conn.url, subPath);
  const info = await remoteInfo(conn, fileUrl);
  if (info.kind !== "file") throw new EditError("INVALID_INPUT", `「${subPath}」不是檔案。`);

  await removeStaleViews();
  const revision = await remoteLastChangedRevision(conn, fileUrl);
  const dir = path.join(getEditBaseDir(), `${VIEW_DIR_PREFIX}${randomUUID()}`);
  const dest = path.join(dir, fileName);
  try {
    await mkdir(dir, { recursive: true });
    await runSvn(["export", "--force", "-r", String(revision), pegUrl(fileUrl), dest], conn, longTimeout());
    const size = (await stat(dest)).size;
    if (size > MAX_FILE_BYTES) {
      throw new EditError("FILE_TOO_LARGE", `檔案太大（${Math.round(size / 1024 / 1024)} MB），上限 ${MAX_FILE_BYTES / 1024 / 1024} MB`);
    }
  } catch (e) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    await audit({ op: "view", connection: conn.name, path: subPath, ok: false, error: e instanceof Error ? e.message : String(e) });
    throw e;
  }
  await audit({ op: "view", connection: conn.name, path: subPath, revision, ok: true });
  return { path: dest, revision };
}

// ---- 衝突時：下載最新版另存 ----

/** 把遠端目前的最新版另存到這個編輯項目的資料夾（不動你正在編輯的檔案），回傳另存的路徑，方便手動比對。 */
export async function exportLatest(id: string): Promise<{ path: string; revision: number }> {
  const session = await loadSession(id);
  const conn = await resolveConn(session.connectionId);
  const fileUrl = remoteUrlOf(conn, session);
  const revision = await remoteLastChangedRevision(conn, fileUrl);
  const dest = path.join(session.sessionDir, `最新版_r${revision}_${session.fileName}`);
  await runSvn(["export", "--force", "-r", String(revision), pegUrl(fileUrl), dest], conn, longTimeout());
  return { path: dest, revision };
}

// ---- 新增檔案到 SVN（svn import）----

/** 新檔案進庫時順便設定的屬性：docx、xlsx 無法合併，設 needs-lock；md、txt 設換行字元為 native。 */
export const IMPORT_AUTO_PROPS: Record<string, string> = {
  docx: "svn:needs-lock=*",
  xlsx: "svn:needs-lock=*",
  xls: "svn:needs-lock=*",
  md: "svn:eol-style=native",
  txt: "svn:eol-style=native",
};

export interface ImportParams {
  connectionId?: string;
  /** 相對於連線 URL 的遠端路徑（中間的資料夾不存在會自動建立）。 */
  path: string;
  content: Buffer;
  message: string;
  ticket?: string;
}

/**
 * 把一份新檔案加進 SVN（不需要本機工作副本）：遠端已有同名檔案就拒絕（不覆蓋，要改既有檔案請走 openEdit）。
 * 內容寫到暫存資料夾後以 `svn import` 一次提交，並依副檔名設定屬性（見 IMPORT_AUTO_PROPS）。
 */
export async function importNewFile(params: ImportParams): Promise<{ committedRevision: number | null; path: string }> {
  const message = typeof params.message === "string" ? params.message.trim() : "";
  if (!message) throw new EditError("INVALID_INPUT", "commit message 不能是空的");
  if (message.length > MAX_COMMIT_MESSAGE_LENGTH) throw new EditError("INVALID_INPUT", `commit message 太長（上限 ${MAX_COMMIT_MESSAGE_LENGTH} 字）`);
  const { subPath, fileName, ext } = normalizeRemotePath(params.path);
  if (!Buffer.isBuffer(params.content) || params.content.length === 0) throw new EditError("INVALID_INPUT", "檔案內容是空的");
  if (params.content.length > MAX_FILE_BYTES) {
    throw new EditError("FILE_TOO_LARGE", `檔案太大（${Math.round(params.content.length / 1024 / 1024)} MB），上限 ${MAX_FILE_BYTES / 1024 / 1024} MB`);
  }
  const conn = await resolveConn(params.connectionId);
  const fileUrl = buildFullUrl(conn.url, subPath);

  const alreadyThere = await remoteInfo(conn, fileUrl).then(() => true, () => false);
  if (alreadyThere) throw new EditError("ALREADY_EXISTS", `遠端已經有「${subPath}」了，不會覆蓋。要修改既有檔案請用「開始編輯」。`);

  await mkdir(getEditBaseDir(), { recursive: true });
  const dir = await mkdtemp(path.join(getEditBaseDir(), "import-"));
  try {
    const localFile = path.join(dir, fileName);
    const messageFile = path.join(dir, ".message.txt");
    await writeFile(localFile, params.content);
    await writeFile(messageFile, message, "utf-8");
    const props = IMPORT_AUTO_PROPS[ext];
    const propArgs = props ? ["--config-option", "config:miscellany:enable-auto-props=yes", "--config-option", `config:auto-props:*.${ext}=${props}`] : [];
    const { stdout } = await runSvn(["import", "--encoding", "UTF-8", "-F", messageFile, ...propArgs, pegSafe(localFile), pegUrl(fileUrl)], conn, longTimeout());
    const revMatch = stdout.toString("utf-8").match(/revision (\d+)/i);
    const committedRevision = revMatch ? Number(revMatch[1]) : null;
    await audit({ op: "import", connection: conn.name, path: subPath, size: params.content.length, committedRevision, ticket: params.ticket?.trim() || null, ok: true, ...describeMessage(message) });
    return { committedRevision, path: subPath };
  } catch (e) {
    await audit({ op: "import", connection: conn.name, path: subPath, ok: false, error: e instanceof Error ? e.message : String(e), ...describeMessage(message) });
    throw e;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ---- 瀏覽遠端目錄（唯讀）----

const MAX_BROWSE_ENTRIES = 1000;

export interface BrowseEntry {
  name: string;
  kind: "dir" | "file";
  /** 是不是 svn-edit 支援編輯的檔案類型（副檔名在白名單內）；資料夾與暫存標記檔一律是 false。 */
  editable: boolean;
  /** 不能編輯、但可以開啟檢視（唯讀）的檔案類型（例如 PDF）。 */
  viewable: boolean;
  /** Word／Excel／LibreOffice 的暫存標記檔（不是文件，可能是被誤提交進 SVN 的）。 */
  tempFile: boolean;
  size: number | null;
  revision: string | null;
  author: string | null;
  date: string | null;
}

export interface BrowseResult {
  connectionId: string;
  connectionName: string;
  /** 相對於連線 URL、以 `/` 分隔的目錄路徑；連線根目錄是空字串。 */
  path: string;
  entries: BrowseEntry[];
  truncated: boolean;
}

/** 列出遠端某個目錄底下的項目（資料夾在前、依名稱排序）。只讀 `svn list`，不會改動任何東西。 */
export async function browseRemote(connectionId: string | undefined, dirPath: string): Promise<BrowseResult> {
  const segments = String(dirPath ?? "").trim().replace(/\\/g, "/").split("/").filter((seg) => seg !== "" && seg !== ".");
  if (segments.some((seg) => seg === "..")) throw new EditError("INVALID_INPUT", `路徑不能包含 ".."：${dirPath}`);
  if (segments.some((seg) => /[<>:"|?*\u0000-\u001f]/.test(seg))) throw new EditError("INVALID_INPUT", `路徑含有不允許的字元（: * ? " < > |）：${dirPath}`);
  const conn = await resolveConn(connectionId);
  const subPath = segments.join("/");
  const result = await svnBrowse(subPath, conn.id);
  if (!result.success) throw new EditError("NOT_FOUND", `讀取遠端目錄失敗：${result.message ?? "未知錯誤"}`);
  const raw = (result.data as { entries: Array<{ name: string; kind: string; size: number | null; revision: string | null; author: string | null; date: string | null }> }).entries;
  const entries: BrowseEntry[] = raw
    .map((e) => {
      const kind: "dir" | "file" = e.kind === "dir" ? "dir" : "file";
      const dot = e.name.lastIndexOf(".");
      const ext = dot > 0 ? e.name.slice(dot + 1).toLowerCase() : "";
      const tempFile = kind === "file" && isEditorTempFile(e.name);
      return { name: e.name, kind, editable: kind === "file" && !tempFile && ALLOWED_EXTENSIONS.has(ext), viewable: kind === "file" && !tempFile && VIEW_EXTENSIONS.has(ext), tempFile, size: e.size, revision: e.revision, author: e.author, date: e.date };
    })
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, "zh-Hant") : a.kind === "dir" ? -1 : 1));
  return { connectionId: conn.id, connectionName: conn.name, path: subPath, entries: entries.slice(0, MAX_BROWSE_ENTRIES), truncated: entries.length > MAX_BROWSE_ENTRIES };
}
