import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asanaMe, asanaWorkspaces, asanaProjects, asanaBoard } from "./asana-client.js";
import { toolResult } from "./shared.js";

export function registerDiscoveryTools(server: McpServer): void {
  server.tool(
    "asana_me",
    "【唯讀】取得這組共用帳號 token 對應的 Asana 使用者身份（gid/name/email）。" +
      "用來判斷「某張任務的指派人是不是這個 pipeline 帳號本人」這類條件（例如 asana-pipeline-mcp 用來過濾『內容變動但沒有指派給這個帳號』的票單），不需要使用者自己去 Asana 網頁查 gid 貼過來。",
    {},
    async () => toolResult(await asanaMe())
  );

  server.tool(
    "asana_workspaces",
    "【唯讀】列出共用 Asana 帳號可見的所有工作區（workspace），用來找 workspaceGid。",
    {},
    async () => toolResult(await asanaWorkspaces())
  );

  server.tool(
    "asana_projects",
    "【唯讀】列出指定工作區底下的所有未封存專案，用來找 projectGid。",
    {
      workspaceGid: z.string().describe("工作區 gid，來自 asana_workspaces"),
    },
    async ({ workspaceGid }) => toolResult(await asanaProjects(workspaceGid))
  );

  server.tool(
    "asana_board",
    "【唯讀】取得專案完整看板：區段（sections）+ 全部任務（含負責人、到期日、自訂欄位、完成度）。" +
      "並行拉取 + 5 分鐘記憶體快取，refresh=true 可略過快取重新抓取。",
    {
      projectGid: z.string().describe("專案 gid，來自 asana_projects"),
      refresh: z.boolean().default(false).describe("是否略過快取重新抓取"),
    },
    async ({ projectGid, refresh }) => toolResult(await asanaBoard(projectGid, refresh))
  );
}
