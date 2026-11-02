// 測試用假 asana-mcp（單票版）：只實作 get_ticket_snapshot 需要的 asana_task／asana_task_comments。
// 票單內容由環境變數 FAKE_ASANA_NOTES 決定（改它即可模擬 Asana 內容變動）。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "fake-asana-task", version: "0.0.0" });
const reply = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj) }] });
server.tool("asana_task", "fake", { taskGid: z.string() }, async ({ taskGid }) =>
  reply({
    success: true,
    data: { gid: taskGid, name: `票 ${taskGid}`, notes: process.env.FAKE_ASANA_NOTES ?? "內容", custom_fields: [], parent: null },
  })
);
server.tool("asana_task_comments", "fake", { taskGid: z.string() }, async () => reply({ success: true, data: [] }));
server.tool("asana_me", "fake", {}, async () => reply({ success: true, data: { gid: "ME" } }));
await server.connect(new StdioServerTransport());
