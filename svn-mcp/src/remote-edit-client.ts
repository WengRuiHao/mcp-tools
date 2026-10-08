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
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getSvnTimeoutMs } from "./config-store.js";
import { buildFullUrl, resolveConnection, runSvn, svnBrowse, type SvnConnection } from "./svn-client.js";
import { commitWithMessage, pegSafe, withWcLock } from "./workcopy-client.js";

export const ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set(["docx", "xlsx", "md", "txt"]);
/** 無法自動合併的格式，預設開啟時就上鎖，避免兩個人同時改。 */
export const LOCK_EXTENSIONS: ReadonlySet<string> = new Set(["docx", "xlsx"]);
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_COMMIT_MESSAGE_LENGTH = 4000;
const LONG_OPERATION_TIMEOUT_MULTIPLIER = 10;
/** Word／Excel 是 `~$`，LibreOffice 是 `.~lock.`；暫存資料夾裡只有一個被編輯的檔案，出現這些就代表還開著。 */
const EDITOR_LOCK_PREFIXES = ["~$", ".~lock."];
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
  /** 不指定時依副檔名決定（docx、xlsx 預設上鎖）。 */
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
}

// ---- 路徑、session 儲存 ----

export function getEditBaseDir(): string {
  const configured = process.env.SVN_EDIT_TEMP_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(os.tmpdir(), "svn-edit");
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

async function audit(record: Record<string, unknown>): Promise<void> {
  try {
    const dir = getEditBaseDir();
    await mkdir(dir, { recursive: true });
    await appendFile(path.join(dir, "audit.log"), `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, "utf-8");
  } catch (e) {
    console.error(`[svn-edit] 寫稽核紀錄失敗：${e instanceof Error ? e.message : String(e)}`);
  }
}

function describeMessage(message: string | undefined): Record<string, unknown> {
  return message === undefined ? {} : { messagePreview: message.slice(0, 80), messageLength: message.length };
}

// ---- 輔助 ----

/** 連線解析失敗（沒指定連線而有多個、找不到名稱）是呼叫端的輸入問題，統一轉成 INVALID_INPUT，不要變成 500。 */
async function resolveConn(connectionId?: string): Promise<SvnConnection> {
  try {
    return await resolveConnection(connectionId);
  } catch (e) {
    throw new EditError("INVALID_INPUT", e instanceof Error ? e.message : String(e));
  }
}

function pegUrl(url: string): string {
  return url.includes("@") ? `${url}@` : url;
}

function xmlUnescape(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

async function hashFile(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function longTimeout(): number {
  return getSvnTimeoutMs() * LONG_OPERATION_TIMEOUT_MULTIPLIER;
}

/** 把使用者傳來的路徑整理成 `a/b/c.docx` 形式，並檢查是個允許的檔案類型；跳出連線範圍的寫法由 buildFullUrl 拒絕。 */
function normalizeRemotePath(raw: unknown): { subPath: string; fileName: string; ext: string } {
  if (typeof raw !== "string" || raw.trim() === "") throw new EditError("INVALID_INPUT", "檔案路徑不能是空的");
  const segments = raw.trim().replace(/\\/g, "/").split("/").filter((seg) => seg !== "" && seg !== ".");
  if (segments.length === 0) throw new EditError("INVALID_INPUT", "檔案路徑不能是空的");
  if (segments.some((seg) => seg === "..")) throw new EditError("INVALID_INPUT", `路徑不能包含 ".."：${raw}`);
  // Windows 不允許的字元一律拒絕：同事在 Windows 上取出時會失敗；也擋掉 `file:///x` 被整理成 `file:/x` 繞過完整 URL 檢查的寫法
  if (segments.some((seg) => /[<>:"|?* -]/.test(seg))) {
    throw new EditError("INVALID_INPUT", `路徑含有不允許的字元（: * ? " < > |）：${raw}`);
  }
  const fileName = segments[segments.length - 1];
  const dot = fileName.lastIndexOf(".");
  const ext = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : "";
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new EditError("INVALID_INPUT", `不支援編輯這種檔案（.${ext || "無副檔名"}），目前只支援：${[...ALLOWED_EXTENSIONS].map((e) => `.${e}`).join("、")}`);
  }
  return { subPath: segments.join("/"), fileName, ext };
}

interface RemoteInfo {
  kind: string | null;
  lockOwner: string | null;
}

async function remoteInfo(conn: SvnConnection, fileUrl: string): Promise<RemoteInfo> {
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
    await rm(sessionDir, { recursive: true, force: true }).catch(() => undefined);
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

export async function commitEdit(id: string, message: string): Promise<EditCommitResult> {
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

      const stdout = await commitWithMessage(conn, trimmed, [session.filePath]);
      const lastLine = stdout.toString("utf-8").trim().split(/\r?\n/).pop() ?? "";
      const revMatch = lastLine.match(/(\d+)\D*$/);
      const committedRevision = revMatch ? Number(revMatch[1]) : null;

      let cleanedUp = true;
      await rm(session.sessionDir, { recursive: true, force: true }).catch(() => {
        cleanedUp = false;
      });
      await audit({ op: "commit", id, connection: conn.name, path: session.path, committedRevision, ok: true, ...describeMessage(trimmed) });
      return { committedRevision, path: session.path, cleanedUp };
    } catch (e) {
      await audit({ op: "commit", id, connection: conn.name, path: session.path, ok: false, error: e instanceof Error ? e.message : String(e), ...describeMessage(trimmed) });
      throw e;
    }
  });
}

// ---- 放棄 ----

export async function discardEdit(id: string): Promise<{ path: string }> {
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
      await rm(session.sessionDir, { recursive: true, force: true });
      await audit({ op: "discard", id, connection: conn.name, path: session.path, ok: true });
      return { path: session.path };
    } catch (e) {
      await audit({ op: "discard", id, connection: conn.name, path: session.path, ok: false, error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  });
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
const IMPORT_AUTO_PROPS: Record<string, string> = {
  docx: "svn:needs-lock=*",
  xlsx: "svn:needs-lock=*",
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
  /** 是不是 svn-edit 支援編輯的檔案類型（副檔名在白名單內）；資料夾一律是 false。 */
  editable: boolean;
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
      return { name: e.name, kind, editable: kind === "file" && ALLOWED_EXTENSIONS.has(ext), size: e.size, revision: e.revision, author: e.author, date: e.date };
    })
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, "zh-Hant") : a.kind === "dir" ? -1 : 1));
  return { connectionId: conn.id, connectionName: conn.name, path: subPath, entries: entries.slice(0, MAX_BROWSE_ENTRIES), truncated: entries.length > MAX_BROWSE_ENTRIES };
}
