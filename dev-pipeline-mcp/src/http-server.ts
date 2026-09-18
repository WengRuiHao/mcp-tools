#!/usr/bin/env node
/**
 * HTTP bridge，給 PENDING_HUMAN_ACTIONS.html 的勾選/回報按鈕呼叫。
 *
 * 2026-09-17 起改為預設「跟著 stdio 版 MCP 入口（`dist/index.js`）同一個行程啟動」——使用者評估過
 * 「獨立長駐、不開 Claude Code 也能用」這個原始設計優點後，決定改成每次 Claude Code 連上
 * dev-pipeline-mcp 就自動帶起 bridge，換取不用每天手動 `npm run start:http` 的方便；代價是 bridge
 * 的存活期限變成跟著 Claude Code 的 MCP 連線走，session 斷線/結束時 bridge 也會跟著斷。
 * `startHttpBridge()` 是這個檔案的可重用進入點，`main()`／獨立執行入口仍保留，供想繼續用舊的
 * 「獨立長駐行程」模式（`npm run start:http`）的情境使用——這時多個行程搶同一個 port 純屬預期，
 * 用 `exitOnConflict` 控制：獨立執行時搶不到 port 就直接結束行程（原行為）；被 index.ts 內嵌呼叫時
 * 搶不到 port 只記一行 log 不結束行程（因為 index.ts 本身是正在跑的 MCP，不能因為 bridge 綁不到
 * port 就整個死掉——通常代表另一個 session 的 index.js 已經先綁走了，沿用那一份即可）。
 *
 * 只做幾件事：解除某個 manualAction、記錄使用者確認（record_confirmation／record_spec_confirmation）、
 * 標記「請 AI 優先重新確認」（request_reanalysis），完全重用 stdio 版工具背後同一組
 * pipeline-store.ts／pending-actions-sync.ts 函式，跟真正的 MCP 工具呼叫走同一條資料路徑、同一份
 * status.json、同一套驗證規則（例如 record_confirmation 一樣要求 stage === "tested" 才放行）——不是
 * 另外做一套繞過驗證的捷徑。**`/request-reanalysis` 純粹是寫一個旗標，這座橋沒有 LLM 能力，不會、
 * 也不能真的觸發分析**——真正的重新分析要等下一個呼叫 list_pending_tickets 的 AI（不限定廠牌/session）
 * 看到這個旗標主動處理，這是刻意的設計取捨，換取不綁定任何特定 AI CLI 就能共用。
 *
 * 這座橋只接受本機呼叫（預設 bind 127.0.0.1），沒有身分驗證——跟這個 repo 其他本機工具（svn-mcp
 * 的 bridge、claudeweb 的 DB 執行 API）同一個信任模型：安全邊界是「只有這台機器上的人碰得到」，
 * 不是額外的認證層。CORS 開放給任何 origin（包含瀏覽器直接開 file:// 報告檔案時送出的 `Origin: null`），
 * 因為呼叫端就是使用者自己在瀏覽器裡開的那份報告，不是要防外部網站呼叫。
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { readStatus, recordConfirmation, recordSpecConfirmation, resolveManualAction, requestReanalysis } from "./pipeline-store.js";
import { syncPendingActionsReport } from "./pending-actions-sync.js";
import { resolveHttpBridgeHost, resolveHttpBridgePort } from "./http-bridge-config.js";
import { invalidateActiveWarningsCache } from "./active-warnings.js";
import { appendGitHookLog } from "./git-hook-log.js";

const MAX_BODY_BYTES = 256 * 1024; // 請求本體都是單一票單的一筆勾選/確認，不會太大

function readJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}"));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function requireString(body: any, field: string): string {
  const value = body?.[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`缺少或格式錯誤的 ${field}（必須是非空字串）`);
  }
  return value;
}

async function handleResolveManualAction(req: IncomingMessage, res: ServerResponse) {
  const body = await readJsonBody(req);
  const taskGid = requireString(body, "taskGid");
  const filename = requireString(body, "filename");
  const action = requireString(body, "action");
  if (!["02-implementation.md", "03-verification.md", "04-test.md"].includes(filename)) {
    sendJson(res, 400, { success: false, message: `filename 必須是 02-implementation.md／03-verification.md／04-test.md 其中之一，收到："${filename}"` });
    return;
  }
  const result = await resolveManualAction(taskGid, filename as any, action);
  if (!result.removed) {
    sendJson(res, 409, {
      success: false,
      message: "找不到完全符合的事項，可能已經被別的地方處理掉了——請重新整理這份報告確認目前狀態。",
      currentActions: result.remaining,
    });
    return;
  }
  await syncPendingActionsReport(taskGid);
  sendJson(res, 200, { success: true, taskGid, filename, remaining: result.remaining });
}

async function handleRecordConfirmation(req: IncomingMessage, res: ServerResponse) {
  const body = await readJsonBody(req);
  const taskGid = requireString(body, "taskGid");
  if (typeof body?.confirmed !== "boolean") {
    sendJson(res, 400, { success: false, message: "缺少或格式錯誤的 confirmed（必須是布林值）" });
    return;
  }
  const confirmed: boolean = body.confirmed;
  const note: string | null = typeof body?.note === "string" && body.note.trim() ? body.note.trim() : null;

  const current = await readStatus(taskGid);
  if (current.stage !== "tested") {
    sendJson(res, 409, {
      success: false,
      message: `這張票目前 stage 是 "${current.stage}"，還沒跑到 tested 階段，無法記錄使用者確認——請重新整理這份報告確認目前狀態。`,
    });
    return;
  }
  await recordConfirmation(taskGid, confirmed, note);
  await syncPendingActionsReport(taskGid);
  sendJson(res, 200, { success: true, taskGid, confirmed });
}

async function handleRecordSpecConfirmation(req: IncomingMessage, res: ServerResponse) {
  const body = await readJsonBody(req);
  const taskGid = requireString(body, "taskGid");
  if (typeof body?.confirmed !== "boolean") {
    sendJson(res, 400, { success: false, message: "缺少或格式錯誤的 confirmed（必須是布林值）" });
    return;
  }
  const confirmed: boolean = body.confirmed;
  const note: string | null = typeof body?.note === "string" && body.note.trim() ? body.note.trim() : null;

  const current = await readStatus(taskGid);
  if (current.stage !== "sd_drafted") {
    sendJson(res, 409, {
      success: false,
      message: `這張票目前 stage 是 "${current.stage}"，還沒推進到 "sd_drafted"，無法記錄規格確認——請重新整理這份報告確認目前狀態。`,
    });
    return;
  }
  await recordSpecConfirmation(taskGid, confirmed, note);
  await syncPendingActionsReport(taskGid);
  sendJson(res, 200, { success: true, taskGid, confirmed });
}

async function handleRequestReanalysis(req: IncomingMessage, res: ServerResponse) {
  const body = await readJsonBody(req);
  const taskGid = requireString(body, "taskGid");
  await requestReanalysis(taskGid);
  await syncPendingActionsReport(taskGid);
  sendJson(res, 200, { success: true, taskGid });
}

/** install_git_hooks 裝好的 git 原生 hook（post-commit/post-merge）打回來的通知——純粹讓跨 worktree 檔案重疊示警立刻失效重算＋留一筆稽核紀錄，不做任何自動判斷或阻擋。 */
async function handleGitHookEvent(req: IncomingMessage, res: ServerResponse) {
  const body = await readJsonBody(req);
  const gitRoot = requireString(body, "gitRoot");
  const event = requireString(body, "event");
  invalidateActiveWarningsCache();
  await appendGitHookLog(gitRoot, event);
  sendJson(res, 200, { success: true });
}

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;
const ROUTES: Record<string, Handler> = {
  "/resolve-manual-action": handleResolveManualAction,
  "/record-confirmation": handleRecordConfirmation,
  "/record-spec-confirmation": handleRecordSpecConfirmation,
  "/request-reanalysis": handleRequestReanalysis,
  "/git-hook-event": handleGitHookEvent,
};

/**
 * 啟動 HTTP bridge。`exitOnConflict:true`（獨立行程模式）搶不到 port 就直接結束行程；
 * `false`（被 index.ts 內嵌呼叫）搶不到 port 只記一行 log、不影響呼叫端繼續跑下去。
 */
export function startHttpBridge(opts: { exitOnConflict: boolean } = { exitOnConflict: true }): void {
  const PORT = resolveHttpBridgePort();
  const HOST = resolveHttpBridgeHost();

  const server = createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }
    if (req.method === "GET" && req.url === "/health") {
      sendJson(res, 200, { ok: true, service: "dev-pipeline-mcp-http" });
      return;
    }
    const handler = req.method === "POST" && req.url ? ROUTES[req.url] : undefined;
    if (!handler) {
      sendJson(res, 404, { success: false, message: "not found" });
      return;
    }
    handler(req, res).catch((e) => {
      console.error(`[dev-pipeline-mcp-http] ${req.url} failed: ${e?.message ?? e}`);
      sendJson(res, 500, { success: false, message: e instanceof Error ? e.message : String(e) });
    });
  });

  server.on("error", (err: any) => {
    if (err?.code === "EADDRINUSE") {
      console.error(
        `[dev-pipeline-mcp-http] port ${PORT} 已經被佔用（另一個 dev-pipeline-mcp bridge 已經在跑）——沿用已經在跑的那一份，PENDING_HUMAN_ACTIONS.html 不受影響。`
      );
      if (opts.exitOnConflict) process.exit(1);
      return;
    }
    console.error(`[dev-pipeline-mcp-http] server error: ${err?.message ?? err}`);
  });

  server.listen(PORT, HOST, () => {
    console.error(`dev-pipeline-mcp HTTP bridge listening on http://${HOST}:${PORT} (POST /resolve-manual-action, /record-confirmation, /record-spec-confirmation, GET /health)`);
  });
}

const isMainModule = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isMainModule) {
  startHttpBridge({ exitOnConflict: true });
}
