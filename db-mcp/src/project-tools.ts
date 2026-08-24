import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createProject, findProject, listProjects, listConnections, toSafeConnection } from "./config-store.js";
import { toolResult, ok, fail, projectIdParam } from "./shared.js";

export function registerProjectTools(server: McpServer): void {
  server.tool(
    "db_project_create",
    "建立一個新的專案分組（對應一個建置案/翻修案/客戶案）。連線一定要先掛在某個專案底下才能建立，所以要幫某個資料庫建連線前，先確認專案存不存在，不存在就先建一個。",
    {
      name: z.string().describe("專案名稱，例如「某公司 ERP 翻修案」"),
      description: z.string().default("").describe("專案描述，選填"),
    },
    async ({ name, description }) => toolResult(ok({ project: createProject(name, description ?? "") }))
  );

  server.tool(
    "db_project_list",
    "【唯讀】列出所有已登記的專案。",
    {},
    async () => toolResult(ok({ projects: listProjects() }))
  );

  server.tool(
    "db_project_get",
    "【唯讀】專案詳情：基本資料 + 底下所有連線清單（不含密碼）。",
    { projectId: projectIdParam },
    async ({ projectId }) => {
      const project = findProject(projectId);
      if (!project) return toolResult(fail(`找不到專案 ${projectId}`));
      const connections = listConnections(projectId).map(toSafeConnection);
      return toolResult(ok({ project, connections }));
    }
  );
}
