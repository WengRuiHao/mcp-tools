import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { svnLog, svnDiff } from "./svn-client.js";
import { toolResult, connectionIdParam } from "./shared.js";

export function registerHistoryTools(server: McpServer): void {
  server.tool(
    "svn_log",
    "【唯讀】查詢某個 SVN 路徑的修訂記錄（commit log）。",
    {
      path: z.string().describe("要查詢的路徑（相對於這個連線的 repo 根目錄）"),
      limit: z.number().int().positive().max(200).default(30).describe("最多回傳幾筆，預設 30"),
      connectionId: connectionIdParam,
    },
    async ({ path, limit, connectionId }) => toolResult(await svnLog(path, limit, connectionId ?? undefined))
  );

  server.tool(
    "svn_diff",
    "【唯讀】比較某個 SVN 路徑兩個版本之間的差異。",
    {
      path: z.string().describe("要比較的路徑（相對於這個連線的 repo 根目錄）"),
      r1: z.string().describe("舊版本號"),
      r2: z.string().describe("新版本號"),
      connectionId: connectionIdParam,
    },
    async ({ path, r1, r2, connectionId }) => toolResult(await svnDiff(path, r1, r2, connectionId ?? undefined))
  );
}
