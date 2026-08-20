#!/usr/bin/env node
/**
 * Standalone, persistent HTTP front door onto the same `svn` CLI execution this MCP already
 * does for its stdio tools — this is what lets claudeweb (a Java web app) depend on svn-mcp
 * instead of the other way around. Unlike the stdio MCP entrypoint (ephemeral, spawned per
 * session by whatever's driving the pipeline), this is meant to run as its own long-lived
 * process, the same way claudeweb itself runs persistently.
 *
 * Deliberately takes a fully-formed `args` array (already including --username/--password/etc.)
 * rather than a named connectionId — the caller (claudeweb) owns its own connection storage/UI,
 * so there's no need for this process to know about named connections at all here; that lookup
 * only exists on the stdio MCP side (svn-client.ts's resolveConnection), for AI-driven callers
 * that don't have raw credentials to hand.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFile } from "node:child_process";

const PORT = Number(process.env.SVN_MCP_HTTP_PORT) || 8095;
const HOST = process.env.SVN_BRIDGE_HOST || "127.0.0.1";
const AUTH_TOKEN = process.env.SVN_BRIDGE_TOKEN || "";
const MAX_BODY_BYTES = 1 * 1024 * 1024; // request bodies are just {args, timeoutMs} — small
const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;

// Read-only browsing subcommands only — this bridge exists so claudeweb can browse/read SVN,
// never to run arbitrary `svn` invocations from the network.
const ALLOWED_SUBCOMMANDS = new Set(["list", "cat", "log", "diff", "info"]);

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

  execFile("svn", args, { timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, encoding: "buffer" }, (error, stdout, stderr) => {
    if (error) {
      const stderrText = Buffer.isBuffer(stderr) ? stderr.toString("utf-8") : String(stderr ?? "");
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
  sendJson(res, 404, { error: "not found" });
});

server.listen(PORT, HOST, () => {
  console.error(`svn-mcp HTTP bridge listening on http://${HOST}:${PORT} (POST /run, GET /health)`);
});
