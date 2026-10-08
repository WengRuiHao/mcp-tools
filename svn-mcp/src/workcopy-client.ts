/**
 * SVN 工作副本（working copy）的狀態查詢與寫入操作：status／diff／add+commit／update／delete／revert／cleanup。
 *
 * **刻意不註冊成 MCP 工具**——svn-mcp 對 AI 呼叫端維持唯讀（svn_browse/cat/log/diff），這份模組只提供函式，
 * 由「使用者在網頁上按按鈕」這條路徑（dev-pipeline-mcp 的 HTTP bridge）呼叫，AI 沒有任何一個 MCP 工具能
 * 修改 SVN。連線帳密仍只在 svn-mcp 這邊用 connectionId 解析，不會回傳給呼叫端。
 *
 * 安全邊界（每個操作都套用）：
 * - 工作副本必須真的是 SVN working copy，且它的遠端 URL 必須落在指定連線的 URL 底下（避免拿 A 專案的
 *   帳密去動 B 專案的工作副本）；
 * - 呼叫端傳進來的檔案路徑一律是「相對於工作副本根目錄」，不能是絕對路徑、不能含 `..` 或 `.svn`；
 * - commit 一律明確列出要上傳的檔案（不會整份工作副本全部送出），且必須帶非空的 commit message；
 * - 遇到衝突（含 tree conflict）一律拒絕，不自動解決（update 一律 --accept postpone）；
 * - 同一個工作副本的操作排隊執行（SVN 對同一份工作副本平行操作會鎖死）；
 * - revert 只允許用在「新增／刪除／遺失」三種狀態——不會丟棄任何已修改的檔案內容。
 */
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getSvnTimeoutMs } from "./config-store.js";
import { resolveConnection, runSvn, type SvnConnection } from "./svn-client.js";

export type WcStatusItem =
  | "modified"
  | "added"
  | "deleted"
  | "unversioned"
  | "missing"
  | "conflicted"
  | "replaced"
  | "incomplete"
  | "obstructed"
  | "external"
  | "other";

export interface WcEntry {
  /** 相對於工作副本根目錄、以 `/` 分隔的路徑；工作副本根目錄本身是 "."。 */
  path: string;
  status: WcStatusItem;
  /** 屬性（props）有異動、或發生 tree conflict。 */
  propsModified: boolean;
  treeConflict: boolean;
  /** 加入時帶歷史（svn copy／move）。 */
  copied: boolean;
  /** `svn status -u` 才有：遠端對這個項目的狀態（例如 modified＝遠端有更新、尚未 update）。 */
  remoteStatus: string | null;
}

export interface WcOptions {
  workCopyPath: string;
  connectionId?: string;
}

export interface WcStatusResult {
  workCopyPath: string;
  remoteUrl: string;
  entries: WcEntry[];
  /** 這次是否有連遠端檢查（`-u`）。 */
  checkedRemote: boolean;
}

const MAX_FILES_PER_OPERATION = 200;
const MAX_COMMIT_MESSAGE_LENGTH = 4000;
const MAX_DIFF_BYTES = 300 * 1024;
const UPDATE_TIMEOUT_MULTIPLIER = 10;
/** Word/Excel 開檔時產生的暫存鎖定檔，不是使用者要上傳的內容。 */
const OFFICE_LOCK_FILE_PREFIX = "~$";

// ---- 同一個工作副本的操作排隊 ----
const queues = new Map<string, Promise<unknown>>();
export function withWcLock<T>(wcAbs: string, task: () => Promise<T>): Promise<T> {
  const key = wcAbs.toLowerCase();
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  queues.set(key, next);
  const cleanup = () => {
    if (queues.get(key) === next) queues.delete(key);
  };
  next.then(cleanup, cleanup);
  return next;
}

// ---- 路徑與連線驗證 ----
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeUrlForCompare(url: string): string {
  return safeDecode(url).replace(/\/+$/, "").toLowerCase();
}

/** child 是 base 本身或 base 底下的路徑（以 `/` 為邊界，`.../repo2` 不算在 `.../repo` 底下）。 */
function isUrlUnder(child: string, base: string): boolean {
  const c = normalizeUrlForCompare(child);
  const b = normalizeUrlForCompare(base);
  return c === b || c.startsWith(`${b}/`);
}

/** 把呼叫端傳來的相對路徑轉成工作副本內的絕對路徑；任何跳出工作副本、碰 .svn 的寫法一律拒絕。 */
export function resolveInsideWorkCopy(wcAbs: string, relPath: unknown): string {
  if (typeof relPath !== "string" || relPath.trim() === "") {
    throw new Error("檔案路徑不能是空的");
  }
  if (path.isAbsolute(relPath) || /^[a-zA-Z]:/.test(relPath) || /^[\\/]/.test(relPath)) {
    throw new Error(`檔案路徑必須是相對於工作副本的路徑，不能是絕對路徑：${relPath}`);
  }
  const segments = relPath.split(/[\\/]+/).filter((seg) => seg !== "" && seg !== ".");
  if (segments.length === 0) {
    throw new Error("檔案路徑不能指向工作副本根目錄本身");
  }
  if (segments.some((seg) => seg === ".." || seg.toLowerCase() === ".svn")) {
    throw new Error(`檔案路徑不能包含 ".." 或 ".svn"：${relPath}`);
  }
  return path.join(wcAbs, ...segments);
}

/** svn 指令的路徑參數若含 `@` 會被當成 peg revision，結尾補一個 `@` 讓它當作純路徑。 */
export function pegSafe(absPath: string): string {
  return absPath.includes("@") ? `${absPath}@` : absPath;
}

function toRelative(wcAbs: string, entryPath: string): string {
  const abs = path.isAbsolute(entryPath) ? entryPath : path.resolve(wcAbs, entryPath);
  const rel = path.relative(wcAbs, abs).split(path.sep).join("/");
  return rel === "" ? "." : rel;
}

function isOfficeLockFile(relPath: string): boolean {
  const base = relPath.split("/").pop() ?? relPath;
  return base.startsWith(OFFICE_LOCK_FILE_PREFIX);
}

interface Prepared {
  conn: SvnConnection;
  wcAbs: string;
  remoteUrl: string;
}

async function prepare(opts: WcOptions): Promise<Prepared> {
  if (!opts.workCopyPath || typeof opts.workCopyPath !== "string") {
    throw new Error("缺少 workCopyPath");
  }
  const wcAbs = path.resolve(opts.workCopyPath);
  const conn = await resolveConnection(opts.connectionId);
  let remoteUrl: string;
  try {
    const { stdout } = await runSvn(["info", "--show-item", "url", wcAbs], conn, getSvnTimeoutMs());
    remoteUrl = stdout.toString("utf-8").trim();
  } catch (e) {
    throw new Error(`${wcAbs} 不是有效的 SVN 工作副本，或讀取失敗：${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isUrlUnder(remoteUrl, conn.url)) {
    throw new Error(`這份工作副本的遠端（${safeDecode(remoteUrl)}）不在連線「${conn.name}」的範圍內，為避免用錯帳號操作，已拒絕。`);
  }
  return { conn, wcAbs, remoteUrl };
}

// ---- status ----
function xmlUnescape(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function attr(block: string, name: string): string | null {
  const m = block.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? xmlUnescape(m[1]) : null;
}

function mapStatusItem(item: string | null): WcStatusItem {
  switch (item) {
    case "modified":
    case "added":
    case "deleted":
    case "unversioned":
    case "missing":
    case "conflicted":
    case "replaced":
    case "incomplete":
    case "obstructed":
    case "external":
      return item;
    default:
      return "other";
  }
}

export function parseWcStatusXml(xml: string, wcAbs: string): WcEntry[] {
  const entries: WcEntry[] = [];
  const entryRe = /<entry\s+path="([^"]*)">([\s\S]*?)<\/entry>/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(xml))) {
    const [, rawPath, block] = m;
    const wcBlock = block.match(/<wc-status\s+([^>]*)>/);
    if (!wcBlock) continue;
    const item = attr(wcBlock[1], "item");
    const props = attr(wcBlock[1], "props");
    const reposBlock = block.match(/<repos-status\s+([^>]*)>/);
    const remoteItem = reposBlock ? attr(reposBlock[1], "item") : null;
    const remoteProps = reposBlock ? attr(reposBlock[1], "props") : null;
    const relPath = toRelative(wcAbs, xmlUnescape(rawPath));
    const treeConflict = attr(wcBlock[1], "tree-conflicted") === "true";
    const status = mapStatusItem(item);
    const remoteStatus = remoteItem && remoteItem !== "none" ? remoteItem : remoteProps && remoteProps !== "none" ? "props" : null;
    // 一般的「沒變動」項目（item=normal 且遠端也沒動）不是這份清單要列的。
    if (status === "other" && item === "normal" && !treeConflict && props !== "modified" && !remoteStatus) continue;
    entries.push({
      path: relPath,
      status: treeConflict && status === "other" ? "conflicted" : status,
      propsModified: props === "modified" || props === "conflicted",
      treeConflict,
      copied: attr(wcBlock[1], "copied") === "true",
      remoteStatus,
    });
  }
  return entries.filter((entry) => !isOfficeLockFile(entry.path));
}

export async function wcStatus(opts: WcOptions, options: { checkRemote?: boolean } = {}): Promise<WcStatusResult> {
  const { conn, wcAbs, remoteUrl } = await prepare(opts);
  return withWcLock(wcAbs, async () => {
    const args = ["status", "--xml", ...(options.checkRemote ? ["-u"] : []), wcAbs];
    const timeout = options.checkRemote ? getSvnTimeoutMs() * 4 : getSvnTimeoutMs() * 2;
    const { stdout } = await runSvn(args, conn, timeout);
    return {
      workCopyPath: wcAbs,
      remoteUrl: safeDecode(remoteUrl),
      entries: parseWcStatusXml(stdout.toString("utf-8"), wcAbs),
      checkedRemote: options.checkRemote === true,
    };
  });
}

async function statusMap(conn: SvnConnection, wcAbs: string): Promise<Map<string, WcEntry>> {
  const { stdout } = await runSvn(["status", "--xml", wcAbs], conn, getSvnTimeoutMs() * 2);
  return new Map(parseWcStatusXml(stdout.toString("utf-8"), wcAbs).map((entry) => [entry.path, entry]));
}

function assertCount(files: unknown[]): void {
  if (files.length === 0) throw new Error("沒有指定任何檔案");
  if (files.length > MAX_FILES_PER_OPERATION) throw new Error(`一次最多處理 ${MAX_FILES_PER_OPERATION} 個項目，這次有 ${files.length} 個`);
}

function assertNotConflicted(entry: WcEntry | undefined, rel: string): void {
  if (entry && (entry.status === "conflicted" || entry.treeConflict)) {
    throw new Error(`「${rel}」處於衝突狀態，必須先在 TortoiseSVN 手動解決衝突，這裡不會自動處理。`);
  }
}

// ---- diff ----
export async function wcDiff(opts: WcOptions, relPath: string): Promise<{ path: string; kind: "diff" | "new-file" | "binary" | "empty"; text: string; truncated: boolean }> {
  const { conn, wcAbs } = await prepare(opts);
  const abs = resolveInsideWorkCopy(wcAbs, relPath);
  return withWcLock(wcAbs, async () => {
    const entry = (await statusMap(conn, wcAbs)).get(toRelative(wcAbs, abs));
    if (entry?.status === "unversioned") {
      // 還沒加入版控的新檔案：沒有 diff 可看，直接顯示檔案內容（二進位檔只提示）。
      const info = await stat(abs).catch(() => null);
      if (!info || !info.isFile()) return { path: relPath, kind: "empty" as const, text: "（新資料夾，或檔案已不存在）", truncated: false };
      const buf = await readFile(abs);
      if (buf.subarray(0, 8000).includes(0)) return { path: relPath, kind: "binary" as const, text: "（二進位檔，無法顯示內容）", truncated: false };
      const truncated = buf.length > MAX_DIFF_BYTES;
      return { path: relPath, kind: "new-file" as const, text: buf.subarray(0, MAX_DIFF_BYTES).toString("utf-8"), truncated };
    }
    const { stdout } = await runSvn(["diff", pegSafe(abs)], conn, getSvnTimeoutMs() * 2);
    if (stdout.length === 0) return { path: relPath, kind: "empty" as const, text: "（沒有可顯示的文字差異；可能只有屬性異動，或是二進位檔）", truncated: false };
    const text = stdout.subarray(0, MAX_DIFF_BYTES).toString("utf-8");
    const binary = /Cannot display: file marked as binary|svn:mime-type = application\/octet-stream/.test(text) || stdout.subarray(0, 8000).includes(0);
    if (binary) return { path: relPath, kind: "binary" as const, text: "（二進位檔，無法顯示文字差異）", truncated: false };
    return { path: relPath, kind: "diff" as const, text, truncated: stdout.length > MAX_DIFF_BYTES };
  });
}

// ---- add + commit ----
async function listFilesRecursively(dir: string): Promise<string[]> {
  const result: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".svn" || entry.name.startsWith(OFFICE_LOCK_FILE_PREFIX)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...(await listFilesRecursively(full)));
    else result.push(full);
  }
  return result;
}

export interface WcCommitResult {
  committedRevision: number | null;
  committed: string[];
  added: string[];
}

/**
 * commit message 一律寫成 UTF-8 暫存檔再用 -F 傳給 svn：Windows 上經由命令列參數（-m）傳中文，會先被轉成系統
 * 預設字碼頁，svn 再當成 UTF-8 驗證就會報 "svn:log ... not encoded in UTF-8"。
 */
export async function commitWithMessage(conn: SvnConnection, message: string, targets: string[]): Promise<Buffer> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "svn-mcp-msg-"));
  const messageFile = path.join(dir, "message.txt");
  try {
    await writeFile(messageFile, message, "utf-8");
    const { stdout } = await runSvn(
      ["commit", "--encoding", "UTF-8", "-F", messageFile, ...targets.map(pegSafe)],
      conn,
      getSvnTimeoutMs() * UPDATE_TIMEOUT_MULTIPLIER
    );
    return stdout;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const COMMITTABLE: ReadonlySet<WcStatusItem> = new Set(["modified", "added", "deleted", "replaced", "unversioned"]);

/**
 * 把使用者勾選的項目「該加入的先加入、再一起 commit」。commit 失敗時，這次剛加入的項目會 revert 回原本的
 * 未加入狀態（只還原「加入」這個動作，檔案內容不動），不留下使用者沒預期的半套狀態。
 */
export async function wcAddAndCommit(opts: WcOptions, relPaths: string[], message: string): Promise<WcCommitResult> {
  const trimmed = typeof message === "string" ? message.trim() : "";
  if (!trimmed) throw new Error("commit message 不能是空的");
  if (trimmed.length > MAX_COMMIT_MESSAGE_LENGTH) throw new Error(`commit message 太長（上限 ${MAX_COMMIT_MESSAGE_LENGTH} 字）`);
  assertCount(relPaths);
  const { conn, wcAbs } = await prepare(opts);

  return withWcLock(wcAbs, async () => {
    const statuses = await statusMap(conn, wcAbs);
    const targets: string[] = [];
    const addedByUs: string[] = [];
    try {
      for (const rel of [...new Set(relPaths)]) {
        const abs = resolveInsideWorkCopy(wcAbs, rel);
        const key = toRelative(wcAbs, abs);
        const entry = statuses.get(key);
        if (!entry) throw new Error(`「${rel}」目前沒有任何可上傳的變更`);
        assertNotConflicted(entry, rel);
        if (entry.status === "missing") throw new Error(`「${rel}」在本機已不存在，請先按「刪除」把它標記為要從 SVN 移除，再上傳。`);
        if (!COMMITTABLE.has(entry.status)) throw new Error(`「${rel}」目前狀態（${entry.status}）無法上傳`);

        if (entry.status === "unversioned") {
          const info = await stat(abs);
          if (info.isDirectory()) {
            await runSvn(["add", "--depth", "empty", "--parents", pegSafe(abs)], conn, getSvnTimeoutMs() * 2);
            addedByUs.push(abs);
            for (const file of await listFilesRecursively(abs)) {
              await runSvn(["add", "--parents", pegSafe(file)], conn, getSvnTimeoutMs() * 2);
            }
          } else {
            await runSvn(["add", "--parents", pegSafe(abs)], conn, getSvnTimeoutMs() * 2);
            addedByUs.push(abs);
          }
        }
        targets.push(abs);
      }

      const stdout = await commitWithMessage(conn, trimmed, targets);
      const lastLine = stdout.toString("utf-8").trim().split(/\r?\n/).pop() ?? "";
      const revMatch = lastLine.match(/(\d+)\D*$/);
      return {
        committedRevision: revMatch ? Number(revMatch[1]) : null,
        committed: targets.map((t) => toRelative(wcAbs, t)),
        added: addedByUs.map((t) => toRelative(wcAbs, t)),
      };
    } catch (e) {
      for (const abs of addedByUs) {
        await runSvn(["revert", "-R", pegSafe(abs)], conn, getSvnTimeoutMs()).catch(() => undefined);
      }
      throw e;
    }
  });
}

// ---- update ----
export interface WcUpdateResult {
  revision: number | null;
  changes: { action: string; path: string }[];
  conflicts: string[];
}

const UPDATE_LINE_RE = /^([ADUCGEMR])([ADUCGEMR ]?)([ADUCGEMR ]?)\s{2,}(.+)$/;

/** 從遠端更新整份工作副本。一律 --accept postpone：遇到衝突只標記、不自動合併或覆寫，交給使用者處理。 */
export async function wcUpdate(opts: WcOptions): Promise<WcUpdateResult> {
  const { conn, wcAbs } = await prepare(opts);
  return withWcLock(wcAbs, async () => {
    const { stdout } = await runSvn(["update", "--accept", "postpone", wcAbs], conn, getSvnTimeoutMs() * UPDATE_TIMEOUT_MULTIPLIER);
    const changes: { action: string; path: string }[] = [];
    const conflicts: string[] = [];
    for (const rawLine of stdout.toString("utf-8").split(/\r?\n/)) {
      const m = rawLine.match(UPDATE_LINE_RE);
      if (!m) continue;
      const relPath = toRelative(wcAbs, m[4].trim());
      const columns = `${m[1]}${m[2]}${m[3]}`;
      changes.push({ action: columns.trim(), path: relPath });
      if (columns.includes("C")) conflicts.push(relPath);
    }
    const info = await runSvn(["info", "--show-item", "revision", wcAbs], conn, getSvnTimeoutMs());
    const revision = Number(info.stdout.toString("utf-8").trim());
    return { revision: Number.isFinite(revision) ? revision : null, changes, conflicts };
  });
}

// ---- delete / revert / cleanup ----
/**
 * 把檔案標記為「要從 SVN 移除」（本機刪掉＋排入下一次 commit）。這個動作本身不會動到遠端——真正移除要等使用者
 * 之後按「上傳」commit。有未上傳修改的檔案一律拒絕，避免不小心丟掉內容。
 */
export async function wcDelete(opts: WcOptions, relPaths: string[]): Promise<{ scheduled: string[] }> {
  assertCount(relPaths);
  const { conn, wcAbs } = await prepare(opts);
  return withWcLock(wcAbs, async () => {
    const statuses = await statusMap(conn, wcAbs);
    const scheduled: string[] = [];
    for (const rel of [...new Set(relPaths)]) {
      const abs = resolveInsideWorkCopy(wcAbs, rel);
      const key = toRelative(wcAbs, abs);
      const entry = statuses.get(key);
      assertNotConflicted(entry, rel);
      if (entry && entry.status !== "missing") {
        throw new Error(`「${rel}」目前狀態是 ${entry.status}，有未上傳的內容，不能直接刪除；請先上傳，或先還原。`);
      }
      await runSvn(["delete", pegSafe(abs)], conn, getSvnTimeoutMs() * 2);
      scheduled.push(key);
    }
    return { scheduled };
  });
}

const REVERTABLE: ReadonlySet<WcStatusItem> = new Set(["added", "deleted", "missing"]);

/** 還原「新增／刪除／遺失」這三種狀態（取消加入、取消刪除、把不見的檔案找回來）；已修改的檔案不允許，避免丟失內容。 */
export async function wcRevert(opts: WcOptions, relPath: string): Promise<{ reverted: string }> {
  const { conn, wcAbs } = await prepare(opts);
  const abs = resolveInsideWorkCopy(wcAbs, relPath);
  return withWcLock(wcAbs, async () => {
    const key = toRelative(wcAbs, abs);
    const statuses = await statusMap(conn, wcAbs);
    const entry = statuses.get(key);
    if (!entry) throw new Error(`「${relPath}」目前沒有可還原的變更`);
    assertNotConflicted(entry, relPath);
    if (!REVERTABLE.has(entry.status)) {
      throw new Error(`「${relPath}」目前狀態是 ${entry.status}，還原會丟掉你的修改內容，這裡不允許；只能還原新增、刪除或遺失的項目。`);
    }
    // 對資料夾是遞迴還原：底下若有已修改的檔案，一併還原會連修改內容一起丟掉，所以直接拒絕。
    const atRisk = [...statuses.values()].filter(
      (e) => e.path.startsWith(`${key}/`) && (e.status === "modified" || e.status === "replaced" || e.status === "conflicted" || e.propsModified)
    );
    if (atRisk.length > 0) {
      const sample = atRisk.slice(0, 3).map((e) => e.path.slice(key.length + 1)).join("、");
      throw new Error(`「${relPath}」底下有 ${atRisk.length} 個已修改的項目（${sample}${atRisk.length > 3 ? " 等" : ""}），還原會連這些修改一起丟掉，這裡不允許。請先上傳或另外備份這些修改。`);
    }
    await runSvn(["revert", "-R", pegSafe(abs)], conn, getSvnTimeoutMs() * 2);
    return { reverted: key };
  });
}

/** 清掉上次被中斷的操作留下的工作副本鎖（錯誤訊息出現 locked／cleanup 時用）。 */
export async function wcCleanup(opts: WcOptions): Promise<{ cleaned: true }> {
  const { conn, wcAbs } = await prepare(opts);
  return withWcLock(wcAbs, async () => {
    await runSvn(["cleanup", wcAbs], conn, getSvnTimeoutMs() * 2);
    return { cleaned: true as const };
  });
}
