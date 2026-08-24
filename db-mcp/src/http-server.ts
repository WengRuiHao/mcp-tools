#!/usr/bin/env node
/**
 * 常駐的 HTTP bridge，給 claudeweb（人用的 Web UI）依賴，比照 svn-mcp 的 http-server.ts 模式。
 *
 * `/query` 跟 stdio 那邊給 AI 用的工具不一樣：**不套用 readonly-gate**。人在 claudeweb 網頁的
 * Database 工具手動點「執行」，本來就應該能跑 INSERT/UPDATE——這正是使用者全域規則裡
 * 「寫入語句交給使用者手動執行」的那個手動執行管道本身。
 *
 * `/query-readonly` 則是給另一種呼叫者用的：AI 驅動、但不是走 stdio MCP 協定（例如 claudeweb
 * 自己的 McpToolExecutor 把 claudeweb 當 MCP server 曝露給其他 host）。這個端點套用跟 stdio
 * db_query 工具同一套 readonly-gate，不是另外寫一份較弱的檢查。
 *
 * body 只需要帶 connectionId，密碼由這裡自己查 info/db-connections.json，不會出現在
 * claudeweb 跟這裡之間的請求內容裡。
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  listProjects,
  createProject,
  findProject,
  listConnections,
  findConnection,
  addConnection,
  updateConnection,
  deleteConnection,
  toSafeConnection,
} from "./config-store.js";
import { getDriver } from "./db-client.js";
import { openSchemaDb, replaceSchemaSnapshot, readCachedSchema } from "./schema-cache.js";
import { checkReadOnly } from "./readonly-gate.js";

const PORT = Number(process.env.DB_MCP_HTTP_PORT) || 8096;
const HOST = process.env.DB_MCP_BRIDGE_HOST || "127.0.0.1";
const AUTH_TOKEN = process.env.DB_MCP_BRIDGE_TOKEN || "";
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 1000;
const QUERY_TIMEOUT_MS = 30000;

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

function isAuthorized(req: IncomingMessage): boolean {
  if (!AUTH_TOKEN) return true;
  return req.headers["authorization"] === `Bearer ${AUTH_TOKEN}`;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (method === "GET" && path === "/health") return sendJson(res, 200, { ok: true, service: "db-mcp-http" });

  if (!isAuthorized(req)) return sendJson(res, 401, { error: "unauthorized" });

  try {
    if (method === "GET" && path === "/projects") {
      return sendJson(res, 200, { projects: listProjects() });
    }
    if (method === "POST" && path === "/projects") {
      const body = await readJsonBody(req);
      if (!body?.name) return sendJson(res, 400, { error: "缺少 name" });
      return sendJson(res, 200, { project: createProject(body.name, body.description ?? "") });
    }

    if (method === "GET" && path === "/connections") {
      const projectId = url.searchParams.get("projectId") ?? undefined;
      return sendJson(res, 200, { connections: listConnections(projectId).map(toSafeConnection) });
    }
    if (method === "POST" && path === "/connections") {
      const body = await readJsonBody(req);
      if (!body?.projectId || !findProject(body.projectId)) return sendJson(res, 400, { error: "專案不存在" });
      const connection = addConnection(body);
      return sendJson(res, 200, { connection: toSafeConnection(connection) });
    }

    const connMatch = path.match(/^\/connections\/([^/]+)$/);
    if (connMatch && method === "PUT") {
      const body = await readJsonBody(req);
      const updated = updateConnection(connMatch[1], body);
      if (!updated) return sendJson(res, 404, { error: "找不到連線" });
      return sendJson(res, 200, { connection: toSafeConnection(updated) });
    }
    if (connMatch && method === "DELETE") {
      const removed = deleteConnection(connMatch[1]);
      if (!removed) return sendJson(res, 404, { error: "找不到連線" });
      return sendJson(res, 200, { success: true });
    }

    if (method === "POST" && path === "/test-connection") {
      // 存檔前先測（表單填一填、還沒按儲存就想按「測試連線」的場景）——不需要 id，直接拿 body 裡的
      // host/port/type/... 湊一個假的 DbConnection 丟給 driver，driver.testConnection 本來就只讀這幾個欄位。
      const body = await readJsonBody(req);
      const fakeConn = {
        id: "",
        projectId: "",
        name: body?.name ?? "",
        env: "dev",
        createdAt: "",
        type: body?.type,
        host: body?.host,
        port: body?.port,
        database: body?.database,
        username: body?.username,
        password: body?.password,
      } as any;
      if (!fakeConn.type) return sendJson(res, 400, { error: "缺少 type" });
      const result = await getDriver(fakeConn.type).testConnection(fakeConn);
      return sendJson(res, 200, result);
    }

    const testMatch = path.match(/^\/connections\/([^/]+)\/test$/);
    if (testMatch && method === "POST") {
      const conn = findConnection(testMatch[1]);
      if (!conn) return sendJson(res, 404, { error: "找不到連線" });
      const result = await getDriver(conn.type).testConnection(conn);
      return sendJson(res, 200, result);
    }

    if (method === "GET" && path === "/schema") {
      const connectionId = url.searchParams.get("connectionId");
      const refresh = url.searchParams.get("refresh") === "true";
      if (!connectionId) return sendJson(res, 400, { error: "缺少 connectionId" });
      const conn = findConnection(connectionId);
      if (!conn) return sendJson(res, 404, { error: "找不到連線" });

      const db = openSchemaDb(conn.projectId);
      try {
        let cached = readCachedSchema(db, connectionId);
        const needsSync = refresh || cached.lastSyncedAt === null;
        if (needsSync) {
          const introspection = await getDriver(conn.type).introspectSchema(conn);
          replaceSchemaSnapshot(db, connectionId, { name: conn.name, dbType: conn.type, env: conn.env }, introspection);
          cached = readCachedSchema(db, connectionId);
        }
        return sendJson(res, 200, { ...cached, synced: needsSync });
      } finally {
        db.close();
      }
    }

    if (method === "POST" && path === "/query") {
      const body = await readJsonBody(req);
      const conn = findConnection(body?.connectionId);
      if (!conn) return sendJson(res, 404, { error: "找不到連線" });
      if (typeof body?.sql !== "string" || !body.sql.trim()) return sendJson(res, 400, { error: "缺少 sql" });
      // 刻意不套用 readonly-gate——這是人手動執行的管道，見檔案最上面的說明。
      const result = await getDriver(conn.type).runQuery(conn, body.sql, body.params, MAX_ROWS, QUERY_TIMEOUT_MS);
      return sendJson(res, 200, result);
    }

    if (method === "POST" && path === "/query-readonly") {
      // 給「AI 呼叫、但不是走 stdio MCP 協定」的整合用（例如 claudeweb 自己的 McpToolExecutor
      // 把 claudeweb 當 MCP server 曝露給其他 host）——跟 stdio 的 db_query 工具套用同一套
      // fail-closed 唯讀把關（readonly-gate.ts），不是重寫一份較弱的檢查。
      const body = await readJsonBody(req);
      const conn = findConnection(body?.connectionId);
      if (!conn) return sendJson(res, 404, { error: "找不到連線" });
      if (typeof body?.sql !== "string" || !body.sql.trim()) return sendJson(res, 400, { error: "缺少 sql" });

      const gate = checkReadOnly(body.sql);
      if (!gate.ok) return sendJson(res, 403, { error: gate.reason ?? "非唯讀語句", blocked: true });

      const result = await getDriver(conn.type).runQuery(conn, body.sql, body.params, MAX_ROWS, QUERY_TIMEOUT_MS);
      return sendJson(res, 200, result);
    }

    sendJson(res, 404, { error: "not found" });
  } catch (e: any) {
    sendJson(res, 500, { error: e.message ?? String(e) });
  }
}

const server = createServer((req, res) => {
  handle(req, res).catch((e) => sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) }));
});

server.listen(PORT, HOST, () => {
  console.error(`db-mcp HTTP bridge listening on http://${HOST}:${PORT}`);
});
