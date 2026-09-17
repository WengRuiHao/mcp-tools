import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { gitlabWhoami, gitlabListProjects, gitlabGetProject } from "./gitlab-client.js";
import { toolResult, projectIdParam, connectionIdParam } from "./shared.js";

export function registerProjectTools(server: McpServer): void {
  server.tool(
    "gitlab_whoami",
    "【唯讀】確認目前設定的 Personal Access Token 有效，回傳登入的 GitLab 個人帳號資訊。第一次使用這支 MCP、或懷疑 token 失效/過期時，先呼叫這個確認連得上，再往下查其他資料。設定了多個連線時，這個工具也是測試「某個特定連線」能不能連上的方式。",
    { connectionId: connectionIdParam },
    async ({ connectionId }) => toolResult(await gitlabWhoami(connectionId ?? undefined))
  );

  server.tool(
    "gitlab_list_projects",
    "【唯讀】列出「我」在 GitLab 上實際參與或擁有的專案（依這支 MCP 設定的個人 Personal Access Token 判斷，不是共用帳號視角）。不知道專案的 ID 或完整路徑時，從這裡開始查，找到之後把回傳的 id 或 path_with_namespace 帶給其他工具當 projectId 用。",
    {
      connectionId: connectionIdParam,
      owned: z.boolean().nullable().optional().describe("只列自己擁有（owner）的專案，預設 false（列出所有有成員身分的專案）"),
      search: z.string().nullable().optional().describe("依名稱搜尋，不確定完整名稱時可以只給關鍵字"),
      perPage: z.number().int().positive().max(100).nullable().optional().describe("每頁筆數，預設 30"),
      page: z.number().int().positive().nullable().optional().describe("頁碼，預設 1"),
    },
    async ({ connectionId, owned, search, perPage, page }) =>
      toolResult(
        await gitlabListProjects(connectionId ?? undefined, {
          owned: owned ?? undefined,
          search: search ?? undefined,
          perPage: perPage ?? undefined,
          page: page ?? undefined,
        })
      )
  );

  server.tool(
    "gitlab_get_project",
    "【唯讀】取得單一專案的詳細資訊（預設分支、可見性、最後活動時間等）。",
    { projectId: projectIdParam, connectionId: connectionIdParam },
    async ({ projectId, connectionId }) => toolResult(await gitlabGetProject(connectionId ?? undefined, projectId))
  );
}
