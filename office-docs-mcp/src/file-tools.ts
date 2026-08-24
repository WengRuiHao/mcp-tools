import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { unlink, stat } from "node:fs/promises";
import { toolResult } from "./shared.js";

// ---------------------------------------------------------------------------
// 通用刪除（純檔案系統操作，四種格式共用，不需要 python）
// ---------------------------------------------------------------------------

export function registerFileTools(server: McpServer): void {
  server.tool(
    "delete_file",
    "刪除一個本機檔案（docx/xlsx/pdf/csv 或任何檔案皆可，純檔案系統操作）。只會刪一般檔案，不會遞迴刪目錄。",
    { path: z.string().describe("要刪除的檔案本機絕對路徑") },
    async ({ path }) => {
      try {
        const st = await stat(path);
        if (!st.isFile()) {
          return toolResult({ success: false, message: `不是一般檔案，拒絕刪除: ${path}` });
        }
        await unlink(path);
        return toolResult({ success: true, path });
      } catch (e: any) {
        return toolResult({ success: false, message: `刪除失敗: ${e?.message ?? e}` });
      }
    }
  );
}
