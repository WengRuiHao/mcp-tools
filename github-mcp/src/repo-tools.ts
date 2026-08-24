import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  githubWhoami,
  githubListRepos,
  githubCreateRepo,
  githubGetRepo,
} from "./github-client.js";
import { toolResult } from "./shared.js";

export function registerRepoTools(server: McpServer): void {
  server.tool(
    "github_whoami",
    "【唯讀】確認目前設定的 Personal Access Token 有效，回傳登入的 GitHub 帳號資訊。第一次使用前可以先呼叫這個確認連得上。",
    {},
    async () => toolResult(await githubWhoami())
  );

  server.tool(
    "github_list_repos",
    "【唯讀】列出目前帳號底下的 repository。",
    {
      visibility: z.enum(["all", "public", "private"]).nullable().optional().describe("篩選可見度，預設 all"),
      sort: z.enum(["created", "updated", "pushed", "full_name"]).nullable().optional().describe("排序方式，預設 full_name"),
      perPage: z.number().int().positive().max(100).nullable().optional().describe("回傳筆數，預設 30"),
    },
    async ({ visibility, sort, perPage }) => toolResult(await githubListRepos(visibility ?? undefined, sort ?? undefined, perPage ?? undefined))
  );

  server.tool(
    "github_create_repo",
    "在目前帳號底下建立一個新的 repository。**這是真的會建立東西的操作**，建立前務必跟使用者確認名稱、可見度（private/public）是否正確——尤其如果內容包含任何機敏資訊或客戶專屬邏輯，一定要用 private，不要自己假設用 public。**必須帶 confirm: true 才會真的執行**：這是防止指令注入誤觸發的安全機制，代表你已經明確跟使用者確認過名稱與可見度，不是自己判斷就直接建立。",
    {
      name: z.string().describe("repository 名稱"),
      private: z.boolean().default(true).describe("是否為私有 repo，預設 true"),
      description: z.string().nullable().optional().describe("repo 描述"),
      autoInit: z.boolean().default(false).describe("是否自動建立初始 README/commit（預設 false，因為通常是要 push 既有專案上去）"),
      confirm: z.literal(true).describe("必須明確傳入 true 才會真的執行，代表已經跟使用者確認過名稱與可見度"),
    },
    async ({ name, private: isPrivate, description, autoInit }) => toolResult(await githubCreateRepo(name, isPrivate, description ?? undefined, autoInit))
  );

  server.tool(
    "github_get_repo",
    "【唯讀】取得單一 repository 的詳細資訊。",
    { owner: z.string().describe("repo 擁有者帳號"), repo: z.string().describe("repo 名稱") },
    async ({ owner, repo }) => toolResult(await githubGetRepo(owner, repo))
  );
}
