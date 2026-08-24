import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  githubListIssues,
  githubCreateIssue,
  githubGetIssue,
  githubUpdateIssue,
  githubAddIssueComment,
} from "./github-client.js";
import { toolResult } from "./shared.js";

export function registerIssueTools(server: McpServer): void {
  server.tool(
    "github_list_issues",
    "【唯讀】列出某個 repo 的 issue 清單。",
    {
      owner: z.string().describe("repo 擁有者帳號"),
      repo: z.string().describe("repo 名稱"),
      state: z.enum(["open", "closed", "all"]).nullable().optional().describe("篩選狀態，預設 open"),
    },
    async ({ owner, repo, state }) => toolResult(await githubListIssues(owner, repo, state ?? undefined))
  );

  server.tool(
    "github_create_issue",
    "在某個 repo 建立一個新 issue。",
    {
      owner: z.string().describe("repo 擁有者帳號"),
      repo: z.string().describe("repo 名稱"),
      title: z.string().describe("issue 標題"),
      body: z.string().nullable().optional().describe("issue 內容"),
      labels: z.array(z.string()).nullable().optional().describe("要加上的標籤"),
    },
    async ({ owner, repo, title, body, labels }) => toolResult(await githubCreateIssue(owner, repo, title, body ?? undefined, labels ?? undefined))
  );

  server.tool(
    "github_get_issue",
    "【唯讀】取得單一 issue 的詳細內容（含留言數、狀態等）。",
    { owner: z.string().describe("repo 擁有者帳號"), repo: z.string().describe("repo 名稱"), issueNumber: z.number().int().describe("issue 編號") },
    async ({ owner, repo, issueNumber }) => toolResult(await githubGetIssue(owner, repo, issueNumber))
  );

  server.tool(
    "github_update_issue",
    "更新某個 issue 的標題／內容／開關狀態（title/body/state 都是可選，只帶要改的欄位）。",
    {
      owner: z.string().describe("repo 擁有者帳號"),
      repo: z.string().describe("repo 名稱"),
      issueNumber: z.number().int().describe("issue 編號"),
      title: z.string().nullable().optional(),
      body: z.string().nullable().optional(),
      state: z.enum(["open", "closed"]).nullable().optional(),
    },
    async ({ owner, repo, issueNumber, title, body, state }) =>
      toolResult(
        await githubUpdateIssue(owner, repo, issueNumber, {
          title: title ?? undefined,
          body: body ?? undefined,
          state: state ?? undefined,
        })
      )
  );

  server.tool(
    "github_add_issue_comment",
    "在某個 issue（或 PR，GitHub 底層共用同一套留言 API）底下加一則留言。",
    {
      owner: z.string().describe("repo 擁有者帳號"),
      repo: z.string().describe("repo 名稱"),
      issueNumber: z.number().int().describe("issue/PR 編號"),
      body: z.string().describe("留言內容"),
    },
    async ({ owner, repo, issueNumber, body }) => toolResult(await githubAddIssueComment(owner, repo, issueNumber, body))
  );
}
