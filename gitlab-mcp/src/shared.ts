import { z } from "zod";
import type { GitlabResult } from "./gitlab-client.js";

export type { GitlabResult };

/** Shared across every tool that identifies a project — kept in one place so the wording (and any future tweak to it) stays consistent everywhere. */
export const projectIdParam = z
  .string()
  .describe(
    "專案的數字 ID，或 URL 路徑（例如 group/subgroup/project）。不確定專案路徑時，先呼叫 gitlab_list_projects（可用 search 參數依名稱搜尋）查出正確值，不要用猜的。"
  );

/** Shared across every tool — lets one MCP server juggle multiple GitLab accounts/instances (e.g. two different Personal Access Tokens) instead of being locked to a single hardcoded connection. */
export const connectionIdParam = z
  .string()
  .nullable()
  .optional()
  .describe(
    "要用哪個 GitLab 連線（gitlab_list_connections 回傳的 id 或 name 皆可，例如「gitlab」「gitlab2」）。只設定了一個連線時可以省略；設定了多個又沒給這個參數，且沒有 GITLAB_CONNECTION_ID 環境變數當預設值，會報錯並列出可用選項。"
  );

export function toolResult(result: GitlabResult) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    isError: result.success !== true,
  };
}
