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
import { chmod, copyFile, link, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { getLongSvnTimeoutMs, getSvnTimeoutMs } from "./config-store.js";
import { buildFullUrl, runSvn, type SvnConnection } from "./svn-client.js";
import { removeDirWithRetry } from "./temp-clean.js";
import { buildMuccArgsFile, findSvnmucc, isAscii, MuccUnavailableError, prepareNativeEol, runMucc, systemMessageEncoder, type MuccPut } from "./mucc-import.js";
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
/** 一次 svn 指令帶的路徑總長度上限（Windows 命令列上限約 32K 字元，留餘地給其他參數）。 */
const SVN_ARG_MAX_CHARS = 24_000;
/** 一次 svn 指令帶的路徑數量上限。以前固定 40 個太小：六萬個檔案要呼叫上千次 svn，每次啟動都要等。 */
const SVN_ARG_MAX_COUNT = 500;
/** 同時複製幾個檔案進工作副本。 */
const COPY_PARALLEL = 16;
/** 要比對的遠端資料夾超過這個數量，就改用「一次遞迴列出整棵目錄」取代「一個資料夾問一次」。 */
const DEFAULT_RECURSIVE_LIST_MIN_DIRS = 30;
/** 工作副本被別的程式（TortoiseSVN 的狀態快取、防毒軟體）短暫鎖住（E200033）時，等一下重試；檔案越多被掃描得越久，越容易撞到。 */
const DB_LOCK_RETRY_DELAYS_MS: readonly number[] = [3_000, 6_000, 12_000, 24_000, 48_000];
const DB_LOCK_RE = /E200033|database is locked/i;
/** 正在送出（commit）中的批次：這時候不能再送一次、也不能取消（取消會把正在使用的工作副本刪掉）。 */
const committingBatches = new Set<string>();
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
  /** 用哪種方式送出：mucc＝全部都是新檔案，用 svnmucc 一次送出（沒有工作副本，快很多）；wc＝工作副本。 */
  method: "mucc" | "wc";
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

const nameCollator = new Intl.Collator();

/**
 * 這個批次收到的檔案清單。這個行程收的檔案，大小早就記在記憶體的計數表裡，直接用，不必重新掃描暫存資料夾、
 * 對六萬個檔案各 stat 一次（那一步以前每次預覽與送出各做一遍）；程式重開後才退回掃描。
 */
async function stagedFilesOf(id: string): Promise<StagedFile[]> {
  const sizes = stagedSizes.get(id);
  if (!sizes || sizes.size === 0) return listStaged(filesDirOf(id));
  const filesDir = filesDirOf(id);
  return [...sizes.entries()].map(([rel, size]) => ({ rel, abs: path.join(filesDir, ...rel.split("/")), size })).sort((a, b) => nameCollator.compare(a.rel, b.rel));
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
  const dest = path.join(filesDir, ...rel.split("/"));
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, content);
  // 檔案真的寫好之後才登記：寫入失敗時，計數表不會有「其實不存在的檔案」，之後送出才不會複製不到
  sizes.set(rel, content.length);
  stagedTotals.set(id, othersBytes + content.length);
  if (typeof localMtimeMs === "number" && Number.isFinite(localMtimeMs) && localMtimeMs > 0) {
    const mtimes = stagedMtimes.get(id) ?? new Map<string, number>();
    mtimes.set(rel, localMtimeMs);
    stagedMtimes.set(id, mtimes);
  }
  return { path: rel, size: content.length };
}

export async function cancelImport(batch: unknown): Promise<{ cancelled: true }> {
  assertBatchId(batch);
  if (committingBatches.has(batch)) throw new EditError("ALREADY_EDITING", "這批檔案正在送出到 SVN，現在不能取消（取消會把正在使用的工作副本刪掉）。請等它完成或失敗。");
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
    for (const { name, entry } of parseListEntries(stdout.toString("utf-8"))) entries.set(name, entry);
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

/** `svn list --xml` 的輸出整理成「名稱 → 型別與最後修改資訊」。遞迴列出（-R）時名稱是相對路徑。 */
function parseListEntries(xml: string): Array<{ name: string; entry: RemoteEntry }> {
  const out: Array<{ name: string; entry: RemoteEntry }> = [];
  for (const m of xml.matchAll(/<entry\s+kind="(file|dir)">([\s\S]*?)<\/entry>/g)) {
    const name = /<name>([^<]*)<\/name>/.exec(m[2]);
    if (!name) continue;
    const revision = /<commit\s+revision="(\d+)"/.exec(m[2]);
    const author = /<author>([^<]*)<\/author>/.exec(m[2]);
    const date = /<date>([^<]*)<\/date>/.exec(m[2]);
    out.push({
      name: xmlUnescape(name[1]),
      entry: { isDir: m[1] === "dir", revision: revision ? Number(revision[1]) : null, author: author ? xmlUnescape(author[1]) : null, date: date ? date[1] : null },
    });
  }
  return out;
}

type Listings = Map<string, Map<string, RemoteEntry> | null>;

/** 由淺到深逐層列出遠端目錄；某一層不存在，底下整棵都不用再問。 */
async function listDirsOneByOne(conn: SvnConnection, remoteDirs: string[]): Promise<Listings> {
  const listings: Listings = new Map();
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
  return listings;
}

/** 這些資料夾共同的最深一層（沒有共同的就是空字串＝連線根目錄）。 */
function commonDirOf(dirs: string[]): string {
  if (dirs.length === 0) return "";
  const split = dirs.map((d) => d.split("/").filter(Boolean));
  const first = split[0];
  let n = first.length;
  for (const parts of split) {
    let i = 0;
    while (i < n && i < parts.length && parts[i] === first[i]) i++;
    n = i;
  }
  return first.slice(0, n).join("/");
}

interface LoadedListings {
  listings: Listings;
  /** 用「一次遞迴列出」時的根目錄（涵蓋整棵）；逐層列出時是 null。 */
  treeRoot: string | null;
}

/**
 * 資料夾很多時（上傳整個專案原始碼，動輒幾千個資料夾），「一個資料夾問一次 svn」太慢：
 * 改成對「最深的共同遠端目錄」一次遞迴列出整棵，再分給各個資料夾。整棵都放進回傳的表裡（不只是要放檔案的資料夾），
 * 之後判斷中間層資料夾存不存在也用得到。
 * 回傳 null＝不適合用這個做法（共同目錄就是連線根目錄，整個專案庫列一遍太大）。
 */
async function listDirsRecursive(conn: SvnConnection, remoteDirs: string[]): Promise<LoadedListings | null> {
  const root = await deepestExistingDir(conn, commonDirOf(remoteDirs), new Set());
  if (root === "") return null;
  const { stdout } = await runSvn(["list", "-R", "--xml", pegUrl(buildFullUrl(conn.url, root))], conn, getLongSvnTimeoutMs(), undefined, BATCH_MAX_BUFFER);
  const tree = new Map<string, Map<string, RemoteEntry>>([[root, new Map()]]);
  for (const { name, entry } of parseListEntries(stdout.toString("utf-8"))) {
    const full = joinRemote(root, name);
    const parentDir = dirnameOf(full);
    let parent = tree.get(parentDir);
    if (!parent) tree.set(parentDir, (parent = new Map()));
    parent.set(full.slice(full.lastIndexOf("/") + 1), entry);
    if (entry.isDir && !tree.has(full)) tree.set(full, new Map());
  }
  const listings: Listings = new Map<string, Map<string, RemoteEntry> | null>(tree);
  for (const dir of remoteDirs) if (!listings.has(dir)) listings.set(dir, null);
  return { listings, treeRoot: root };
}

function recursiveListMinDirs(): number {
  const n = Number(process.env.SVN_EDIT_RECURSIVE_LIST_MIN_DIRS);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_RECURSIVE_LIST_MIN_DIRS;
}

/** 取得每個要放檔案的遠端資料夾現況：資料夾多就一次遞迴列出，否則（或遞迴失敗）逐層問。 */
async function loadListings(conn: SvnConnection, remoteDirs: string[]): Promise<LoadedListings> {
  if (remoteDirs.length > recursiveListMinDirs()) {
    try {
      const loaded = await listDirsRecursive(conn, remoteDirs);
      if (loaded) return loaded;
    } catch {
      // 一次列整棵失敗（例如輸出太大）就退回逐層，錯誤（連線、權限）會在逐層時照實丟出
    }
  }
  return { listings: await listDirsOneByOne(conn, remoteDirs), treeRoot: null };
}

interface Classified {
  plan: ImportPlan;
  staged: StagedFile[];
  /** 遠端已存在、而且這次有檔案要放進去的資料夾（相對於連線 URL）。 */
  existingDirs: string[];
  /** 比對遠端時列出的結果（快速路徑判斷哪些資料夾要新建時用）。 */
  listings: Listings;
  /** 一次遞迴列出時的根目錄；逐層列出是 null。 */
  treeRoot: string | null;
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
  const staged = await stagedFilesOf(batchId);
  if (staged.length === 0) throw new EditError("INVALID_INPUT", "還沒有選擇任何要上傳的檔案。");

  const remoteDirs = [...new Set(staged.map((f) => joinRemote(targetDir, dirnameOf(f.rel))))].sort((a, b) => a.split("/").length - b.split("/").length);
  const { listings, treeRoot } = await loadListings(conn, remoteDirs);

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

  // 只算「要放檔案」的資料夾：遞迴列出時 listings 裡有整棵樹，不能全當成要處理的資料夾
  const existingDirs = remoteDirs.filter((dir) => listings.get(dir));
  return {
    plan: { targetDir, add, overwrite, overwriteDetails, totalFiles: staged.length, totalBytes: staged.reduce((sum, f) => sum + f.size, 0) },
    staged,
    existingDirs,
    listings,
    treeRoot,
  };
}

export async function planImport(params: { batch: unknown; connectionId?: string; targetDir: unknown }): Promise<ImportPlan> {
  const id = await requireBatch(params.batch);
  const conn = await resolveConn(params.connectionId);
  return (await classify(conn, id, params.targetDir)).plan;
}

// ---- 送出 ----

/** 除錯用：設定 SVN_EDIT_TRACE_IMPORT=1 時，把批次上傳每個階段花的時間印到 stderr（預設完全不印）。 */
function startTrace(): (step: string) => void {
  if (process.env.SVN_EDIT_TRACE_IMPORT !== "1") return () => undefined;
  let last = Date.now();
  return (step) => {
    const now = Date.now();
    console.error(`[svn-edit] 批次上傳 ${step}：${((now - last) / 1000).toFixed(1)} 秒`);
    last = now;
  };
}

/** 路徑清單依「總長度」切成幾批（每批不超過 Windows 命令列長度上限），一次交給一個 svn 指令。 */
export function chunkByLength(items: string[], maxChars: number = SVN_ARG_MAX_CHARS, maxCount: number = SVN_ARG_MAX_COUNT): string[][] {
  const out: string[][] = [];
  let current: string[] = [];
  let length = 0;
  for (const item of items) {
    const cost = item.length + 3; // 空白與引號
    if (current.length > 0 && (length + cost > maxChars || current.length >= maxCount)) {
      out.push(current);
      current = [];
      length = 0;
    }
    current.push(item);
    length += cost;
  }
  if (current.length > 0) out.push(current);
  return out;
}

/** 同時最多 limit 個一起做，全部做完才回來；任何一個失敗就往外丟。 */
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 遇到「工作副本資料庫被鎖住」就等一下重試；其他錯誤、或重試用完仍然鎖住，照實丟出。 */
export async function withDbLockRetry<T>(fn: () => Promise<T>, delays: readonly number[] = DB_LOCK_RETRY_DELAYS_MS): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= delays.length || !DB_LOCK_RE.test(errorMessage(e))) throw e;
      await sleep(delays[attempt]);
    }
  }
}

function svnRetry(args: string[], conn: SvnConnection, timeout: number, maxBuffer?: number): Promise<{ stdout: Buffer; stderr: string }> {
  return withDbLockRetry(() => runSvn(args, conn, timeout, undefined, maxBuffer));
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
 * 一批失敗就對半拆開再試，這樣只有真正有問題的檔案會被略過，svn 的呼叫次數也不會暴增。
 */
async function applyEolStyle(conn: SvnConnection, wcPaths: string[], timeout: number): Promise<void> {
  const targets = wcPaths.filter((p) => /\.(md|txt)$/i.test(p));
  const setGroup = async (group: string[]): Promise<void> => {
    try {
      await svnRetry(["propset", "svn:eol-style", "native", ...group.map(pegSafe)], conn, timeout);
    } catch (e) {
      // 單一檔案不適用、或鎖定重試用完仍失敗：這個屬性只是盡力而為，放棄這一批，不拖垮整批上傳
      if (group.length === 1 || DB_LOCK_RE.test(errorMessage(e))) return;
      const mid = Math.ceil(group.length / 2);
      await setGroup(group.slice(0, mid));
      await setGroup(group.slice(mid));
    }
  };
  for (const group of chunkByLength(targets)) await setGroup(group);
}

/**
 * 目標目錄與要放檔案的資料夾的每一層上層，哪些在遠端已經存在、哪些不存在（都由淺到深）。
 * 快速路徑要用它決定先 mkdir 哪些（已存在的不能再 mkdir，svnmucc 會失敗）；工作副本要用它決定先拉進哪些已存在的資料夾
 * （沒有直接放檔案的中間層也要拉，否則 svn add 會把它當成新資料夾，commit 時報「已存在」）。
 * 判斷順序：比對遠端時已經知道的 → 遞迴列出的整棵樹裡有沒有 → 底下有已存在的資料夾，它一定存在 →
 * 其餘才逐一問遠端；上層已經不存在的，底下整棵不用再問。
 */
async function analyzeDirs(conn: SvnConnection, targetDir: string, staged: StagedFile[], classified: Classified): Promise<{ existing: string[]; missing: string[] }> {
  const all = new Set<string>();
  for (const dir of [targetDir, ...new Set(staged.map((f) => joinRemote(targetDir, dirnameOf(f.rel))))]) {
    const parts = dir.split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i++) all.add(parts.slice(0, i).join("/"));
  }
  const ordered = [...all].sort((a, b) => a.split("/").length - b.split("/").length || (a < b ? -1 : a > b ? 1 : 0));
  const { listings, treeRoot, existingDirs } = classified;
  const existingAncestors = new Set<string>();
  for (const dir of existingDirs) {
    const parts = dir.split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i++) existingAncestors.add(parts.slice(0, i).join("/"));
  }
  const missingRoots: string[] = [];
  const missing: string[] = [];
  const existing: string[] = [];
  for (const dir of ordered) {
    if (missingRoots.some((m) => dir.startsWith(`${m}/`))) {
      missing.push(dir);
      continue;
    }
    const known = listings.get(dir);
    let exists: boolean;
    if (known !== undefined) exists = known !== null;
    else if (treeRoot !== null && (dir === treeRoot || dir.startsWith(`${treeRoot}/`))) exists = false;
    else if (treeRoot !== null && treeRoot.startsWith(`${dir}/`)) exists = true;
    else if (existingAncestors.has(dir)) exists = true;
    else exists = (await listRemoteDir(conn, dir)) !== null;
    if (exists) {
      existing.push(dir);
    } else {
      missingRoots.push(dir);
      missing.push(dir);
    }
  }
  return { existing, missing };
}

/**
 * 快速路徑：全部都是新檔案時，用 svnmucc 一次送出（不建立工作副本，見 mucc-import.ts）。
 * 回傳 null＝這次不適用（找不到 svnmucc、說明或路徑不能交給它…），呼叫端退回工作副本的做法。
 */
async function commitViaMucc(conn: SvnConnection, id: string, classified: Classified, message: string, timeout: number, trace: (step: string) => void): Promise<{ committedRevision: number | null } | null> {
  const mucc = findSvnmucc();
  if (!mucc) return null;
  const encoder = systemMessageEncoder();
  const encodedMessage = encoder?.(message);
  if (!encodedMessage || encodedMessage.unsupported.length > 0) return null; // 說明裡有系統內碼頁表示不了的字元（例如表情符號）：用另一種做法才不會存成亂碼
  const batchDir = batchDirOf(id);
  let rootUrl = "";
  try {
    rootUrl = new URL(conn.url).href.replace(/\/+$/, "");
  } catch {
    return null;
  }
  if (!isAscii(rootUrl) || !isAscii(batchDir)) return null;
  const { plan, staged } = classified;

  const { missing: mkdirs } = await analyzeDirs(conn, plan.targetDir, staged, classified);
  trace(`確認要建立的資料夾（${mkdirs.length} 個）`);

  // 本機來源用英數檔名（參數檔只放純英數）：沒有要改內容的檔案用硬連結（不複製資料），做不到就複製。
  // md／txt 要設換行屬性，SVN 提交時會把 CRLF 轉成 LF，這裡先轉好；換行混用的檔案不設這個屬性（SVN 本來也會拒絕）。
  const srcDir = path.join(batchDir, "mucc-src");
  await rm(srcDir, { recursive: true, force: true });
  await mkdir(srcDir, { recursive: true });
  const puts: MuccPut[] = new Array(staged.length);
  await mapLimit(
    staged.map((file, index) => ({ file, index })),
    COPY_PARALLEL,
    async ({ file, index }) => {
      const local = path.join(srcDir, `f${index}`);
      const props: Array<[string, string]> = [];
      let written = false;
      const autoProp = IMPORT_AUTO_PROPS[file.rel.slice(file.rel.lastIndexOf(".") + 1).toLowerCase()];
      if (autoProp) {
        const eq = autoProp.indexOf("=");
        const name = autoProp.slice(0, eq);
        const value = autoProp.slice(eq + 1);
        if (name === "svn:eol-style") {
          const prepared = prepareNativeEol(await readFile(file.abs));
          await writeFile(local, prepared.content);
          written = true;
          if (prepared.setProp) props.push([name, value]);
        } else {
          props.push([name, value]);
        }
      }
      if (!written) await link(file.abs, local).catch(() => copyFile(file.abs, local));
      puts[index] = { remoteRel: joinRemote(plan.targetDir, file.rel), localPath: local, props };
    }
  );
  trace("準備上傳來源檔");

  const argsFile = path.join(batchDir, "mucc-args.txt");
  const messageFile = path.join(batchDir, "mucc-message.txt");
  await writeFile(argsFile, buildMuccArgsFile(mkdirs, puts), "ascii");
  await writeFile(messageFile, encodedMessage.bytes);
  const committedRevision = await runMucc(mucc, { conn, rootUrl, messageFile, argsFile, timeoutMs: timeout });
  trace("svnmucc 送出");
  return { committedRevision };
}

export async function commitImport(params: { batch: unknown; connectionId?: string; targetDir: unknown; message: unknown; ticket?: string }): Promise<ImportBatchResult> {
  const message = typeof params.message === "string" ? params.message.trim() : "";
  if (!message) throw new EditError("INVALID_INPUT", "commit message 不能是空的");
  if (message.length > MAX_COMMIT_MESSAGE_LENGTH) throw new EditError("INVALID_INPUT", `commit message 太長（上限 ${MAX_COMMIT_MESSAGE_LENGTH} 字）`);
  const id = await requireBatch(params.batch);
  if (committingBatches.has(id)) throw new EditError("ALREADY_EDITING", "這批檔案已經在送出中了，請等它完成（不要重複按上傳）。");
  const conn = await resolveConn(params.connectionId);
  committingBatches.add(id);
  try {
    return await commitImportLocked(id, conn, params.targetDir, message, params.ticket);
  } finally {
    committingBatches.delete(id);
  }
}

async function commitImportLocked(id: string, conn: SvnConnection, targetDirRaw: unknown, message: string, ticket: string | undefined): Promise<ImportBatchResult> {
  const trace = startTrace();
  const classified = await classify(conn, id, targetDirRaw);
  const { plan, staged, existingDirs } = classified;
  trace(`比對遠端（${plan.totalFiles} 個檔案）`);

  const wcDir = path.join(batchDirOf(id), "wc");
  const timeout = batchTimeoutMs(getLongSvnTimeoutMs(), plan.totalFiles, plan.totalBytes);
  /** 送出成功之後的善後：稽核紀錄、清掉暫存。 */
  const finish = async (committedRevision: number | null, modified: number, unchanged: number, method: ImportBatchResult["method"]): Promise<ImportBatchResult> => {
    const result: ImportBatchResult = { committedRevision, targetDir: plan.targetDir, added: plan.add.length, modified, unchanged, method };
    await audit({ op: "import-batch", connection: conn.name, files: staged.length, ...result, ticket: ticket?.trim() || null, ok: true, ...describeMessage(message) });
    stagedSizes.delete(id);
    stagedMtimes.delete(id);
    stagedTotals.delete(id);
    await removeDirWithRetry(batchDirOf(id));
    return result;
  };
  try {
    // 全部都是新檔案：用 svnmucc 一次送出，不建立工作副本（每個檔案省下好幾次被資安軟體攔截的改名）
    if (plan.overwrite.length === 0) {
      try {
        const fast = await commitViaMucc(conn, id, classified, message, timeout, trace);
        if (fast) return await finish(fast.committedRevision, 0, 0, "mucc");
      } catch (e) {
        if (!(e instanceof MuccUnavailableError)) throw e;
        trace(`svnmucc 不能用，改用工作副本（${e.message}）`);
      }
    }

    await removeDirWithRetry(wcDir);
    const anchor = await deepestExistingDir(conn, plan.targetDir, new Set(existingDirs));
    await svnRetry(["checkout", "--depth", "empty", pegUrl(buildFullUrl(conn.url, anchor)), wcDir], conn, timeout);
    trace("checkout 工作副本");
    const wcPathOf = (remoteRel: string): string => path.join(wcDir, ...(anchor ? remoteRel.slice(anchor.length).split("/") : remoteRel.split("/")).filter(Boolean));

    // 遠端已存在、而這次有檔案要放進去的資料夾：先讓它們在工作副本裡成為「已納管的資料夾」，新檔案才不會跟遠端現有資料夾衝突
    const { existing: existingAll } = await analyzeDirs(conn, plan.targetDir, staged, classified);
    const dirsToPull = existingAll.filter((d) => d !== anchor && (anchor === "" || d.startsWith(`${anchor}/`)));
    for (const group of chunkByLength(dirsToPull.map(wcPathOf))) {
      await svnRetry(["update", "--parents", "--depth", "empty", ...group.map(pegSafe)], conn, timeout);
    }
    trace("update 遠端已存在的資料夾");
    // 要覆蓋的檔案：把遠端現有版本取下來
    const overwriteWcPaths = plan.overwrite.map((rel) => wcPathOf(joinRemote(plan.targetDir, rel)));
    for (const group of chunkByLength(overwriteWcPaths)) {
      await svnRetry(["update", "--parents", ...group.map(pegSafe)], conn, timeout, BATCH_MAX_BUFFER);
    }
    trace("update 要覆蓋的檔案");

    // 內容寫進工作副本（needs-lock 的檔案取下來是唯讀，先解除唯讀）。檔案很多時一個一個複製太慢，同時複製多個；
    // 同一個資料夾只建一次。
    const overwriteSet = new Set(plan.overwrite);
    const madeDirs = new Set<string>();
    await mapLimit(staged, COPY_PARALLEL, async (file) => {
      const dest = wcPathOf(joinRemote(plan.targetDir, file.rel));
      const dir = path.dirname(dest);
      if (!madeDirs.has(dir)) {
        await mkdir(dir, { recursive: true });
        madeDirs.add(dir);
      }
      if (overwriteSet.has(file.rel)) await chmod(dest, 0o666).catch(() => undefined);
      await copyFile(file.abs, dest);
    });
    trace("複製檔案進工作副本");

    // 新增的項目：--no-ignore 避免使用者電腦的 global-ignores 悄悄吃掉檔案
    await svnRetry(["add", "--force", "--no-ignore", "--depth", "infinity", ...autoPropArgs(plan.add), pegSafe(wcDir)], conn, timeout, BATCH_MAX_BUFFER);
    trace("svn add");
    await applyEolStyle(conn, plan.add.map((rel) => wcPathOf(joinRemote(plan.targetDir, rel))), timeout);
    trace("設定換行屬性（propset）");

    const { stdout: statusOut } = await svnRetry(["status", "--xml", pegSafe(wcDir)], conn, timeout, BATCH_MAX_BUFFER);
    trace("svn status");
    const statusText = statusOut.toString("utf-8");
    const changed = modifiedPaths(statusText);
    const modified = overwriteWcPaths.filter((p) => changed.has(path.resolve(p).toLowerCase())).length;
    const unchanged = plan.overwrite.length - modified;
    if (plan.add.length === 0 && modified === 0) {
      throw new EditError("NO_CHANGES", "這些檔案的內容跟 SVN 上完全一樣，不需要上傳。");
    }

    let stdout: Buffer;
    try {
      stdout = await withDbLockRetry(() => commitWithMessage(conn, message, [wcDir], timeout, BATCH_MAX_BUFFER));
    } catch (e) {
      const text = errorMessage(e);
      if (/E160039|is locked by|locked by user/i.test(text)) {
        throw new EditError("FILE_LOCKED", `有檔案正被別人鎖定編輯中，無法覆蓋，請等對方解鎖後再試：\n${text}`);
      }
      throw e;
    }
    trace("svn commit");
    return await finish(parseRevision(stdout), modified, unchanged, "wc");
  } catch (e) {
    // 失敗時只清掉工作副本，保留已上傳的暫存檔，使用者修正問題後可以直接重試，不必重新選檔案
    await removeDirWithRetry(wcDir);
    await audit({ op: "import-batch", connection: conn.name, targetDir: plan.targetDir, files: staged.length, ok: false, error: errorMessage(e), ...describeMessage(message) });
    throw e;
  }
}
