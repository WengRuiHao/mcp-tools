import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { findConnection } from "./config-store.js";
import { getDriver } from "./db-client.js";
import { openSchemaDb, tableExistsInCache } from "./schema-cache.js";
import { checkReadOnly } from "./readonly-gate.js";
import { toolResult, ok, fail, connectionIdParam } from "./shared.js";

const MAX_ROWS = 1000;
const QUERY_TIMEOUT_MS = 30000;

function envWarning(env: string): string | undefined {
  return env === "prod" ? "⚠️ 這是標記為 prod 的連線，請小心操作" : undefined;
}

function quoteIdentifier(type: string, name: string): string {
  if (type === "mysql") return `\`${name.replace(/`/g, "``")}\``;
  if (type === "mssql") return `[${name.replace(/]/g, "]]")}]`;
  return `"${name.replace(/"/g, '""')}"`; // postgres / oracle
}

function defaultSchemaFor(conn: { type: string; database: string; username: string }): string {
  if (conn.type === "mysql") return conn.database;
  if (conn.type === "mssql") return "dbo";
  if (conn.type === "oracle") return conn.username.toUpperCase();
  return "public";
}

/** 各資料庫的「限制筆數」語法不一樣（LIMIT / TOP / FETCH FIRST），這裡統一組出來。 */
function buildSampleSql(type: string, schema: string, table: string, limit: number): string {
  const qualified = `${quoteIdentifier(type, schema)}.${quoteIdentifier(type, table)}`;
  if (type === "mssql") return `SELECT TOP ${limit} * FROM ${qualified}`;
  if (type === "oracle") return `SELECT * FROM ${qualified} FETCH FIRST ${limit} ROWS ONLY`;
  return `SELECT * FROM ${qualified} LIMIT ${limit}`; // postgres / mysql
}

const paramsSchema = z
  .record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
  .optional()
  .describe("具名參數綁定，SQL 裡用 :paramName（例如 WHERE id = :id），這裡給 { id: 123 }。避免自己把值拼進 SQL 字串。");

export function registerQueryTools(server: McpServer): void {
  server.tool(
    "db_query",
    "執行唯讀 SQL（SELECT/SHOW/DESCRIBE/EXPLAIN/WITH）。這是硬性把關的工具，寫在程式碼裡、不是靠 prompt 記得：" +
      "偵測到 INSERT/UPDATE/DELETE/DROP/ALTER/CREATE/TRUNCATE/GRANT/REVOKE/EXEC/CALL 等非唯讀關鍵字（就算包在 CTE 或子查詢裡）一律拒絕執行，" +
      "回傳的訊息會請你把 SQL 轉交給使用者在 Database 工具手動執行，不要嘗試繞過或改寫這個限制。",
    {
      connectionId: connectionIdParam,
      sql: z.string().min(1),
      params: paramsSchema,
    },
    async ({ connectionId, sql, params }) => {
      const conn = findConnection(connectionId);
      if (!conn) return toolResult(fail(`找不到連線 ${connectionId}`));

      const gate = checkReadOnly(sql);
      if (!gate.ok) return toolResult(fail(gate.reason ?? "非唯讀語句", { blocked: true, sql }));

      try {
        const driver = getDriver(conn.type);
        const result = await driver.runQuery(conn, sql, params, MAX_ROWS, QUERY_TIMEOUT_MS);
        return toolResult(ok({ ...result, warning: envWarning(conn.env) }));
      } catch (e: any) {
        return toolResult(fail(`執行失敗：${e.message}`));
      }
    }
  );

  server.tool(
    "db_sample_rows",
    "【唯讀】不用寫 SQL，直接看某張表的前幾筆資料長什麼樣子。表名要先出現在 db_schema 的快取結果裡才能查（避免直接把使用者輸入的表名拼進 SQL）。",
    {
      connectionId: connectionIdParam,
      schemaName: z.string().default(""),
      tableName: z.string(),
      limit: z.number().int().positive().max(200).default(20),
    },
    async ({ connectionId, schemaName, tableName, limit }) => {
      const conn = findConnection(connectionId);
      if (!conn) return toolResult(fail(`找不到連線 ${connectionId}`));

      const cacheDb = openSchemaDb(conn.projectId);
      let exists: boolean;
      try {
        exists = tableExistsInCache(cacheDb, connectionId, schemaName ?? "", tableName);
      } finally {
        cacheDb.close();
      }
      if (!exists) {
        return toolResult(
          fail(`快取裡找不到表 ${schemaName ? schemaName + "." : ""}${tableName}，先對這個連線呼叫 db_schema（refresh:true）同步一次`)
        );
      }

      const schema = schemaName || defaultSchemaFor(conn);
      const sql = buildSampleSql(conn.type, schema, tableName, limit);
      try {
        const driver = getDriver(conn.type);
        const result = await driver.runQuery(conn, sql, undefined, limit, QUERY_TIMEOUT_MS);
        return toolResult(ok({ ...result, warning: envWarning(conn.env) }));
      } catch (e: any) {
        return toolResult(fail(`查詢失敗：${e.message}`));
      }
    }
  );

  server.tool(
    "db_explain",
    "【唯讀】對一段 SQL 跑 EXPLAIN 分析執行計畫（幫助判斷效能問題）。跟 db_query 共用同一套唯讀把關規則。",
    {
      connectionId: connectionIdParam,
      sql: z.string().min(1).describe("要分析的 SQL（不用自己加 EXPLAIN，這個工具會自動加。目前的 EXPLAIN 語法只驗證過 postgresql/mysql，mssql/oracle 的 EXPLAIN 機制不一樣，呼叫下去大概率會執行失敗）"),
      params: paramsSchema,
    },
    async ({ connectionId, sql, params }) => {
      const conn = findConnection(connectionId);
      if (!conn) return toolResult(fail(`找不到連線 ${connectionId}`));

      const explainSql = `EXPLAIN ${sql}`;
      const gate = checkReadOnly(explainSql);
      if (!gate.ok) return toolResult(fail(gate.reason ?? "非唯讀語句", { blocked: true, sql }));

      try {
        const driver = getDriver(conn.type);
        const result = await driver.runQuery(conn, explainSql, params, MAX_ROWS, QUERY_TIMEOUT_MS);
        return toolResult(ok({ ...result, warning: envWarning(conn.env) }));
      } catch (e: any) {
        return toolResult(fail(`執行失敗：${e.message}`));
      }
    }
  );
}
