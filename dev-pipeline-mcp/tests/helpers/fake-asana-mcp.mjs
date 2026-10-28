// 測試用假 asana-mcp：以 ASANA_MCP_PATH 指向本檔，供 list_pending_tickets 端對端測試使用。
// 看板內容由環境變數 FAKE_ASANA_TASKS（JSON 陣列）決定；asana_me 回 FAKE_ASANA_ME 或固定 gid。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "fake-asana", version: "0.0.0" });
const reply = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj) }] });
server.tool("asana_board", "fake", { projectGid: z.string(), refresh: z.boolean().optional() }, async () =>
  reply({ success: true, tasks: JSON.parse(process.env.FAKE_ASANA_TASKS ?? "[]") })
);
server.tool("asana_me", "fake", {}, async () => reply({ success: true, data: { gid: "ME" } }));
await server.connect(new StdioServerTransport());
