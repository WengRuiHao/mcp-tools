import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { addConnection, findConnection, findProject, listConnections, toSafeConnection } from "./config-store.js";
import { getDriver } from "./db-client.js";
import { toolResult, ok, fail, projectIdParam, connectionIdParam, dbTypeEnum, dbEnvEnum } from "./shared.js";

const DEFAULT_PORTS: Record<string, number> = { postgresql: 5432, mysql: 3306, mssql: 1433, oracle: 1521 };

export function registerConnectionTools(server: McpServer): void {
  server.tool(
    "db_add_connection",
    "在某個專案底下新增一筆資料庫連線設定（密碼會存在 db-mcp 自己的 info/db-connections.json，不會存在別的地方）。",
    {
      projectId: projectIdParam,
      name: z.string().describe("連線名稱，例如「ERP-Prod」"),
      env: dbEnvEnum,
      type: dbTypeEnum,
      host: z.string(),
      port: z.number().int().positive().nullable().optional().describe("不給的話用該資料庫類型的預設 port"),
      database: z.string(),
      username: z.string(),
      password: z.string(),
    },
    async ({ projectId, name, env, type, host, port, database, username, password }) => {
      const project = findProject(projectId);
      if (!project) return toolResult(fail(`找不到專案 ${projectId}，請先呼叫 db_project_create 建立專案`));
      const connection = addConnection({
        projectId,
        name,
        env,
        type,
        host,
        port: port ?? DEFAULT_PORTS[type] ?? 5432,
        database,
        username,
        password,
      });
      return toolResult(ok({ connection: toSafeConnection(connection) }));
    }
  );

  server.tool(
    "db_list_connections",
    "【唯讀】列出連線（不含密碼），可選擇只列某個專案底下的。",
    { projectId: projectIdParam.optional() },
    async ({ projectId }) => toolResult(ok({ connections: listConnections(projectId).map(toSafeConnection) }))
  );

  server.tool(
    "db_test_connection",
    "【唯讀】硬性把關工具：實際連一次資料庫確認連線設定有效。在對一個新連線跑 db_schema 或 db_query 之前，先呼叫這個確認連得上，連不上就要停下來跟使用者確認連線設定，不要假設之後會自己通。",
    { connectionId: connectionIdParam },
    async ({ connectionId }) => {
      const conn = findConnection(connectionId);
      if (!conn) return toolResult(fail(`找不到連線 ${connectionId}`));
      try {
        const driver = getDriver(conn.type);
        const result = await driver.testConnection(conn);
        return toolResult(result.ok ? ok({ ...result }) : fail(result.message, { ...result }));
      } catch (e: any) {
        return toolResult(fail(e.message));
      }
    }
  );
}
