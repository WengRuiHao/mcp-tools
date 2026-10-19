/**
 * 批次上傳：一次把多個檔案、甚至整個本機資料夾放進 SVN 指定的目錄，只產生「一個」commit。
 *
 * **跟 remote-edit-client 一樣刻意不註冊成 MCP 工具**——只給 `svn-edit`（使用者在網頁上按按鈕）呼叫。
 *
 * 流程（網頁一個檔案一個檔案送，避免單一請求太大）：
 *   startImportBatch → stageImportFile（每個檔案一次，保留相對路徑）→ planImport（預覽哪些是新增、哪些會覆蓋）
 *   → commitImport（真的送出）／cancelImport（放棄並清掉暫存）。
 *
 * 同名檔案的處理：遠端已經有的檔案會更新成新版本（SVN 有歷史可還原），內容完全相同的不會產生變更。
 * 做法是只 checkout 「目標目錄的最近一個已存在祖先」（depth empty），再把要覆蓋的檔案與它們所在的目錄逐一 update 進來，
 * 其餘遠端內容不會被抓下來，所以目標目錄再大也不影響速度。
 *
 * 安全邊界：所有路徑拒絕 `..`、完整 URL、Windows 不允許的字元；Office 暫存檔、系統檔、.git／.svn 資料夾一律拒絕；
 * 單檔、總量、檔案數都有上限；commit 一定要有非空訊息。
 */
import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { getLongSvnTimeoutMs, getSvnTimeoutMs } from "./config-store.js";
import { buildFullUrl, runSvn, type SvnConnection } from "./svn-client.js";
import { removeDirWithRetry } from "./temp-clean.js";
import { commitWithMessage, pegSafe } from "./workcopy-client.js";
import {
  audit,
  describeMessage,
  EditError,
  getEditBaseDir,
  IMPORT_AUTO_PROPS,
  isEditorTempFile,
  MAX_COMMIT_MESSAGE_LENGTH,
  MAX_FILE_BYTES,
  pegUrl,
  resolveConn,
  xmlUnescape,
} from "./remote-edit-client.js";
import { errorMessage } from "./util.js";
import { parseRevision } from "./util.js";

export const MAX_BATCH_FILES = 300000;
export const MAX_BATCH_BYTES = 4 * 1024 * 1024 * 1024;
/** 批次裡 svn add／status／update／commit 的輸出緩衝上限：十萬個檔案時 svn 會逐檔印一行，預設的 50 MB 不夠。 */
const BATCH_MAX_BUFFER = 512 * 1024 * 1024;
const STALE_BATCH_MS = 24 * 60 * 60 * 1000;
/** `svn update` 一次帶的路徑數量上限，避免超過 Windows 命令列長度限制。 */
const SVN_ARG_CHUNK = 40;
const BATCH_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BATCH_DIR_PREFIX = "batch-";
const FORBIDDEN_CHARS_RE = /[<>:"|?*\u0000-\u001f]/;
/** 不放進 SVN 的資料夾與系統檔（網頁端也用同一份規則預先略過）。 */
const EXCLUDED_DIR_NAMES: ReadonlySet<string> = new Set([".svn", ".git", ".hg"]);
const EXCLUDED_FILE_NAMES: ReadonlySet<string> = new Set(["thumbs.db", "desktop.ini", ".ds_store"]);

/** 批次上傳的逾時：基本逾時之外，每個檔案多給 1 秒、每 MB 多給 5 秒，上限 24 小時（svn 對每個檔案都有固定開銷；實測約 2400 個檔案要 20 分鐘左右，所以每個檔案抓 0.6 秒）。 */
const MAX_BATCH_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export function batchTimeoutMs(baseMs: number, files: number, bytes: number): number {
  return Math.round(Math.min(MAX_BATCH_TIMEOUT_MS, Math.max(baseMs, baseMs + files * 600 + (bytes / (1024 * 1024)) * 5000)));
}

/** 遠端時間比本機檔案新超過這個誤差，才算「遠端較新」（容許兩邊時鐘與時間精度的小差異）。 */
const REMOTE_NEWER_TOLERANCE_MS = 60_000;

export interface OverwriteDetail {
  /** 相對於目標目錄。 */
  path: string;
  remoteRevision: number | null;
  remoteAuthor: string | null;
  /** 遠端這個檔案最後一次被修改的時間（ISO 8601）。 */
  remoteDate: string | null;
  /** 使用者本機檔案的最後修改時間（ISO 8601）；網頁沒有提供時是 null。 */
  localModified: string | null;
  /** 遠端比本機檔案新：可能是別人在你修改這份檔案期間已經更新過，直接覆蓋會蓋掉對方的修改。 */
  remoteNewer: boolean;
}

interface RemoteEntry {
  isDir: boolean;
  revision: number | null;
  author: string | null;
  date: string | null;
}

export interface ImportPlan {
  /** 目標目錄（相對於連線 URL，空字串代表連線根目錄）。 */
  targetDir: string;
  /** 遠端還沒有、會新增的檔案（相對於目標目錄）。 */
  add: string[];
  /** 遠端已經有、會更新成新版本的檔案（相對於目標目錄）。 */
  overwrite: string[];
  /** 每個會被覆蓋的檔案的遠端現況，以及遠端是否比使用者的本機檔案新。 */
  overwriteDetails: OverwriteDetail[];
  totalFiles: number;
  totalBytes: number;
}

export interface ImportBatchResult {
  committedRevision: number | null;
  targetDir: string;
  added: number;
  modified: number;
  /** 遠端已有同名檔案但內容完全一樣，所以沒有變更。 */
  unchanged: number;
}

interface StagedFile {
  rel: string;
  abs: string;
  size: number;
}

// ---- 路徑檢查 ----

function splitSegments(raw: unknown, what: string): string[] {
  if (typeof raw !== "string") throw new EditError("INVALID_INPUT", `${what}格式不正確`);
  const segments = raw.trim().replace(/\\/g, "/").split("/").filter((seg) => seg !== "" && seg !== ".");
  if (segments.some((seg) => seg === "..")) throw new EditError("INVALID_INPUT", `${what}不能包含 ".."：${raw}`);
  // 也擋掉 `file:///x` 被整理成 `file:/x` 繞過完整 URL 檢查的寫法
  if (segments.some((seg) => FORBIDDEN_CHARS_RE.test(seg))) {
    throw new EditError("INVALID_INPUT", `${what}含有不允許的字元（: * ? " < > |）：${raw}`);
  }
  return segments;
}

/** 目標目錄：允許空字串（連線根目錄）；還不存在的資料夾會在上傳時自動建立。 */
export function normalizeTargetDir(raw: unknown): string {
  return splitSegments(raw ?? "", "目標資料夾").join("/");
}

/** 這個檔名／資料夾名是不是不該放進 SVN（暫存檔、系統檔、版本控制資料夾）。 */
export function isExcludedName(name: string, isDir: boolean): boolean {
  const lower = name.toLowerCase();
  if (isDir) return EXCLUDED_DIR_NAMES.has(lower);
  return isEditorTempFile(name) || EXCLUDED_FILE_NAMES.has(lower);
}

function normalizeBatchFilePath(raw: unknown): string {
  const segments = splitSegments(raw, "檔案路徑");
  if (segments.length === 0) throw new EditError("INVALID_INPUT", "檔案路徑不能是空的");
  segments.forEach((seg, i) => {
    if (isExcludedName(seg, i < segments.length - 1)) {
      throw new EditError("INVALID_INPUT", `「${segments.join("/")}」是暫存檔、系統檔或版本控制資料夾（${seg}），不能上傳。`);
    }
  });
  return segments.join("/");
}

// ---- 暫存區 ----

/** 每個批次已收到的檔案（相對路徑 → 大小）。收檔時只查這張表，不必每次掃整個暫存資料夾（上千個檔案時會很慢）。 */
const stagedSizes = new Map<string, Map<string, number>>();
/** 每個批次裡各檔案在使用者電腦上的最後修改時間（毫秒）；比對「遠端是否比本機新」用。只存在記憶體，程式重開就沒有（視為不知道）。 */
const stagedMtimes = new Map<string, Map<string, number>>();
/** 每個批次已收到的總位元組數（累計著，收檔案時不用每次掃整張表——十萬個檔案時會變成 O(n²)）。 */
const stagedTotals = new Map<string, number>();

function assertBatchId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !BATCH_ID_RE.test(id)) throw new EditError("INVALID_INPUT", "上傳批次 id 格式不正確");
}

function batchDirOf(id: string): string {
  return path.join(getEditBaseDir(), `${BATCH_DIR_PREFIX}${id}`);
}

function filesDirOf(id: string): string {
  return path.join(batchDirOf(id), "files");
}

async function requireBatch(id: unknown): Promise<string> {
  assertBatchId(id);
  const dir = batchDirOf(id);
  if (!(await stat(dir).then((s) => s.isDirectory(), () => false))) {
    throw new EditError("NOT_FOUND", "找不到這次上傳的暫存資料（可能已經上傳、取消或過期），請重新選擇檔案。");
  }
  return id;
}

/** 清掉超過一天的殘留批次（程式當機、使用者關掉網頁沒取消）。失敗不影響主流程。 */
async function removeStaleBatches(): Promise<void> {
  try {
    const base = getEditBaseDir();
    for (const name of await readdir(base)) {
      if (!name.startsWith(BATCH_DIR_PREFIX)) continue;
      const dir = path.join(base, name);
      const info = await stat(dir).catch(() => null);
      if (info && Date.now() - info.mtimeMs > STALE_BATCH_MS) await rm(dir, { recursive: true, force: true });
    }
  } catch {
    // 沒有暫存資料夾或讀不到，就沒有東西要清
  }
}

async function listStaged(filesDir: string, rel = ""): Promise<StagedFile[]> {
  const out: StagedFile[] = [];
  for (const entry of await readdir(path.join(filesDir, rel), { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listStaged(filesDir, childRel)));
    else if (entry.isFile()) out.push({ rel: childRel, abs: path.join(filesDir, childRel), size: (await stat(path.join(filesDir, childRel))).size });
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

export async function startImportBatch(): Promise<{ batch: string }> {
  await removeStaleBatches();
  const id = randomUUID();
  await mkdir(filesDirOf(id), { recursive: true });
  stagedSizes.set(id, new Map());
  stagedMtimes.set(id, new Map());
  return { batch: id };
}

/** 收一個檔案進暫存區（`relPath` 保留使用者資料夾裡的相對路徑）；同一路徑重送會覆蓋。 */
export async function stageImportFile(batch: unknown, relPath: unknown, content: Buffer, localMtimeMs?: number): Promise<{ path: string; size: number }> {
  const id = await requireBatch(batch);
  const rel = normalizeBatchFilePath(relPath);
  if (!Buffer.isBuffer(content) || content.length === 0) throw new EditError("INVALID_INPUT", `「${rel}」是空檔案，SVN 不接受上傳空檔案。`);
  if (content.length > MAX_FILE_BYTES) {
    throw new EditError("FILE_TOO_LARGE", `「${rel}」太大（${Math.round(content.length / 1024 / 1024)} MB），單一檔案上限 ${MAX_FILE_BYTES / 1024 / 1024} MB`);
  }
  const filesDir = filesDirOf(id);
  // 程式重開後還留著的舊批次：第一次用到時掃一次補回計數表
  let sizes = stagedSizes.get(id);
  if (!sizes) {
    sizes = new Map((await listStaged(filesDir)).map((f) => [f.rel, f.size] as [string, number]));
    stagedSizes.set(id, sizes);
  }
  const othersCount = sizes.has(rel) ? sizes.size - 1 : sizes.size;
  let total = stagedTotals.get(id);
  if (total === undefined) {
    total = 0;
    for (const size of sizes.values()) total += size;
  }
  const othersBytes = total - (sizes.get(rel) ?? 0);
  if (othersCount + 1 > MAX_BATCH_FILES) throw new EditError("INVALID_INPUT", `一次最多上傳 ${MAX_BATCH_FILES} 個檔案`);
  if (othersBytes + content.length > MAX_BATCH_BYTES) {
    throw new EditError("FILE_TOO_LARGE", `一次上傳的總大小上限 ${MAX_BATCH_BYTES / 1024 / 1024} MB`);
  }
  sizes.set(rel, content.length);
  stagedTotals.set(id, othersBytes + content.length);
  if (typeof localMtimeMs === "number" && Number.isFinite(localMtimeMs) && localMtimeMs > 0) {
    const mtimes = stagedMtimes.get(id) ?? new Map<string, number>();
    mtimes.set(rel, localMtimeMs);
    stagedMtimes.set(id, mtimes);
  }
  const dest = path.join(filesDir, ...rel.split("/"));
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, content);
  return { path: rel, size: content.length };
}

export async function cancelImport(batch: unknown): Promise<{ cancelled: true }> {
  assertBatchId(batch);
  stagedSizes.delete(batch);
  stagedMtimes.delete(batch);
  stagedTotals.delete(batch);
  await removeDirWithRetry(batchDirOf(batch));
  return { cancelled: true };
}

// ---- 遠端比對 ----

const MISSING_PATTERN = /E170000|E160013|E200009|non-existent|doesn't exist|does not exist|path not found|not found/i;

/** 列出遠端某個目錄的項目（名稱 → 型別與最後修改資訊）；目錄不存在回傳 null，其他錯誤（連線、權限）照實拋出。 */
async function listRemoteDir(conn: SvnConnection, dirSubPath: string): Promise<Map<string, RemoteEntry> | null> {
  const url = buildFullUrl(conn.url, dirSubPath);
  try {
    // 一定要用 --xml：純文字輸出在 Windows 是系統字碼頁（不是 UTF-8），中文檔名會變亂碼
    const { stdout } = await runSvn(["list", "--xml", pegUrl(url)], conn, getSvnTimeoutMs());
    const entries = new Map<string, RemoteEntry>();
    for (const m of stdout.toString("utf-8").matchAll(/<entry\s+kind="(file|dir)">([\s\S]*?)<\/entry>/g)) {
      const name = /<name>([^<]*)<\/name>/.exec(m[2]);
      if (!name) continue;
      const revision = /<commit\s+revision="(\d+)"/.exec(m[2]);
      const author = /<author>([^<]*)<\/author>/.exec(m[2]);
      const date = /<date>([^<]*)<\/date>/.exec(m[2]);
      entries.set(xmlUnescape(name[1]), {
        isDir: m[1] === "dir",
        revision: revision ? Number(revision[1]) : null,
        author: author ? xmlUnescape(author[1]) : null,
        date: date ? date[1] : null,
      });
    }
    return entries;
  } catch (e) {
    const message = errorMessage(e);
    if (MISSING_PATTERN.test(message)) return null;
    throw new EditError("NOT_FOUND", `讀取遠端目錄失敗：${message}`);
  }
}

function dirnameOf(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i < 0 ? "" : rel.slice(0, i);
}

function joinRemote(targetDir: string, rel: string): string {
  return targetDir ? (rel ? `${targetDir}/${rel}` : targetDir) : rel;
}

interface Classified {
  plan: ImportPlan;
  staged: StagedFile[];
  /** 遠端已存在的資料夾（相對於連線 URL）。 */
  existingDirs: string[];
}

/** 整理一個會被覆蓋的檔案：遠端最後修改資訊，以及遠端是否比使用者的本機檔案新。 */
function describeOverwrite(rel: string, remote: RemoteEntry, localMtimeMs: number | undefined): OverwriteDetail {
  const remoteMs = remote.date ? Date.parse(remote.date) : NaN;
  const hasLocal = typeof localMtimeMs === "number" && Number.isFinite(localMtimeMs);
  return {
    path: rel,
    remoteRevision: remote.revision,
    remoteAuthor: remote.author,
    remoteDate: remote.date,
    localModified: hasLocal ? new Date(localMtimeMs).toISOString() : null,
    remoteNewer: hasLocal && Number.isFinite(remoteMs) && remoteMs > (localMtimeMs as number) + REMOTE_NEWER_TOLERANCE_MS,
  };
}

/** 比對暫存的檔案跟遠端現況：哪些新增、哪些覆蓋；路徑型別衝突（遠端是資料夾卻要放檔案，或反過來）直接拒絕。 */
async function classify(conn: SvnConnection, batchId: string, targetDirRaw: unknown): Promise<Classified> {
  const targetDir = normalizeTargetDir(targetDirRaw);
  const staged = await listStaged(filesDirOf(batchId));
  if (staged.length === 0) throw new EditError("INVALID_INPUT", "還沒有選擇任何要上傳的檔案。");

  // 由淺到深逐層列出遠端目錄；某一層不存在，底下整棵都不用再問
  const remoteDirs = [...new Set(staged.map((f) => joinRemote(targetDir, dirnameOf(f.rel))))].sort((a, b) => a.split("/").length - b.split("/").length);
  const listings = new Map<string, Map<string, RemoteEntry> | null>();
  const missingRoots: string[] = [];
  for (const dir of remoteDirs) {
    if (missingRoots.some((m) => dir === m || dir.startsWith(`${m}/`))) {
      listings.set(dir, null);
      continue;
    }
    const listing = await listRemoteDir(conn, dir);
    listings.set(dir, listing);
    if (listing === null) missingRoots.push(dir);
  }

  const add: string[] = [];
  const overwrite: string[] = [];
  const overwriteDetails: OverwriteDetail[] = [];
  const conflicts: string[] = [];
  const mtimes = stagedMtimes.get(batchId);
  for (const file of staged) {
    const dir = joinRemote(targetDir, dirnameOf(file.rel));
    const name = file.rel.slice(file.rel.lastIndexOf("/") + 1);
    const listing = listings.get(dir);
    const remote = listing?.get(name);
    if (remote?.isDir) conflicts.push(`${file.rel}（遠端同名的是資料夾）`);
    else if (remote) {
      overwrite.push(file.rel);
      overwriteDetails.push(describeOverwrite(file.rel, remote, mtimes?.get(file.rel)));
    } else add.push(file.rel);
  }
  if (conflicts.length > 0) {
    throw new EditError("INVALID_INPUT", `遠端已有同名的資料夾，無法上傳：\n${[...new Set(conflicts)].slice(0, 10).join("\n")}`);
  }

  const existingDirs = [...listings.entries()].filter(([, listing]) => listing !== null).map(([dir]) => dir);
  return {
    plan: { targetDir, add, overwrite, overwriteDetails, totalFiles: staged.length, totalBytes: staged.reduce((sum, f) => sum + f.size, 0) },
    staged,
    existingDirs,
  };
}

export async function planImport(params: { batch: unknown; connectionId?: string; targetDir: unknown }): Promise<ImportPlan> {
  const id = await requireBatch(params.batch);
  const conn = await resolveConn(params.connectionId);
  return (await classify(conn, id, params.targetDir)).plan;
}

// ---- 送出 ----

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** 目標目錄由淺到深，找出遠端已經存在的最深一層（連線根目錄一定存在）。 */
async function deepestExistingDir(conn: SvnConnection, targetDir: string, known: Set<string>): Promise<string> {
  const segments = targetDir.split("/").filter(Boolean);
  for (let n = segments.length; n > 0; n--) {
    const candidate = segments.slice(0, n).join("/");
    if (known.has(candidate) || (await listRemoteDir(conn, candidate)) !== null) return candidate;
  }
  return "";
}

/** 新檔案進庫時的自動屬性：只放 needs-lock（docx、xlsx 無法合併）；eol-style 另外盡力設定，見 applyEolStyle。 */
function autoPropArgs(files: string[]): string[] {
  const exts = [...new Set(files.map((f) => f.slice(f.lastIndexOf(".") + 1).toLowerCase()).filter((e) => IMPORT_AUTO_PROPS[e]?.startsWith("svn:needs-lock")))];
  if (exts.length === 0) return [];
  return ["--config-option", "config:miscellany:enable-auto-props=yes", ...exts.flatMap((e) => ["--config-option", `config:auto-props:*.${e}=${IMPORT_AUTO_PROPS[e]}`])];
}

/** `svn status --xml` 裡內容有變（modified／replaced）的路徑（正規化成小寫絕對路徑）。 */
function modifiedPaths(statusXml: string): Set<string> {
  const out = new Set<string>();
  for (const m of statusXml.matchAll(/<entry\s+path="([^"]*)">\s*<wc-status\s+([^>]*)>/g)) {
    const item = /item="([^"]+)"/.exec(m[2])?.[1];
    if (item === "modified" || item === "replaced") out.add(path.resolve(xmlUnescape(m[1])).toLowerCase());
  }
  return out;
}

/**
 * 新檔案的換行字元屬性（md、txt 設 eol-style=native）：盡力而為。SVN 會把「小而全是中文」的文字檔誤判成二進位，
 * 對它設 eol-style 會報錯；這種屬性不該讓整批上傳失敗，所以設不上就略過。
 */
async function applyEolStyle(conn: SvnConnection, wcPaths: string[], timeout: number): Promise<void> {
  const targets = wcPaths.filter((p) => /\.(md|txt)$/i.test(p));
  for (const group of chunk(targets, SVN_ARG_CHUNK)) {
    try {
      await runSvn(["propset", "svn:eol-style", "native", ...group.map(pegSafe)], conn, timeout);
    } catch {
      for (const one of group) await runSvn(["propset", "svn:eol-style", "native", pegSafe(one)], conn, timeout).catch(() => undefined);
    }
  }
}

export async function commitImport(params: { batch: unknown; connectionId?: string; targetDir: unknown; message: unknown; ticket?: string }): Promise<ImportBatchResult> {
  const message = typeof params.message === "string" ? params.message.trim() : "";
  if (!message) throw new EditError("INVALID_INPUT", "commit message 不能是空的");
  if (message.length > MAX_COMMIT_MESSAGE_LENGTH) throw new EditError("INVALID_INPUT", `commit message 太長（上限 ${MAX_COMMIT_MESSAGE_LENGTH} 字）`);
  const id = await requireBatch(params.batch);
  const conn = await resolveConn(params.connectionId);
  const { plan, staged, existingDirs } = await classify(conn, id, params.targetDir);

  const wcDir = path.join(batchDirOf(id), "wc");
  const timeout = batchTimeoutMs(getLongSvnTimeoutMs(), plan.totalFiles, plan.totalBytes);
  try {
    await removeDirWithRetry(wcDir);
    const anchor = await deepestExistingDir(conn, plan.targetDir, new Set(existingDirs));
    await runSvn(["checkout", "--depth", "empty", pegUrl(buildFullUrl(conn.url, anchor)), wcDir], conn, timeout);
    const wcPathOf = (remoteRel: string): string => path.join(wcDir, ...(anchor ? remoteRel.slice(anchor.length).split("/") : remoteRel.split("/")).filter(Boolean));

    // 遠端已存在、而這次有檔案要放進去的資料夾：先讓它們在工作副本裡成為「已納管的資料夾」，新檔案才不會跟遠端現有資料夾衝突
    const dirsToPull = existingDirs.filter((d) => d !== anchor && (anchor === "" || d.startsWith(`${anchor}/`)));
    for (const group of chunk(dirsToPull.map(wcPathOf), SVN_ARG_CHUNK)) {
      await runSvn(["update", "--parents", "--depth", "empty", ...group.map(pegSafe)], conn, timeout);
    }
    // 要覆蓋的檔案：把遠端現有版本取下來
    const overwriteWcPaths = plan.overwrite.map((rel) => wcPathOf(joinRemote(plan.targetDir, rel)));
    for (const group of chunk(overwriteWcPaths, SVN_ARG_CHUNK)) {
      await runSvn(["update", "--parents", ...group.map(pegSafe)], conn, timeout, undefined, BATCH_MAX_BUFFER);
    }

    // 內容寫進工作副本（needs-lock 的檔案取下來是唯讀，先解除唯讀）
    const overwriteSet = new Set(plan.overwrite);
    for (const file of staged) {
      const dest = wcPathOf(joinRemote(plan.targetDir, file.rel));
      await mkdir(path.dirname(dest), { recursive: true });
      if (overwriteSet.has(file.rel)) await chmod(dest, 0o666).catch(() => undefined);
      await copyFile(file.abs, dest);
    }

    // 新增的項目：--no-ignore 避免使用者電腦的 global-ignores 悄悄吃掉檔案
    await runSvn(["add", "--force", "--no-ignore", "--depth", "infinity", ...autoPropArgs(plan.add), pegSafe(wcDir)], conn, timeout, undefined, BATCH_MAX_BUFFER);
    await applyEolStyle(conn, plan.add.map((rel) => wcPathOf(joinRemote(plan.targetDir, rel))), timeout);

    const { stdout: statusOut } = await runSvn(["status", "--xml", pegSafe(wcDir)], conn, timeout, undefined, BATCH_MAX_BUFFER);
    const statusText = statusOut.toString("utf-8");
    const changed = modifiedPaths(statusText);
    const modified = overwriteWcPaths.filter((p) => changed.has(path.resolve(p).toLowerCase())).length;
    const unchanged = plan.overwrite.length - modified;
    if (plan.add.length === 0 && modified === 0) {
      throw new EditError("NO_CHANGES", "這些檔案的內容跟 SVN 上完全一樣，不需要上傳。");
    }

    let stdout: Buffer;
    try {
      stdout = await commitWithMessage(conn, message, [wcDir], timeout, BATCH_MAX_BUFFER);
    } catch (e) {
      const text = errorMessage(e);
      if (/E160039|is locked by|locked by user/i.test(text)) {
        throw new EditError("FILE_LOCKED", `有檔案正被別人鎖定編輯中，無法覆蓋，請等對方解鎖後再試：\n${text}`);
      }
      throw e;
    }
    const committedRevision = parseRevision(stdout);
    const result: ImportBatchResult = { committedRevision, targetDir: plan.targetDir, added: plan.add.length, modified, unchanged };
    await audit({ op: "import-batch", connection: conn.name, files: staged.length, ...result, ticket: params.ticket?.trim() || null, ok: true, ...describeMessage(message) });
    stagedSizes.delete(id);
    stagedMtimes.delete(id);
    stagedTotals.delete(id);
    await removeDirWithRetry(batchDirOf(id));
    return result;
  } catch (e) {
    // 失敗時只清掉工作副本，保留已上傳的暫存檔，使用者修正問題後可以直接重試，不必重新選檔案
    await removeDirWithRetry(wcDir);
    await audit({ op: "import-batch", connection: conn.name, targetDir: plan.targetDir, files: staged.length, ok: false, error: errorMessage(e), ...describeMessage(message) });
    throw e;
  }
}
