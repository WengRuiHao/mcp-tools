import type { GithubResult } from "./github-client.js";

export type { GithubResult };

export function toolResult(result: GithubResult) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    isError: result.success !== true,
  };
}
