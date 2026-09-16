import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { gitlabWhoami, gitlabListProjects, gitlabGetProject } from "./gitlab-client.js";
import { toolResult } from "./shared.js";

export function registerProjectTools(server: McpServer): void {
  server.tool(
    "gitlab_whoami",
    "【唯讀】確認目前設定的 Personal Access Token 有效，回傳登入的 GitLab 個人帳號資訊。第一次使用前可以先呼叫這個確認連得上。",
    {},
    async () => toolResult(await gitlabWhoami())
  );

  server.tool(
    "gitlab_list_projects",
    "【唯讀】列出「我」在 GitLab 上實際參與或擁有的專案（依這支 MCP 設定的個人 Personal Access Token 判斷，不是共用帳號視角）。",
    {
      owned: z.boolean().nullable().optional().describe("只列自己擁有（owner）的專案，預設 false（列出所有有成員身分的專案）"),
      search: z.string().nullable().optional().describe("依名稱搜尋"),
      perPage: z.number().int().positive().max(100).nullable().optional().describe("每頁筆數，預設 30"),
      page: z.number().int().positive().nullable().optional().describe("頁碼，預設 1"),
    },
    async ({ owned, search, perPage, page }) =>
      toolResult(
        await gitlabListProjects({
          owned: owned ?? undefined,
          search: search ?? undefined,
          perPage: perPage ?? undefined,
          page: page ?? undefined,
        })
      )
  );

  server.tool(
    "gitlab_get_project",
    "【唯讀】取得單一專案的詳細資訊。",
    { projectId: z.string().describe("專案的數字 ID，或 URL 路徑（例如 group/subgroup/project）") },
    async ({ projectId }) => toolResult(await gitlabGetProject(projectId))
  );
}
