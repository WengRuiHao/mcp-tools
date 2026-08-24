import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import path from "node:path";
import { getRecentCommits, isGitRepoRoot } from "./git.js";
import { registerGitDir, listRegisteredMappings } from "./config-store.js";
import { jsonResult, invalidGitDirResult } from "./shared.js";

export function registerGitRegistryTools(server: McpServer): void {
  server.tool(
    "register_git_dir",
    "將使用者提供的 git 版控目錄，登記為某個規格目錄的對應關係，之後同目錄的規格就不用再詢問一次。",
    {
      specDir: z.string().describe("規格檔案所在的目錄"),
      gitDir: z.string().describe("使用者提供的 git 版控目錄"),
    },
    async ({ specDir, gitDir }) => {
      const absGitDir = path.resolve(gitDir);
      const valid = await isGitRepoRoot(absGitDir);

      if (!valid) {
        return invalidGitDirResult(absGitDir);
      }

      await registerGitDir(specDir, absGitDir);

      return jsonResult({
        registered: true,
        specDir: path.resolve(specDir),
        gitDir: absGitDir,
      });
    }
  );

  server.tool(
    "get_recent_commits",
    "查詢指定 git 版控目錄的最新 commit 記錄，供分析師角色判讀最新程式碼變更。",
    {
      gitDir: z.string().describe("git 版控目錄"),
      limit: z.number().int().positive().max(100).default(10).describe("要抓取的 commit 數量，預設 10"),
    },
    async ({ gitDir, limit }) => {
      const absGitDir = path.resolve(gitDir);
      const valid = await isGitRepoRoot(absGitDir);

      if (!valid) {
        return invalidGitDirResult(absGitDir);
      }

      try {
        const commits = await getRecentCommits(absGitDir, limit);
        return jsonResult({ gitDir: absGitDir, commits });
      } catch (err: any) {
        return jsonResult({ error: `讀取 commit 記錄失敗: ${err.message}` }, true);
      }
    }
  );

  server.tool(
    "list_registered_git_dirs",
    "列出目前已登記的「規格目錄 -> git 版控目錄」對應關係，方便除錯或確認設定。",
    {},
    async () => {
      const mappings = await listRegisteredMappings();
      return jsonResult({ mappings });
    }
  );
}
