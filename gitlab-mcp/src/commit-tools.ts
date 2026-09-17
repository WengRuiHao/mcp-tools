import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { gitlabListCommits, gitlabGetCommit, gitlabGetCommitDiff, gitlabCompareBranches } from "./gitlab-client.js";
import { toolResult, projectIdParam, connectionIdParam } from "./shared.js";

export function registerCommitTools(server: McpServer): void {
  server.tool(
    "gitlab_list_commits",
    "【唯讀】列出指定分支的 commit 歷史，由新到舊。想知道「這個檔案最近改過什麼」可以搭配 filePath 篩選；只想看某一筆改動的內容，找到 sha 之後用 gitlab_get_commit_diff。",
    {
      projectId: projectIdParam,
      connectionId: connectionIdParam,
      refName: z.string().nullable().optional().describe("分支名稱、tag 或 commit SHA，預設專案的預設分支"),
      filePath: z.string().nullable().optional().describe("只列出影響此檔案路徑的 commit"),
      perPage: z.number().int().positive().max(100).nullable().optional().describe("每頁筆數，預設 30"),
      page: z.number().int().positive().nullable().optional().describe("頁碼，預設 1"),
    },
    async ({ projectId, connectionId, refName, filePath, perPage, page }) =>
      toolResult(
        await gitlabListCommits(connectionId ?? undefined, projectId, refName ?? undefined, filePath ?? undefined, perPage ?? undefined, page ?? undefined)
      )
  );

  server.tool(
    "gitlab_get_commit",
    "【唯讀】取得單一 commit 的詳細資訊（作者、時間、訊息、父 commit）。只有 metadata，不含實際改動內容，改動內容要用 gitlab_get_commit_diff。",
    { projectId: projectIdParam, connectionId: connectionIdParam, sha: z.string().describe("commit SHA，完整或前綴皆可") },
    async ({ projectId, connectionId, sha }) => toolResult(await gitlabGetCommit(connectionId ?? undefined, projectId, sha))
  );

  server.tool(
    "gitlab_get_commit_diff",
    "【唯讀】取得單一 commit 改動的檔案 diff。適合「這次改動具體改了什麼程式碼」這類問題。",
    { projectId: projectIdParam, connectionId: connectionIdParam, sha: z.string().describe("commit SHA，完整或前綴皆可") },
    async ({ projectId, connectionId, sha }) => toolResult(await gitlabGetCommitDiff(connectionId ?? undefined, projectId, sha))
  );

  server.tool(
    "gitlab_compare_branches",
    "【唯讀】比較兩個分支（或 tag、commit SHA）之間的差異，回傳中間的 commit 清單與 diff。適合「這個分支跟 main 差多少」「這次上版包含哪些改動」這類問題，比逐一翻 commit 更快。",
    {
      projectId: projectIdParam,
      connectionId: connectionIdParam,
      from: z.string().describe("比較基準（分支/tag/SHA），diff 顯示的是從這裡到 to 的變化"),
      to: z.string().describe("比較目標（分支/tag/SHA）"),
    },
    async ({ projectId, connectionId, from, to }) => toolResult(await gitlabCompareBranches(connectionId ?? undefined, projectId, from, to))
  );
}
