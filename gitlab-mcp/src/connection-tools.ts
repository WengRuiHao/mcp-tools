import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listConnections } from "./gitlab-client.js";
import { toolResult } from "./shared.js";

export function registerConnectionTools(server: McpServer): void {
  server.tool(
    "gitlab_list_connections",
    "【唯讀】列出這個 MCP 自己 info/gitlab-connections.json 裡登記的所有 GitLab 連線（只回傳 id/name/baseUrl，不含 token）。設定了不只一個連線時，呼叫其他 gitlab_* 工具前如果不確定要用哪一個，先呼叫這個確認，再把 id 或 name 帶給其他工具的 connectionId 參數。",
    {},
    async () => toolResult(await listConnections())
  );
}
