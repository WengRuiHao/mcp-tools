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
 * Hardening: read-only subcommands only, an svn-option whitelist (no --diff-cmd / --config-* etc.), positional
 * arguments must be URLs under the connection's base URL (no `..`), loopback Host header only, JSON bodies only.
 * The old `{ args }`-with-embedded-credentials form has been removed: every call now needs a connectionId.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { listConnections, resolveConnection, runSvn } from "./svn-client.js";
import { errorMessage } from "./util.js";

const PORT = Number(process.env.SVN_MCP_HTTP_PORT) || 9095;
const HOST = process.env.SVN_BRIDGE_HOST || "127.0.0.1";
const AUTH_TOKEN = process.env.SVN_BRIDGE_TOKEN || "";
const MAX_BODY_BYTES = 1 * 1024 * 1024; // request bodies are just {args, timeoutMs} — small

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
    sendJson(res, 400, { error: `無法解析請求內容：${errorMessage(e)}` });
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

  if (typeof body?.connectionId !== "string" || !body.connectionId.trim()) {
    sendJson(res, 400, { error: "缺少 connectionId（連線資料與帳密只在 svn-mcp：先用 GET /connections 查可用的連線）" });
    return;
  }
  await runWithConnection(res, body.connectionId, args, timeoutMs);
}

const URL_ARG = /^(https?|svn|svn\+ssh):\/\//i;

// svn 選項白名單：只放行瀏覽／讀取需要的。其餘一律拒絕——例如 `diff --diff-cmd <程式>` 會執行任意程式、
// `--config-option`／`--config-dir` 可以改 proxy 或設定把帳密送去別處。
const FLAGS_NO_VALUE = new Set(["--xml", "-v", "--verbose", "-q", "--quiet"]);
const FLAGS_WITH_VALUE = new Set(["-r", "--revision", "-l", "--limit", "--depth"]);

/** 拆解 args（第 0 個是子命令）：回傳第一個不在白名單的選項（沒有則 null）與所有位置參數。 */
function parseArgs(args: string[]): { disallowed: string | null; positionals: string[] } {
  const positionals: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("-") || a === "-") {
      positionals.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = eq === -1 ? a : a.slice(0, eq);
    if (FLAGS_NO_VALUE.has(name) && eq === -1) continue;
    if (FLAGS_WITH_VALUE.has(name)) {
      if (eq === -1) i++; // 下一個參數是這個選項的值
      continue;
    }
    return { disallowed: a, positionals };
  }
  return { disallowed: null, positionals };
}

/** url 必須等於 base，或在 base 底下（下一個字元是 / 或 @peg）；避免 base=.../repo-a 誤放行 .../repo-a2。 */
function isUnderBase(url: string, base: string): boolean {
  const u = url.trim().toLowerCase();
  if (!u.startsWith(base)) return false;
  const next = u.charAt(base.length);
  return next === "" || next === "/" || next === "@";
}

/** 路徑裡有 .. 區段（含 %2e%2e 編碼）就拒絕，避免從連線底下爬到別的 repo。 */
function hasDotDotSegment(url: string): boolean {
  let decoded = url;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    // 無法解碼就用原字串判斷
  }
  return decoded.split(/[/\\]/).some((seg) => seg.replace(/@.*$/, "") === "..");
}

/** 以 connectionId 執行：帳密由這裡解析並附上，且所有 URL 參數都必須在該連線的 base URL 底下。 */
async function runWithConnection(res: ServerResponse, connectionId: string, args: string[], timeoutMs: number) {
  let conn;
  try {
    conn = await resolveConnection(connectionId);
  } catch (e) {
    sendJson(res, 404, { error: errorMessage(e) });
    return;
  }
  const { disallowed, positionals } = parseArgs(args);
  if (disallowed) {
    sendJson(res, 403, { error: `不允許的 svn 選項：${disallowed}（只放行 ${[...FLAGS_NO_VALUE, ...FLAGS_WITH_VALUE].join(" ")}；帳密由 svn-mcp 附上，不可自帶）` });
    return;
  }
  const base = conn.url.replace(/\/+$/, "").toLowerCase();
  const bad = positionals.find((a) => !URL_ARG.test(a.trim()) || !isUnderBase(a, base) || hasDotDotSegment(a));
  if (bad !== undefined) {
    sendJson(res, 403, { error: `參數不是連線「${conn.name}」底下的 URL，已拒絕（只接受該連線 URL 底下的路徑，不可含 ..，帳密不能拿去打別的位置）` });
    return;
  }
  try {
    const { stdout } = await runSvn(args, conn, timeoutMs);
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": stdout.length });
    res.end(stdout);
  } catch (e) {
    sendJson(res, 500, { error: errorMessage(e) });
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
    sendJson(res, 404, { error: errorMessage(e) });
  }
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** 綁在本機（預設）時，只接受 Host 是本機名稱的請求：擋掉 DNS rebinding（惡意網站把網域指到 127.0.0.1 來讀這裡的資料）。 */
function isAllowedHost(req: IncomingMessage): boolean {
  if (!LOOPBACK_HOSTS.has(HOST)) return true; // 刻意對外綁定時改靠 SVN_BRIDGE_TOKEN
  const host = req.headers.host;
  if (!host) return true;
  const name = host.toLowerCase().replace(/:\d+$/, "");
  return LOOPBACK_HOSTS.has(name);
}

function isJsonRequest(req: IncomingMessage): boolean {
  return String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json");
}

function isAuthorized(req: IncomingMessage): boolean {
  if (!AUTH_TOKEN) return true; // no token configured — rely on host-binding only, stays backward compatible
  const header = req.headers["authorization"];
  return header === `Bearer ${AUTH_TOKEN}`;
}

const server = createServer((req, res) => {
  if (!isAllowedHost(req)) {
    sendJson(res, 403, { error: "forbidden host" });
    return;
  }
  if (req.method === "GET" && req.url === "/health") {
    sendJson(res, 200, { ok: true, service: "svn-mcp-http" });
    return;
  }
  if (req.method === "POST" && req.url === "/run") {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    if (!isJsonRequest(req)) {
      sendJson(res, 415, { error: "Content-Type 必須是 application/json" });
      return;
    }
    handleRun(req, res).catch((e) => sendJson(res, 500, { error: errorMessage(e) }));
    return;
  }
  if (req.method === "GET" && (req.url === "/connections" || req.url?.startsWith("/connections?") || req.url?.startsWith("/connection?"))) {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    const id = req.url.startsWith("/connection?") ? new URL(req.url, "http://x").searchParams.get("id") || "" : null;
    handleConnections(res, id).catch((e) => sendJson(res, 500, { error: errorMessage(e) }));
    return;
  }
  sendJson(res, 404, { error: "not found" });
});

server.listen(PORT, HOST, () => {
  console.error(`svn-mcp HTTP bridge listening on http://${HOST}:${PORT} (POST /run, GET /connections, GET /connection?id=, GET /health)`);
});
