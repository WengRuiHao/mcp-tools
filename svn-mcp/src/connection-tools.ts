import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listConnections, testConnection } from "./svn-client.js";
import { toolResult, connectionIdParam } from "./shared.js";

export function registerConnectionTools(server: McpServer): void {
  server.tool(
    "svn_list_connections",
    "【唯讀】列出這個 MCP 自己 info/svn-connections.json 裡登記的所有 SVN 連線（只回傳 id/name/url，不含帳密）。呼叫其他 svn_* 工具前，如果不確定要用哪個連線，先呼叫這個確認。",
    {},
    async () => toolResult(await listConnections())
  );

  server.tool(
    "svn_test_connection",
    "【唯讀】實際測試某個 SVN 連線能不能連上（真的執行一次 `svn info`，不是只檢查設定檔有沒有這筆資料）。" +
      "**這是一個硬性把關工具**：在把某個 Asana 專案的 SA/SD 規格登記成 SVN 路徑之前，一定要先呼叫這個確認連得上，連不上就要停下來跟使用者確認 SVN 連線設定，不要假設之後會自己通。",
    { connectionId: connectionIdParam },
    async ({ connectionId }) => toolResult(await testConnection(connectionId ?? undefined))
  );
}
