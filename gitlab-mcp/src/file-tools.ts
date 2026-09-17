import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { gitlabGetRepositoryTree, gitlabGetFileContents, gitlabSearchCode } from "./gitlab-client.js";
import { toolResult, projectIdParam, type GitlabResult } from "./shared.js";

/** GitLab returns file content base64-encoded; decode it here so callers get readable text directly instead of having to decode it themselves. */
function decodeFileContent(result: GitlabResult): GitlabResult {
  if (!result.success || !result.data || typeof result.data !== "object") return result;
  const data = result.data as Record<string, unknown>;
  if (data.encoding === "base64" && typeof data.content === "string") {
    try {
      return { ...result, data: { ...data, content: Buffer.from(data.content, "base64").toString("utf-8"), encoding: "utf-8" } };
    } catch {
      return result;
    }
  }
  return result;
}

export function registerFileTools(server: McpServer): void {
  server.tool(
    "gitlab_get_repository_tree",
    "【唯讀】瀏覽指定分支底下的目錄結構（檔案與資料夾清單）。想找特定功能寫在哪個檔案，優先用 gitlab_search_code 直接搜關鍵字，比逐層瀏覽目錄快；只有在需要確認目錄結構本身（例如專案整體怎麼分模組）時才用這個。",
    {
      projectId: projectIdParam,
      ref: z.string().nullable().optional().describe("分支名稱、tag 或 commit SHA，預設專案的預設分支"),
      path: z.string().nullable().optional().describe("要瀏覽的子目錄路徑，預設專案根目錄"),
      recursive: z.boolean().nullable().optional().describe("是否遞迴列出所有子目錄內容，預設 false（只列當層）"),
    },
    async ({ projectId, ref, path, recursive }) =>
      toolResult(await gitlabGetRepositoryTree(projectId, ref ?? undefined, path ?? undefined, recursive ?? undefined))
  );

  server.tool(
    "gitlab_get_file_contents",
    "【唯讀】讀取指定分支上某個檔案的內容（自動從 base64 解碼成文字）。二進位檔案（圖片等）解碼後不會是可讀文字，不適合用這個工具檢視。",
    {
      projectId: projectIdParam,
      filePath: z.string().describe("檔案在 repo 內的完整路徑，例如 src/index.ts，不要加開頭的斜線"),
      ref: z.string().describe("分支名稱、tag 或 commit SHA，必填——不確定的話先用 gitlab_get_project 查預設分支，或用 gitlab_list_branches 查分支名稱"),
    },
    async ({ projectId, filePath, ref }) => toolResult(decodeFileContent(await gitlabGetFileContents(projectId, filePath, ref)))
  );

  server.tool(
    "gitlab_search_code",
    "【唯讀】在專案裡搜尋程式碼內容（關鍵字、函式名稱、變數名稱等），用來快速鎖定相關檔案，不用整個目錄逐一翻找。適合「這個功能寫在哪」「哪裡用到某個套件/函式」這類問題。",
    {
      projectId: projectIdParam,
      search: z.string().describe("要搜尋的關鍵字，例如函式名稱、變數名稱、或一段文字"),
      ref: z.string().nullable().optional().describe("限定搜尋的分支/tag/commit SHA，預設專案的預設分支"),
      perPage: z.number().int().positive().max(100).nullable().optional().describe("回傳筆數，預設 20"),
    },
    async ({ projectId, search, ref, perPage }) => toolResult(await gitlabSearchCode(projectId, search, ref ?? undefined, perPage ?? undefined))
  );
}
