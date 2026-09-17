import { z } from "zod";
import type { GitlabResult } from "./gitlab-client.js";

export type { GitlabResult };

/** Shared across every tool that identifies a project — kept in one place so the wording (and any future tweak to it) stays consistent everywhere. */
export const projectIdParam = z
  .string()
  .describe(
    "專案的數字 ID，或 URL 路徑（例如 group/subgroup/project）。不確定專案路徑時，先呼叫 gitlab_list_projects（可用 search 參數依名稱搜尋）查出正確值，不要用猜的。"
  );

export function toolResult(result: GitlabResult) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    isError: result.success !== true,
  };
}
