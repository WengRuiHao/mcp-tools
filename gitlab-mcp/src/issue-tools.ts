import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { gitlabListIssues, gitlabGetIssue } from "./gitlab-client.js";
import { toolResult, projectIdParam } from "./shared.js";

const issueIidParam = z.number().int().positive().describe("Issue 在此專案內的編號（iid），例如網址 .../issues/17 裡的 17，不是全域 ID。");

export function registerIssueTools(server: McpServer): void {
  server.tool(
    "gitlab_list_issues",
    "【唯讀】列出專案的 Issue。想知道「現在有哪些待處理的問題/需求」從這個開始，找到目標 issue 的 iid 之後再用 gitlab_get_issue 看細節。",
    {
      projectId: projectIdParam,
      state: z.enum(["opened", "closed", "all"]).nullable().optional().describe("狀態篩選，預設 opened（只看還沒關閉的）"),
      search: z.string().nullable().optional().describe("依標題/描述關鍵字搜尋"),
      labels: z.string().nullable().optional().describe("依標籤篩選，多個標籤用逗號分隔，例如 bug,urgent"),
      perPage: z.number().int().positive().max(100).nullable().optional().describe("每頁筆數，預設 30"),
      page: z.number().int().positive().nullable().optional().describe("頁碼，預設 1"),
    },
    async ({ projectId, state, search, labels, perPage, page }) =>
      toolResult(
        await gitlabListIssues(projectId, {
          state: state ?? undefined,
          search: search ?? undefined,
          labels: labels ?? undefined,
          perPage: perPage ?? undefined,
          page: page ?? undefined,
        })
      )
  );

  server.tool(
    "gitlab_get_issue",
    "【唯讀】取得單一 Issue 的詳細資訊（標題、描述、狀態、標籤、指派人等）。",
    { projectId: projectIdParam, issueIid: issueIidParam },
    async ({ projectId, issueIid }) => toolResult(await gitlabGetIssue(projectId, issueIid))
  );
}
