#!/usr/bin/env node
/**
 * Standalone, persistent HTTP front door onto the same `svn` CLI execution this MCP already
 * does for its stdio tools — this is what lets claudeweb (a Java web app) depend on svn-mcp
 * instead of the other way around. Unlike the stdio MCP entrypoint (ephemeral, spawned per
 * session by whatever's driving the pipeline), this is meant to run as its own long-lived
 * process, the same way claudeweb itself runs persistently.
 *
 * Connection data lives ONLY in svn-mcp (the single shared profile file, managed via svn-edit).
 * claudeweb never holds SVN credentials any more: it lists connections via GET /connections
 * (credentials stripped), then calls POST /run with `{ connectionId, args }` — this process resolves the
 * connection, appends --username/--password itself and refuses any URL argument that is not under
 * that connection's base URL (so a connection's credentials can never be pointed at another host).
 * The legacy form `{ args }` with credentials already embedded is still accepted for old callers.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { listConnections, resolveConnection, runSvn } from "./svn-client.js";
import { decodeSvnText } from "./svn-text.js";

const PORT = Number(process.env.SVN_MCP_HTTP_PORT) || 9095;
const HOST = process.env.SVN_BRIDGE_HOST || "127.0.0.1";
const AUTH_TOKEN = process.env.SVN_BRIDGE_TOKEN || "";
const MAX_BODY_BYTES = 1 * 1024 * 1024; // request bodies are just {args, timeoutMs} — small
const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;

// Read-only browsing subcommands only — this bridge exists so claudeweb can browse/read SVN,
// never to run arbitrary `svn` invocations from the network.
const ALLOWED_SUBCOMMANDS = new Set(["list", "ls", "cat", "log", "diff", "info"]); // ls 是 list 的別名，一樣唯讀

function containsFileScheme(args: string[]): boolean {
  return args.some((a) => /^file:\/\//i.test(a.trim()));
}

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
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

async function handleRun(req: IncomingMessage, res: ServerResponse) {
  let body: any;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    sendJson(res, 400, { error: `無法解析請求內容：${e instanceof Error ? e.message : String(e)}` });
    return;
  }

  const args = body?.args;
  if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) {
    sendJson(res, 400, { error: "缺少或格式錯誤的 args（必須是字串陣列，跟 `svn` 後面接的完整參數一致）" });
    return;
  }

  const subcommand = args[0];
  if (!ALLOWED_SUBCOMMANDS.has(subcommand)) {
    sendJson(res, 403, { error: `不允許的 svn 子命令：${subcommand}（只允許 ${[...ALLOWED_SUBCOMMANDS].join("/")}）` });
    return;
  }
  if (containsFileScheme(args)) {
    sendJson(res, 403, { error: "不允許操作 file:// 開頭的路徑，這座橋只給讀取 SVN 遠端使用" });
    return;
  }

  const timeoutMs = Number(body?.timeoutMs) > 0 ? Number(body.timeoutMs) : 30000;

  if (typeof body?.connectionId === "string" && body.connectionId.trim()) {
    await runWithConnection(res, body.connectionId, args, timeoutMs);
    return;
  }

  execFile("svn", args, { timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, encoding: "buffer" }, (error, stdout, stderr) => {
    if (error) {
      const stderrText = Buffer.isBuffer(stderr) ? decodeSvnText(stderr) : String(stderr ?? "");
      // Never fall back to error.message here: on failures where stderr is empty (svn binary
      // missing, timeout, connection-layer failure), Node's execFile bakes the full invoked
      // command — including --username/--password — into error.message. Log the real detail
      // server-side only; the caller gets a message that can never contain credentials.
      if (!stderrText.trim()) {
        console.error(`[svn-mcp-http] svn 執行失敗，未回傳給呼叫端的完整錯誤：${error.message}`);
      }
      sendJson(res, 500, { error: stderrText.trim() || `SVN 指令執行失敗（exit code: ${(error as any).code ?? "unknown"}），請確認 svn 執行檔存在且連線設定正確` });
      return;
    }
    const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout));
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": out.length });
    res.end(out);
  });
}

const URL_ARG = /^(https?|svn|svn\+ssh):\/\//i;

/** 以 connectionId 執行：帳密由這裡解析並附上，且所有 URL 參數都必須在該連線的 base URL 底下。 */
async function runWithConnection(res: ServerResponse, connectionId: string, args: string[], timeoutMs: number) {
  let conn;
  try {
    conn = await resolveConnection(connectionId);
  } catch (e) {
    sendJson(res, 404, { error: e instanceof Error ? e.message : String(e) });
    return;
  }
  if (args.some((a) => a === "--username" || a === "--password")) {
    sendJson(res, 400, { error: "以 connectionId 呼叫時，args 不可自帶 --username／--password（帳密由 svn-mcp 附上）" });
    return;
  }
  const base = conn.url.replace(/\/+$/, "").toLowerCase();
  const outside = args.find((a) => URL_ARG.test(a.trim()) && !a.trim().toLowerCase().startsWith(base));
  if (outside) {
    sendJson(res, 403, { error: `URL 不在連線「${conn.name}」的範圍內，已拒絕（帳密只能用在該連線自己的 URL 底下）` });
    return;
  }
  try {
    const { stdout } = await runSvn(args, conn, timeoutMs);
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": stdout.length });
    res.end(stdout);
  } catch (e) {
    sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
}

/** 列連線（不含帳密）；帶 ?id= 時只回該連線（可用 id、名稱、舊 id、別名、簡稱查）。 */
async function handleConnections(res: ServerResponse, id: string | null) {
  const listed = await listConnections();
  if (!listed.success) {
    sendJson(res, 500, { error: listed.message ?? "讀取連線清單失敗" });
    return;
  }
  const all = listed.data as Array<{ id: string; name: string }>;
  if (id === null) {
    sendJson(res, 200, all);
    return;
  }
  try {
    const conn = await resolveConnection(id);
    const hit = all.find((c) => c.id === conn.id);
    sendJson(res, 200, hit ?? { id: conn.id, name: conn.name, url: conn.url });
  } catch (e) {
    sendJson(res, 404, { error: e instanceof Error ? e.message : String(e) });
  }
}

function isAuthorized(req: IncomingMessage): boolean {
  if (!AUTH_TOKEN) return true; // no token configured — rely on host-binding only, stays backward compatible
  const header = req.headers["authorization"];
  return header === `Bearer ${AUTH_TOKEN}`;
}

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    sendJson(res, 200, { ok: true, service: "svn-mcp-http" });
    return;
  }
  if (req.method === "POST" && req.url === "/run") {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    handleRun(req, res).catch((e) => sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) }));
    return;
  }
  if (req.method === "GET" && (req.url === "/connections" || req.url?.startsWith("/connections?") || req.url?.startsWith("/connection?"))) {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    const id = req.url.startsWith("/connection?") ? new URL(req.url, "http://x").searchParams.get("id") || "" : null;
    handleConnections(res, id).catch((e) => sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) }));
    return;
  }
  sendJson(res, 404, { error: "not found" });
});

server.listen(PORT, HOST, () => {
  console.error(`svn-mcp HTTP bridge listening on http://${HOST}:${PORT} (POST /run, GET /connections, GET /connection?id=, GET /health)`);
});
