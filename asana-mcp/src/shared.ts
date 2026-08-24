import type { AsanaResult } from "./asana-client.js";

export type { AsanaResult };

export function toolResult(result: AsanaResult | { success: boolean; [key: string]: unknown }) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(result),
      },
    ],
    isError: result.success !== true,
  };
}
