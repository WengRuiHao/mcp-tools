import { execFile } from "node:child_process";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getConnectionsFilePath, getDefaultConnectionId, getSvnTimeoutMs } from "./config-store.js";

export interface SvnResult {
  success: boolean;
  data?: unknown;
  message?: string;
}

interface SvnConnection {
  id: string;
  name: string;
  url: string;
  username: string;
  password: string;
}

async function loadConnections(): Promise<SvnConnection[]> {
  const raw = await readFile(getConnectionsFilePath(), "utf-8");
  return JSON.parse(raw) as SvnConnection[];
}

/** Lists connections with credentials stripped — safe to hand back to whatever's driving this MCP. */
export async function listConnections(): Promise<SvnResult> {
  try {
    const conns = await loadConnections();
    return { success: true, data: conns.map((c) => ({ id: c.id, name: c.name, url: c.url })) };
  } catch (e) {
    return { success: false, message: `讀取 SVN 連線清單失敗（${getConnectionsFilePath()}）：${e instanceof Error ? e.message : String(e)}` };
  }
}

async function resolveConnection(connectionId?: string): Promise<SvnConnection> {
  const target = connectionId?.trim() || getDefaultConnectionId();
  const conns = await loadConnections();
  if (!target) {
    throw new Error(`沒有指定 connectionId，也沒有設定 SVN_CONNECTION_ID 環境變數。可用的連線：${conns.map((c) => c.name).join("、") || "(無)"}`);
  }
  const conn = conns.find((c) => c.id === target || c.name === target);
  if (!conn) {
    throw new Error(`找不到 SVN 連線「${target}」。可用的連線：${conns.map((c) => c.name).join("、") || "(無)"}`);
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

function buildFullUrl(baseUrl: string, subPath: string): string {
  if (!subPath) return baseUrl;
  assertSafeSubPath(subPath);
  return `${baseUrl.replace(/\/+$/, "")}/${subPath.replace(/^\/+/, "")}`;
}

function runSvn(args: string[], conn: SvnConnection, timeoutMs: number): Promise<{ stdout: Buffer; stderr: string }> {
  const fullArgs = [...args, "--non-interactive", "--trust-server-cert", "--username", conn.username, "--password", conn.password];
  return new Promise((resolve, reject) => {
    execFile(
      "svn",
      fullArgs,
      { timeout: timeoutMs, maxBuffer: 50 * 1024 * 1024, encoding: "buffer" },
      (error, stdout, stderr) => {
        const stderrText = Buffer.isBuffer(stderr) ? stderr.toString("utf-8") : String(stderr ?? "");
        if (error) {
          // Never surface error.message to the caller: on failures where stderr is empty (svn
          // binary missing, timeout, connection-layer failure), Node bakes the full invoked
          // command — including --username/--password — into error.message. Log the real
          // detail server-side only; callers only ever see stderr (svn's own, credential-free
          // output) or a generic fallback.
          if (!stderrText.trim()) {
            console.error(`[svn-mcp] svn 指令失敗，未回傳給呼叫端的完整錯誤：${error.message}`);
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
    return { success: false, message: e instanceof Error ? e.message : String(e) };
  }
  try {
    const { stdout } = await runSvn(["info", conn.url], conn, getSvnTimeoutMs());
    return { success: true, data: { connectionId: conn.id, name: conn.name, url: conn.url, info: stdout.toString("utf-8") } };
  } catch (e) {
    return {
      success: false,
      message: `連不上 SVN 連線「${conn.name}」（${conn.url}）：${e instanceof Error ? e.message : String(e)}。請確認網路/VPN、帳密、或 URL 是否正確。`,
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
    return { success: false, message: e instanceof Error ? e.message : String(e) };
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
    return { success: false, message: e instanceof Error ? e.message : String(e) };
  }
}

export async function svnLog(path_: string, limit = 30, connectionId?: string): Promise<SvnResult> {
  try {
    const conn = await resolveConnection(connectionId);
    const fullUrl = buildFullUrl(conn.url, path_);
    const { stdout } = await runSvn(["log", "--xml", "-l", String(limit), fullUrl], conn, getSvnTimeoutMs());
    return { success: true, data: { logs: parseSvnLogXml(stdout.toString("utf-8")) } };
  } catch (e) {
    return { success: false, message: e instanceof Error ? e.message : String(e) };
  }
}

export async function svnDiff(path_: string, r1: string, r2: string, connectionId?: string): Promise<SvnResult> {
  try {
    const conn = await resolveConnection(connectionId);
    const fullUrl = buildFullUrl(conn.url, path_);
    const { stdout } = await runSvn(["diff", "-r", `${r1}:${r2}`, fullUrl], conn, getSvnTimeoutMs());
    return { success: true, data: { diff: stdout.toString("utf-8") } };
  } catch (e) {
    return { success: false, message: e instanceof Error ? e.message : String(e) };
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
