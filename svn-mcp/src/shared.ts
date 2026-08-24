import { z } from "zod";
import type { SvnResult } from "./svn-client.js";

export type { SvnResult };

export function toolResult(result: SvnResult) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    isError: result.success !== true,
  };
}

export const connectionIdParam = z
  .string()
  .nullable()
  .optional()
  .describe("要用哪個 SVN 連線（svn_list_connections 回傳的 id 或 name 皆可）。不給的話用 SVN_CONNECTION_ID 環境變數當預設值。");
