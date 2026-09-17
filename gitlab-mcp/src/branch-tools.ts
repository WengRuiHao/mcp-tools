import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { gitlabListBranches, gitlabGetBranch } from "./gitlab-client.js";
import { toolResult, projectIdParam } from "./shared.js";

export function registerBranchTools(server: McpServer): void {
  server.tool(
    "gitlab_list_branches",
    "【唯讀】列出專案的所有分支。想比較兩個分支、或看某分支的 commit 歷史前，可以先用這個確認分支名稱拼得對不對。",
    {
      projectId: projectIdParam,
      search: z.string().nullable().optional().describe("依分支名稱搜尋，支援部分符合"),
      perPage: z.number().int().positive().max(100).nullable().optional().describe("每頁筆數，預設 50"),
    },
    async ({ projectId, search, perPage }) => toolResult(await gitlabListBranches(projectId, search ?? undefined, perPage ?? undefined))
  );

  server.tool(
    "gitlab_get_branch",
    "【唯讀】取得單一分支的詳細資訊（最新 commit、是否受保護等）。",
    { projectId: projectIdParam, branch: z.string().describe("分支名稱，區分大小寫") },
    async ({ projectId, branch }) => toolResult(await gitlabGetBranch(projectId, branch))
  );
}
