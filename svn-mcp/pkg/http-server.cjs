#!/usr/bin/env node
/**
 * Standalone CommonJS build target for `pkg` — packaged into a single .exe with an embedded
 * Node runtime so claudeweb (or anyone else) can run the SVN HTTP bridge without installing
 * Node.js at all. Logic is a plain duplicate of ../src/http-server.ts (kept deliberately
 * dependency-free — only Node built-ins — specifically so it stays trivial to package here).
 * If you change the behavior, update both files.
 */
const http = require("http");
const { execFile } = require("child_process");

const PORT = Number(process.env.SVN_MCP_HTTP_PORT) || 8095;
const MAX_BODY_BYTES = 1 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
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

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

async function handleRun(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    sendJson(res, 400, { error: `無法解析請求內容：${e instanceof Error ? e.message : String(e)}` });
    return;
  }

  const args = body && body.args;
  if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) {
    sendJson(res, 400, { error: "缺少或格式錯誤的 args（必須是字串陣列，跟 `svn` 後面接的完整參數一致）" });
    return;
  }
  const timeoutMs = Number(body && body.timeoutMs) > 0 ? Number(body.timeoutMs) : 30000;

  execFile("svn", args, { timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, encoding: "buffer" }, (error, stdout, stderr) => {
    if (error) {
      const stderrText = Buffer.isBuffer(stderr) ? stderr.toString("utf-8") : String(stderr || "");
      sendJson(res, 500, { error: stderrText.trim() || error.message });
      return;
    }
    const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout));
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": out.length });
    res.end(out);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    sendJson(res, 200, { ok: true, service: "svn-mcp-http" });
    return;
  }
  if (req.method === "POST" && req.url === "/run") {
    handleRun(req, res).catch((e) => sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) }));
    return;
  }
  sendJson(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  console.error(`svn-mcp HTTP bridge (packaged exe) listening on http://localhost:${PORT} (POST /run, GET /health)`);
});
