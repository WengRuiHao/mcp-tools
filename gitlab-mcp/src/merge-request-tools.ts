import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  gitlabListMergeRequests,
  gitlabGetMergeRequest,
  gitlabGetMergeRequestChanges,
  gitlabListMergeRequestDiscussions,
} from "./gitlab-client.js";
import { toolResult, projectIdParam, connectionIdParam } from "./shared.js";

const mrIidParam = z.number().int().positive().describe("MR 在此專案內的編號（iid），例如網址 .../merge_requests/42 裡的 42，不是全域 ID。");

export function registerMergeRequestTools(server: McpServer): void {
  server.tool(
    "gitlab_list_merge_requests",
    "【唯讀】列出專案的 Merge Request。想知道「現在有哪些 MR 在等審核／有哪些改動還沒合併」從這個開始，找到目標 MR 的 iid 之後再用 gitlab_get_merge_request 看細節、gitlab_get_merge_request_changes 看實際 diff。",
    {
      projectId: projectIdParam,
      connectionId: connectionIdParam,
      state: z.enum(["opened", "closed", "merged", "all"]).nullable().optional().describe("狀態篩選，預設 opened（只看還開著、等待處理的）"),
      targetBranch: z.string().nullable().optional().describe("只列出要合併進此分支的 MR，例如 main"),
      sourceBranch: z.string().nullable().optional().describe("只列出從此分支發出的 MR"),
      search: z.string().nullable().optional().describe("依標題/描述關鍵字搜尋"),
      perPage: z.number().int().positive().max(100).nullable().optional().describe("每頁筆數，預設 30"),
      page: z.number().int().positive().nullable().optional().describe("頁碼，預設 1"),
    },
    async ({ projectId, connectionId, state, targetBranch, sourceBranch, search, perPage, page }) =>
      toolResult(
        await gitlabListMergeRequests(connectionId ?? undefined, projectId, {
          state: state ?? undefined,
          targetBranch: targetBranch ?? undefined,
          sourceBranch: sourceBranch ?? undefined,
          search: search ?? undefined,
          perPage: perPage ?? undefined,
          page: page ?? undefined,
        })
      )
  );

  server.tool(
    "gitlab_get_merge_request",
    "【唯讀】取得單一 Merge Request 的詳細資訊（標題、描述、狀態、作者、來源/目標分支、是否有衝突等）。不含實際檔案 diff，diff 要用 gitlab_get_merge_request_changes。",
    { projectId: projectIdParam, connectionId: connectionIdParam, mrIid: mrIidParam },
    async ({ projectId, connectionId, mrIid }) => toolResult(await gitlabGetMergeRequest(connectionId ?? undefined, projectId, mrIid))
  );

  server.tool(
    "gitlab_get_merge_request_changes",
    "【唯讀】取得一個 Merge Request 實際改了哪些檔案、每個檔案的 diff 內容。適合「這個 MR 到底改了什麼」這類問題。",
    { projectId: projectIdParam, connectionId: connectionIdParam, mrIid: mrIidParam },
    async ({ projectId, connectionId, mrIid }) => toolResult(await gitlabGetMergeRequestChanges(connectionId ?? undefined, projectId, mrIid))
  );

  server.tool(
    "gitlab_list_merge_request_discussions",
    "【唯讀】列出一個 Merge Request 上的討論串（review 留言、逐行 code comment、系統事件如「已核准」）。適合「這個 MR 被review 提了什麼意見」「有沒有人已核准」這類問題。",
    {
      projectId: projectIdParam,
      connectionId: connectionIdParam,
      mrIid: mrIidParam,
      perPage: z.number().int().positive().max(100).nullable().optional().describe("每頁筆數，預設 20"),
      page: z.number().int().positive().nullable().optional().describe("頁碼，預設 1"),
    },
    async ({ projectId, connectionId, mrIid, perPage, page }) =>
      toolResult(await gitlabListMergeRequestDiscussions(connectionId ?? undefined, projectId, mrIid, perPage ?? undefined, page ?? undefined))
  );
}
