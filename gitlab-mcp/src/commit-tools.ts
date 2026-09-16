import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { gitlabListCommits, gitlabGetCommit, gitlabGetCommitDiff, gitlabCompareBranches } from "./gitlab-client.js";
import { toolResult } from "./shared.js";

const projectIdParam = z.string().describe("專案的數字 ID，或 URL 路徑（例如 group/subgroup/project）");

export function registerCommitTools(server: McpServer): void {
  server.tool(
    "gitlab_list_commits",
    "【唯讀】列出指定分支的 commit 歷史，由新到舊。",
    {
      projectId: projectIdParam,
      refName: z.string().nullable().optional().describe("分支名稱、tag 或 commit SHA，預設專案的預設分支"),
      filePath: z.string().nullable().optional().describe("只列出影響此檔案路徑的 commit"),
      perPage: z.number().int().positive().max(100).nullable().optional().describe("每頁筆數，預設 30"),
      page: z.number().int().positive().nullable().optional().describe("頁碼，預設 1"),
    },
    async ({ projectId, refName, filePath, perPage, page }) =>
      toolResult(await gitlabListCommits(projectId, refName ?? undefined, filePath ?? undefined, perPage ?? undefined, page ?? undefined))
  );

  server.tool(
    "gitlab_get_commit",
    "【唯讀】取得單一 commit 的詳細資訊（作者、時間、訊息、父 commit）。",
    { projectId: projectIdParam, sha: z.string().describe("commit SHA") },
    async ({ projectId, sha }) => toolResult(await gitlabGetCommit(projectId, sha))
  );

  server.tool(
    "gitlab_get_commit_diff",
    "【唯讀】取得單一 commit 改動的檔案 diff。",
    { projectId: projectIdParam, sha: z.string().describe("commit SHA") },
    async ({ projectId, sha }) => toolResult(await gitlabGetCommitDiff(projectId, sha))
  );

  server.tool(
    "gitlab_compare_branches",
    "【唯讀】比較兩個分支（或 tag、commit SHA）之間的差異，回傳中間的 commit 清單與 diff。",
    {
      projectId: projectIdParam,
      from: z.string().describe("比較基準（分支/tag/SHA）"),
      to: z.string().describe("比較目標（分支/tag/SHA）"),
    },
    async ({ projectId, from, to }) => toolResult(await gitlabCompareBranches(projectId, from, to))
  );
}
