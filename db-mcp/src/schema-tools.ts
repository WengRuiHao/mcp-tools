import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { findConnection, findProject } from "./config-store.js";
import { getDriver } from "./db-client.js";
import { openSchemaDb, replaceSchemaSnapshot, readCachedSchema, searchTables, upsertNote, listNotes } from "./schema-cache.js";
import { toolResult, ok, fail, projectIdParam, connectionIdParam } from "./shared.js";

export function registerSchemaTools(server: McpServer): void {
  server.tool(
    "db_schema",
    "【唯讀】取得某個連線的 schema（表/欄位/PK/FK/索引）。預設讀本地 SQLite 快取（快很多、不碰真正的資料庫）；" +
      "第一次用某個連線、或懷疑正式環境結構已經變了，才加 refresh:true 強制重新連線同步並覆蓋快取。" +
      "快取從沒同步過的話，即使不給 refresh 也會自動同步一次。",
    {
      connectionId: connectionIdParam,
      refresh: z.boolean().default(false).describe("true 會實際連線重新查一次 schema 並覆蓋快取"),
    },
    async ({ connectionId, refresh }) => {
      const conn = findConnection(connectionId);
      if (!conn) return toolResult(fail(`找不到連線 ${connectionId}`));

      const db = openSchemaDb(conn.projectId);
      try {
        let cached = readCachedSchema(db, connectionId);
        const needsSync = refresh || cached.lastSyncedAt === null;
        if (needsSync) {
          const driver = getDriver(conn.type);
          const introspection = await driver.introspectSchema(conn);
          replaceSchemaSnapshot(db, connectionId, { name: conn.name, dbType: conn.type, env: conn.env }, introspection);
          cached = readCachedSchema(db, connectionId);
        }
        const warning = conn.env === "prod" ? "⚠️ 這是標記為 prod 的連線，請小心操作" : undefined;
        return toolResult(ok({ ...cached, synced: needsSync, warning }));
      } catch (e: any) {
        return toolResult(fail(`取得 schema 失敗：${e.message}`));
      } finally {
        db.close();
      }
    }
  );

  server.tool(
    "db_search_tables",
    "【唯讀】在某個專案的 schema 快取裡關鍵字搜尋表名/欄位名（LIKE 模糊比對），不用把整包 schema 塞進 context 就能先定位到相關的表。要先對目標連線跑過一次 db_schema 才有快取可以搜。",
    {
      projectId: projectIdParam,
      keyword: z.string().min(1),
      connectionId: connectionIdParam.optional().describe("不給的話搜整個專案底下所有連線的快取"),
    },
    async ({ projectId, keyword, connectionId }) => {
      const project = findProject(projectId);
      if (!project) return toolResult(fail(`找不到專案 ${projectId}`));
      const db = openSchemaDb(projectId);
      try {
        return toolResult(ok(searchTables(db, keyword, connectionId)));
      } finally {
        db.close();
      }
    }
  );

  server.tool(
    "db_annotate_table",
    "把 AI（或人）分析出來的表格用途寫成筆記，存進專案層級的 schema 快取（跨 dev/test/prod 環境共用，同一張表不用每個環境各寫一次）。同一張表再寫一次會覆蓋舊筆記。",
    {
      projectId: projectIdParam,
      schemaName: z.string().default(""),
      tableName: z.string(),
      note: z.string().min(1),
    },
    async ({ projectId, schemaName, tableName, note }) => {
      const project = findProject(projectId);
      if (!project) return toolResult(fail(`找不到專案 ${projectId}`));
      const db = openSchemaDb(projectId);
      try {
        upsertNote(db, schemaName ?? "", tableName, note, "ai");
        return toolResult(ok({ schemaName: schemaName ?? "", tableName, note }));
      } finally {
        db.close();
      }
    }
  );

  server.tool(
    "db_list_notes",
    "【唯讀】列出某個專案目前所有的表格筆記。",
    { projectId: projectIdParam },
    async ({ projectId }) => {
      const project = findProject(projectId);
      if (!project) return toolResult(fail(`找不到專案 ${projectId}`));
      const db = openSchemaDb(projectId);
      try {
        return toolResult(ok({ notes: listNotes(db) }));
      } finally {
        db.close();
      }
    }
  );
}
