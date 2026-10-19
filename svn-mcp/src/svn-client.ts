import { execFile } from "node:child_process";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getConnectionsFilePath, getDefaultConnectionId, getSvnTimeoutMs } from "./config-store.js";
import { expandConnections, findConnection, knownNames, type RepoCache, type StoredConnectionEntry } from "./connection-expand.js";
import type { RepoPrefs } from "./prefs-model.js";
import { readProfileStrict } from "./profile-store.js";
import { searchRepos } from "./repo-search.js";
import { decodeSvnText } from "./svn-text.js";
import { isStale, readRepoCache, refreshRepoCache } from "./repo-cache.js";
import { errorMessage } from "./util.js";

export interface SvnResult {
  success: boolean;
  data?: unknown;
  message?: string;
}

export interface SvnConnection {
  id: string;
  name: string;
  url: string;
  username: string;
  password: string;
}

/** 同一個行程裡，同一個帳號重新讀 repo 清單的最短間隔：伺服器連不上時，連續打錯名稱不會每次都卡 30 秒。 */
const REFRESH_RETRY_MS = 60_000;
const lastRefreshAttempt = new Map<string, number>();

async function refreshOnce(servers: StoredConnectionEntry[]): Promise<RepoCache> {
  const due = servers.filter((s) => Date.now() - (lastRefreshAttempt.get(s.id) ?? 0) > REFRESH_RETRY_MS);
  for (const s of due) lastRefreshAttempt.set(s.id, Date.now());
  return due.length ? refreshRepoCache(due) : readRepoCache();
}

/** 連線檔＋repo 清單快取；帳號還沒有快取（剛遷移、或快取檔被刪）就先向伺服器讀一次補上。 */
async function loadState(): Promise<{ entries: StoredConnectionEntry[]; cache: RepoCache; prefs: RepoPrefs }> {
  const profile = await readProfileStrict();
  const entries = profile.accounts;
  let cache = profile.repoCache;
  const missing = entries.filter((e) => e.kind === "server" && !cache[e.id] && !e.repos);
  if (missing.length) cache = await refreshOnce(missing);
  return { entries, cache, prefs: profile.prefs };
}

/** Lists connections with credentials stripped — safe to hand back to whatever's driving this MCP. */
export async function listConnections(): Promise<SvnResult> {
  try {
    const { entries, cache, prefs } = await loadState();
    const conns = expandConnections(entries, cache);
    return {
      success: true,
      data: conns.map((c) => ({
        id: c.id,
        name: c.name,
        url: c.url,
        aliases: c.aliases,
        nickname: prefs.nicknames[c.name] ?? null,
        starred: prefs.starred.includes(c.name),
        folders: (prefs.folders[c.name] ?? []).map((path) => ({ path, nickname: prefs.folderNicknames[c.name]?.[path] ?? null })),
      })),
    };
  } catch (e) {
    return { success: false, message: `讀取 SVN 連線清單失敗（${getConnectionsFilePath()}）：${errorMessage(e)}` };
  }
}

export async function resolveConnection(connectionId?: string): Promise<SvnConnection> {
  const target = connectionId?.trim() || getDefaultConnectionId();
  let { entries, cache, prefs } = await loadState();
  const available = (): string => knownNames(entries, cache, prefs.nicknames).join("、") || "(無)";
  if (!target) {
    throw new Error(`沒有指定 connectionId，也沒有設定 SVN_CONNECTION_ID 環境變數。可用的連線：${available()}`);
  }
  let conn = findConnection(entries, cache, target, prefs.nicknames);
  if (!conn) {
    // 可能是伺服器上剛新建的 repo：快取過期的帳號重新讀一次再找
    const stale = entries.filter((e) => e.kind === "server" && isStale(cache[e.id]));
    if (stale.length) {
      cache = await refreshOnce(stale);
      conn = findConnection(entries, cache, target, prefs.nicknames);
    }
  }
  if (!conn) {
    throw new Error(`找不到 SVN 連線「${target}」。可用的連線：${available()}。如果是伺服器上新建的 repo，請到 svn-edit 的「連線設定」按「重新載入」。`);
  }
  return conn;
}

/** Rejects a path that tries to escape the connection's own repo root (`..` segments) or that is
 * itself a fully-qualified URL pointing somewhere other than under baseUrl (e.g. `file://`) —
 * the resulting URL handed to `svn` must always resolve under the configured connection's base. */
function assertSafeSubPath(subPath: string): void {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(subPath)) {
    throw new Error(`不允許傳入完整 URL 當作路徑：${subPath}`);
  }
  const segments = subPath.split(/[/\\]+/);
  if (segments.some((seg) => seg === "..")) {
    throw new Error(`路徑不能包含 ".."：${subPath}`);
  }
}

export function buildFullUrl(baseUrl: string, subPath: string): string {
  if (!subPath) return baseUrl;
  assertSafeSubPath(subPath);
  return `${baseUrl.replace(/\/+$/, "")}/${subPath.replace(/^\/+/, "")}`;
}

/**
 * 執行需要 commit 訊息的 svn 指令（commit／delete／import…）：訊息寫成 UTF-8 暫存檔、用 `-F` 傳給 svn，指令結束後清掉。
 * Windows 上經由命令列參數（-m）傳中文，會先被轉成系統預設字碼頁，svn 再當成 UTF-8 驗證就會報 "svn:log ... not encoded in UTF-8"。
 */
export async function runSvnWithMessage(subcommand: string, conn: SvnConnection, message: string, restArgs: string[], timeoutMs: number, maxBufferBytes?: number): Promise<{ stdout: Buffer; stderr: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "svn-mcp-msg-"));
  try {
    const messageFile = path.join(dir, "message.txt");
    await writeFile(messageFile, message, "utf-8");
    return await runSvn([subcommand, "--encoding", "UTF-8", "-F", messageFile, ...restArgs], conn, timeoutMs, undefined, maxBufferBytes);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function runSvn(
  args: string[],
  conn: SvnConnection,
  timeoutMs: number,
  extraEnv?: Record<string, string>,
  /** svn 輸出（stdout）的緩衝上限；預設 50 MB，批次上傳十萬個檔案時 add／commit 會逐檔印一行，要調大。 */
  maxBufferBytes: number = 50 * 1024 * 1024
): Promise<{ stdout: Buffer; stderr: string }> {
  const fullArgs = [...args, "--non-interactive", "--no-auth-cache", "--trust-server-cert", "--username", conn.username, "--password", conn.password];
  return new Promise((resolve, reject) => {
    execFile(
      "svn",
      fullArgs,
      { timeout: timeoutMs, maxBuffer: maxBufferBytes, encoding: "buffer", windowsHide: true, env: extraEnv ? { ...process.env, ...extraEnv } : process.env },
      (error, stdout, stderr) => {
        const stderrText = Buffer.isBuffer(stderr) ? decodeSvnText(stderr) : String(stderr ?? "");
        if (error) {
          // Never surface error.message to the caller: on failures where stderr is empty (svn
          // binary missing, timeout, connection-layer failure), Node bakes the full invoked
          // command — including --username/--password — into error.message. Log the real
          // detail server-side only; callers only ever see stderr (svn's own, credential-free
          // output) or a generic fallback.
          if (!stderrText.trim()) {
            console.error(`[svn-mcp] svn 指令失敗，未回傳給呼叫端的完整錯誤：${error.message}`);
          }
          if (!stderrText.trim() && (error as any).killed) {
            reject(new Error(`SVN 指令執行逾時（超過 ${Math.round(timeoutMs / 1000)} 秒被中止），檔案數量或網路傳輸量太大，請分批上傳或調高 SVN_TIMEOUT_MS`));
            return;
          }
          reject(new Error(stderrText.trim() || `SVN 指令執行失敗（exit code: ${(error as any).code ?? "unknown"}），請確認 svn 執行檔存在且連線設定正確`));
          return;
        }
        resolve({ stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout)), stderr: stderrText });
      }
    );
  });
}

function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function extractTag(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? xmlUnescape(m[1].trim()) : null;
}

function parseSvnLsXml(xml: string): Array<{ name: string; kind: string; size: number | null; revision: string | null; author: string | null; date: string | null }> {
  const entries: ReturnType<typeof parseSvnLsXml> = [];
  const entryRe = /<entry\s+kind="([^"]+)">([\s\S]*?)<\/entry>/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(xml))) {
    const [, kind, block] = m;
    const sizeStr = extractTag(block, "size");
    entries.push({
      name: extractTag(block, "name") ?? "",
      kind,
      size: sizeStr ? Number(sizeStr) : null,
      revision: (block.match(/<commit\s+revision="([^"]+)"/) ?? [])[1] ?? null,
      author: extractTag(block, "author"),
      date: extractTag(block, "date"),
    });
  }
  return entries;
}

function parseSvnLogXml(xml: string): Array<{ revision: string; author: string | null; date: string | null; message: string | null }> {
  const entries: ReturnType<typeof parseSvnLogXml> = [];
  const entryRe = /<logentry\s+revision="([^"]+)">([\s\S]*?)<\/logentry>/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(xml))) {
    const [, revision, block] = m;
    entries.push({
      revision,
      author: extractTag(block, "author"),
      date: extractTag(block, "date"),
      message: extractTag(block, "msg"),
    });
  }
  return entries;
}

const BINARY_EXTENSIONS = new Set(["docx", "doc", "xlsx", "xls", "pdf", "pptx", "png", "jpg", "jpeg", "gif", "bmp", "zip"]);

function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 8000));
  return sample.includes(0);
}

/** Tests whether a connection can actually be reached (real `svn info` call) — used as a hard gate before letting a pipeline proceed with an SVN-backed SA/SD config. */
export async function testConnection(connectionId?: string): Promise<SvnResult> {
  let conn: SvnConnection;
  try {
    conn = await resolveConnection(connectionId);
  } catch (e) {
    return { success: false, message: errorMessage(e) };
  }
  try {
    const { stdout } = await runSvn(["info", conn.url], conn, getSvnTimeoutMs());
    return { success: true, data: { connectionId: conn.id, name: conn.name, url: conn.url, info: decodeSvnText(stdout) } };
  } catch (e) {
    return {
      success: false,
      message: `連不上 SVN 連線「${conn.name}」（${conn.url}）：${errorMessage(e)}。請確認網路/VPN、帳密、或 URL 是否正確。`,
    };
  }
}

export async function svnBrowse(path_: string, connectionId?: string): Promise<SvnResult> {
  try {
    const conn = await resolveConnection(connectionId);
    const fullUrl = buildFullUrl(conn.url, path_);
    const { stdout } = await runSvn(["ls", "--xml", fullUrl], conn, getSvnTimeoutMs());
    return { success: true, data: { path: path_ || "/", entries: parseSvnLsXml(stdout.toString("utf-8")) } };
  } catch (e) {
    return { success: false, message: errorMessage(e) };
  }
}

export async function svnCat(path_: string, rev = "HEAD", connectionId?: string): Promise<SvnResult> {
  try {
    const conn = await resolveConnection(connectionId);
    const fullUrl = buildFullUrl(conn.url, path_);
    const { stdout } = await runSvn(["cat", "-r", rev, fullUrl], conn, getSvnTimeoutMs());
    const fileName = path_.includes("/") ? path_.slice(path_.lastIndexOf("/") + 1) : path_;
    const ext = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase() : "";

    if (!BINARY_EXTENSIONS.has(ext) && !looksBinary(stdout)) {
      return { success: true, data: { binary: false, path: path_, revision: rev, content: stdout.toString("utf-8") } };
    }

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "svn-mcp-"));
    const tmpPath = path.join(tmpDir, fileName || "file");
    await writeFile(tmpPath, stdout);
    return {
      success: true,
      data: {
        binary: true,
        path: path_,
        revision: rev,
        ext,
        size: stdout.length,
        tempFilePath: tmpPath,
        message: "二進位/文件格式已寫入本機暫存檔，請用專案既有的檔案讀取流程（例如 docx 用 python-docx）處理這個路徑，讀完記得清掉暫存目錄。",
      },
    };
  } catch (e) {
    return { success: false, message: errorMessage(e) };
  }
}

export async function svnLog(path_: string, limit = 30, connectionId?: string): Promise<SvnResult> {
  try {
    const conn = await resolveConnection(connectionId);
    const fullUrl = buildFullUrl(conn.url, path_);
    const { stdout } = await runSvn(["log", "--xml", "-l", String(limit), fullUrl], conn, getSvnTimeoutMs());
    return { success: true, data: { logs: parseSvnLogXml(stdout.toString("utf-8")) } };
  } catch (e) {
    return { success: false, message: errorMessage(e) };
  }
}

export async function svnDiff(path_: string, r1: string, r2: string, connectionId?: string): Promise<SvnResult> {
  try {
    const conn = await resolveConnection(connectionId);
    const fullUrl = buildFullUrl(conn.url, path_);
    const { stdout } = await runSvn(["diff", "-r", `${r1}:${r2}`, fullUrl], conn, getSvnTimeoutMs());
    return { success: true, data: { diff: decodeSvnText(stdout) } };
  } catch (e) {
    return { success: false, message: errorMessage(e) };
  }
}

interface SvnCatData {
  binary: boolean;
  path: string;
  revision: string;
  content?: string;
  ext?: string;
  size?: number;
  tempFilePath?: string;
  message?: string;
}

/** Thin convenience wrapper over svnCat for docx/xlsx-style files — writes to a temp file and points the caller at the standard local-file reading flow, instead of re-implementing OCR/image extraction here. */
export async function svnDocImages(path_: string, rev = "HEAD", connectionId?: string): Promise<SvnResult> {
  const result = await svnCat(path_, rev, connectionId);
  if (!result.success) return result;
  const data = result.data as SvnCatData;
  if (!data.binary) {
    return { success: false, message: "這個路徑看起來不是文件格式（docx/xlsx/pdf 等），沒有內嵌圖片可以抓。" };
  }
  return {
    success: true,
    data: {
      tempFilePath: data.tempFilePath,
      ext: data.ext,
      message: "已寫入本機暫存檔，請用專案既有的 docx 圖片抽取流程（python-docx 讀 inline shapes）處理這個路徑，讀完記得清掉暫存目錄。",
    },
  };
}

/**
 * 依關鍵字找專案庫（svn_find_repo）：比對 repo 名稱、舊名稱（別名）、簡稱、常用目錄的暱稱與路徑。
 * 找不到而且有帳號的 repo 清單快取過期時，向伺服器重讀一次再找（可能是剛新建的 repo）。
 */
export async function findRepos(query: string, limit?: number): Promise<SvnResult> {
  try {
    let { entries, cache, prefs } = await loadState();
    let hits = searchRepos(entries, cache, prefs, query, limit);
    if (hits.length === 0 && query.trim()) {
      const stale = entries.filter((e) => e.kind === "server" && isStale(cache[e.id]));
      if (stale.length) {
        cache = await refreshOnce(stale);
        hits = searchRepos(entries, cache, prefs, query, limit);
      }
    }
    return {
      success: true,
      data: {
        query,
        count: hits.length,
        hits,
        hint: hits.length
          ? "把 hits[].connectionId 填給 svn_browse、svn_cat 等工具；hits[].folders[].path 是相對於該 repo 根目錄的常用目錄，可以直接當 path 用（matched 為 true 的是這次關鍵字比對到的）。多個都像時，先用 svn_browse 看一下內容再決定，不要猜。"
          : "沒有找到符合的專案庫。可以換個關鍵字（例如 repo 名稱的一部分、簡稱、常用目錄暱稱），或呼叫 svn_list_connections 看完整清單。",
      },
    };
  } catch (e) {
    return { success: false, message: `搜尋專案庫失敗（${getConnectionsFilePath()}）：${errorMessage(e)}` };
  }
}
