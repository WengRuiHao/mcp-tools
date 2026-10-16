/**
 * svn-edit 的本機 HTTP 服務（只綁 127.0.0.1）：控制頁 + /api/*。這是「使用者在網頁上按按鈕」的唯一入口，
 * **不是 MCP 工具**，AI 碰不到；真正動 SVN 的邏輯全在 remote-edit-client。
 *
 * 防護：
 * - Host 標頭必須是 127.0.0.1／localhost 加上實際埠號（擋 DNS rebinding）；
 * - GET /health 以外的 /api/* 一律要 `X-Edit-Token`（每次啟動隨機產生，只嵌在這個服務自己回傳的頁面裡）；
 * - 有 Origin 標頭的請求，Origin 必須是這個服務自己（擋其他網站用 fetch 偷打）；
 * - GET 永遠不會改動任何狀態：從 dev-pipeline 按鈕連過來的 /edit?... 只會顯示確認頁，要使用者按「開始編輯」才會真的取出檔案。
 */
import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { deleteServer, listPublicConnections, listPublicServers, refreshAllServers, refreshServer, saveServer, testServerLogin, ConnectionInputError, type ServerInput } from "./connections-store.js";
import { FAVICON_ICO_BASE64 } from "./edit-icon-data.js";
import { markOpened, readRepoPrefs, reorderStars, setFolderNickname, setFolderStar, setLocalPath, setNickname, setStar, setSyncLocal } from "./repo-prefs.js";
import { commitEditAndSync } from "./local-sync.js";
import { deleteRemoteFileAndSync } from "./remote-delete.js";
import { renderPage } from "./edit-ui.js";
import { openForEdit, openFile, revealFile } from "./os-open.js";
import { cancelImport, commitImport, planImport, stageImportFile, startImportBatch } from "./remote-import-batch.js";
import { browseRemote, discardEdit, EditError, exportLatest, getEditStatus, getUpgradePlan, importNewFile, listEdits, openEdit, viewRemoteFile, type EditErrorCode } from "./remote-edit-client.js";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const SVN_RECHECK_MS = 10_000;

const STATUS_BY_CODE: Record<EditErrorCode, number> = {
  INVALID_INPUT: 400,
  NOT_FOUND: 404,
  ALREADY_EDITING: 409,
  FILE_LOCKED: 409,
  ALREADY_EXISTS: 409,
  EDITOR_STILL_OPEN: 409,
  NO_CHANGES: 409,
  REMOTE_CHANGED: 409,
  FILE_TOO_LARGE: 413,
  UNLOCK_FAILED: 500,
};

export interface EditServer {
  server: Server;
  token: string;
  /** 最近一次收到請求的時間（毫秒），給閒置自動結束判斷用。 */
  lastActivity(): number;
  /** 目前還在處理中的請求數（例如正在上傳／commit）；有的話不能結束。 */
  inflight(): number;
  /** 控制頁的視窗被關掉（pagehide）時，網頁會通知一次；重新整理也會通知，所以呼叫端要自己確認之後有沒有新請求。 */
  onWindowClosing(listener: () => void): void;
}

class HttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly code?: string) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" });
  res.end(body);
}

const FAVICON_ICO = Buffer.from(FAVICON_ICO_BASE64, "base64");

/** 分頁／視窗圖標（多尺寸 ICO，系統依 DPI 選最清楚的一個）。只是靜態圖，不需要 token。 */
function sendIcon(res: ServerResponse): void {
  res.writeHead(200, { "Content-Type": "image/x-icon", "Content-Length": FAVICON_ICO.length, "Cache-Control": "public, max-age=3600" });
  res.end(FAVICON_ICO);
}

const LARGE_ICON_SIZE = 256;

/** 從 ICO 容器取出指定尺寸的 PNG 內容（本專案產生的 ICO 每筆都是 PNG）；找不到回傳 null。 */
function extractPngFromIco(ico: Buffer, size: number): Buffer | null {
  const count = ico.readUInt16LE(4);
  for (let i = 0; i < count; i++) {
    const entry = 6 + 16 * i;
    const width = ico[entry] || 256;
    if (width !== size) continue;
    const length = ico.readUInt32LE(entry + 8);
    const offset = ico.readUInt32LE(entry + 12);
    return ico.subarray(offset, offset + length);
  }
  return null;
}

const FAVICON_PNG = extractPngFromIco(FAVICON_ICO, LARGE_ICON_SIZE);

/** 統一的大圖（256px PNG）：Edge 應用程式視窗只拿網頁圖標縮放，給單一大圖才不會被小尺寸硬放大。 */
function sendLargeIcon(res: ServerResponse): void {
  if (!FAVICON_PNG) return sendIcon(res);
  res.writeHead(200, { "Content-Type": "image/png", "Content-Length": FAVICON_PNG.length, "Cache-Control": "public, max-age=3600" });
  res.end(FAVICON_PNG);
}

function sendPage(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
    "Cache-Control": "no-store",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
  });
  res.end(html);
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, "請求內容太大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new HttpError(400, "無法解析請求內容（必須是 JSON 物件）"));
      }
    });
    req.on("error", reject);
  });
}

/** 讀原始位元組內容（上傳新檔案用），超過上限就中止。 */
function readRawBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, `檔案太大，上限 ${limit / 1024 / 1024} MB`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function str(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === "string" ? value : "";
}

// ---- svn 命令列工具是否可用 ----
let svnCheck: { at: number; ok: boolean } | null = null;
function isSvnAvailable(): Promise<boolean> {
  if (svnCheck && (svnCheck.ok || Date.now() - svnCheck.at < SVN_RECHECK_MS)) return Promise.resolve(svnCheck.ok);
  return new Promise((resolve) => {
    execFile("svn", ["--version", "--quiet"], { timeout: 5000, windowsHide: true }, (error) => {
      svnCheck = { at: Date.now(), ok: !error };
      resolve(!error);
    });
  });
}

// ---- API 處理 ----
async function buildState(): Promise<unknown> {
  let connections: unknown[] = [];
  let servers: unknown[] = [];
  let connectionsError: string | null = null;
  try {
    connections = await listPublicConnections();
    servers = await listPublicServers();
  } catch (e) {
    connectionsError = e instanceof Error ? e.message : String(e);
  }
  const sessions = [];
  for (const session of await listEdits()) {
    try {
      sessions.push(await getEditStatus(session.id));
    } catch {
      // 單一項目讀取失敗不影響其他項目
    }
  }
  return { connections, servers, repoPrefs: await readRepoPrefs(), connectionsError, configured: connections.length > 0, sessions, svnAvailable: await isSvnAvailable() };
}

type ApiHandler = (body: Record<string, unknown>) => Promise<unknown>;

const API_POST: Record<string, ApiHandler> = {
  "/api/open": async (body) => {
    const session = await openEdit({ connectionId: str(body, "connection") || undefined, path: str(body, "path"), ticket: str(body, "ticket") || undefined });
    openForEdit(session.filePath);
    return { session };
  },
  "/api/view": async (body) => {
    // 唯讀檢視（PDF 等）：匯出最新版到暫存資料夾，用預設程式開啟；不建立編輯項目
    const result = await viewRemoteFile({ connectionId: str(body, "connection") || undefined, path: str(body, "path") });
    openFile(result.path);
    return result;
  },
  "/api/commit": (body) => {
    // upgrade：true 或 { newName }＝升級版本（舊版複製到 old 資料夾、新版版本號 +1）
    const up = body.upgrade;
    const upgrade = up && typeof up === "object" ? { newName: str(up as Record<string, unknown>, "newName") || undefined } : up === true ? {} : undefined;
    return commitEditAndSync(str(body, "id"), str(body, "message"), upgrade);
  },
  // 刪除遠端單一檔案（成功後依「同步本地端」開關更新本地工作目錄）
  "/api/delete": (body) => deleteRemoteFileAndSync({ connectionId: str(body, "connection") || undefined, path: str(body, "path"), message: str(body, "message") }),
  "/api/discard": (body) => discardEdit(str(body, "id")),
  "/api/reopen": async (body) => {
    const { session } = await getEditStatus(str(body, "id"));
    openForEdit(session.filePath);
    return { path: session.filePath };
  },
  "/api/export-latest": async (body) => {
    const result = await exportLatest(str(body, "id"));
    revealFile(result.path);
    return result;
  },
  "/api/import/start": () => startImportBatch(),
  "/api/import/plan": (body) => planImport({ batch: str(body, "batch"), connectionId: str(body, "connection") || undefined, targetDir: str(body, "targetDir") }),
  "/api/import/commit": (body) =>
    commitImport({ batch: str(body, "batch"), connectionId: str(body, "connection") || undefined, targetDir: str(body, "targetDir"), message: str(body, "message"), ticket: str(body, "ticket") || undefined }),
  "/api/import/cancel": (body) => cancelImport(str(body, "batch")),
  "/api/servers": async (body) => ({ server: await saveServer(body as unknown as ServerInput) }),
  "/api/servers/test": async (body) => ({ test: await testServerLogin(body as unknown as ServerInput) }),
  "/api/servers/refresh": async (body) => ({ server: await refreshServer(str(body, "id")) }),
  "/api/servers/delete": async (body) => deleteServer(str(body, "id")),
  "/api/servers/refresh-all": () => refreshAllServers(),
  // 瀏覽 SVN 目錄的偏好：星星、排序、最近開過、簡稱（都回傳最新的整份偏好）
  "/api/repo-prefs/star": async (body) => ({ prefs: await setStar(body.name, body.starred === true) }),
  "/api/repo-prefs/reorder": async (body) => ({ prefs: await reorderStars(body.order) }),
  "/api/repo-prefs/open": async (body) => ({ prefs: await markOpened(body.name) }),
  "/api/repo-prefs/nickname": async (body) => ({ prefs: await setNickname(body.name, body.nickname) }),
  "/api/repo-prefs/sync-local": async (body) => ({ prefs: await setSyncLocal(body.enabled) }),
  "/api/repo-prefs/local-path": async (body) => ({ prefs: await setLocalPath(body.repo, body.path) }),
  "/api/repo-prefs/folder": async (body) => ({ prefs: await setFolderStar(body.repo, body.path, body.starred === true) }),
  "/api/repo-prefs/folder-nickname": async (body) => ({ prefs: await setFolderNickname(body.repo, body.path, body.nickname) }),
};

function errorResponse(res: ServerResponse, error: unknown): void {
  if (error instanceof HttpError) return sendJson(res, error.status, { error: error.message, code: error.code });
  if (error instanceof EditError) return sendJson(res, STATUS_BY_CODE[error.code] ?? 500, { error: error.message, code: error.code });
  if (error instanceof ConnectionInputError) return sendJson(res, 400, { error: error.message, code: "INVALID_INPUT" });
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[svn-edit] 未預期的錯誤：${message}`);
  sendJson(res, 500, { error: message });
}

export function createEditServer(): EditServer {
  const token = randomBytes(32).toString("hex");
  const tokenBuffer = Buffer.from(token);
  let lastActivityAt = Date.now();
  let inflightCount = 0;
  const closingListeners: Array<() => void> = [];

  function tokenOk(req: IncomingMessage): boolean {
    const given = req.headers["x-edit-token"];
    if (typeof given !== "string") return false;
    const givenBuffer = Buffer.from(given);
    return givenBuffer.length === tokenBuffer.length && timingSafeEqual(givenBuffer, tokenBuffer);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const port = req.socket.localPort;
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!allowedHosts.includes(String(req.headers.host ?? "").toLowerCase())) throw new HttpError(403, "不允許的 Host");

    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const route = url.pathname;

    if (req.method === "GET" && route === "/health") return sendJson(res, 200, { ok: true, service: "svn-edit" });
    if (req.method === "GET" && (route === "/" || route === "/edit")) return sendPage(res, renderPage(token));
    if (req.method === "GET" && route === "/favicon.ico") return sendIcon(res);
    if (req.method === "GET" && route === "/favicon.png") return sendLargeIcon(res);

    if (!route.startsWith("/api/")) throw new HttpError(404, "not found");
    if (!tokenOk(req)) throw new HttpError(401, "unauthorized");
    const origin = req.headers.origin;
    if (typeof origin === "string" && !allowedHosts.map((h) => `http://${h}`).includes(origin.toLowerCase())) throw new HttpError(403, "不允許的 Origin");

    if (req.method === "POST" && route === "/api/window-closing") {
      closingListeners.forEach((listener) => listener());
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "GET" && route === "/api/state") return sendJson(res, 200, await buildState());
    if (req.method === "GET" && route === "/api/upgrade-plan") {
      return sendJson(res, 200, await getUpgradePlan(url.searchParams.get("id") ?? "", url.searchParams.get("newName") || undefined));
    }
    if (req.method === "GET" && route === "/api/browse") {
      return sendJson(res, 200, await browseRemote(url.searchParams.get("connection") || undefined, url.searchParams.get("path") ?? ""));
    }
    if (req.method === "POST" && route === "/api/import") {
      // 檔案內容是原始位元組（不是 JSON），其餘參數放在網址的查詢字串
      const content = await readRawBody(req, MAX_UPLOAD_BYTES);
      const q = url.searchParams;
      const result = await importNewFile({ connectionId: q.get("connection") || undefined, path: q.get("path") ?? "", content, message: q.get("message") ?? "", ticket: q.get("ticket") || undefined });
      return sendJson(res, 200, result);
    }
    if (req.method === "POST" && route === "/api/import/stage") {
      // 批次上傳的單一檔案：內容是原始位元組，批次 id 與相對路徑放在查詢字串
      const content = await readRawBody(req, MAX_UPLOAD_BYTES);
      const mtime = Number(url.searchParams.get("mtime"));
      return sendJson(res, 200, await stageImportFile(url.searchParams.get("batch"), url.searchParams.get("path"), content, Number.isFinite(mtime) && mtime > 0 ? mtime : undefined));
    }
    const handler = req.method === "POST" ? API_POST[route] : undefined;
    if (!handler) throw new HttpError(404, "not found");
    sendJson(res, 200, await handler(await readJsonBody(req)));
  }

  const server = createServer((req, res) => {
    lastActivityAt = Date.now();
    inflightCount++;
    res.on("close", () => void inflightCount--);
    handle(req, res).catch((e) => errorResponse(res, e));
  });
  return { server, token, lastActivity: () => lastActivityAt, inflight: () => inflightCount, onWindowClosing: (listener) => void closingListeners.push(listener) };
}
