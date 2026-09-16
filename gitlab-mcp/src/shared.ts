import type { GitlabResult } from "./gitlab-client.js";

export type { GitlabResult };

export function toolResult(result: GitlabResult) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    isError: result.success !== true,
  };
}
