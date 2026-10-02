// 「AI 只能讀、不能寫 SVN」的契約：工作副本的寫入函式（workcopy-client）不能被任何 MCP 工具註冊或引用。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerConnectionTools } from "../dist/connection-tools.js";
import { registerReadTools } from "../dist/read-tools.js";
import { registerHistoryTools } from "../dist/history-tools.js";

const READ_ONLY_TOOLS = ["svn_browse", "svn_cat", "svn_diff", "svn_doc_images", "svn_list_connections", "svn_log", "svn_test_connection"];

test("the registered MCP tools are exactly the read-only set", async () => {
  const server = new McpServer({ name: "svn-mcp-test", version: "0.0.0" });
  registerConnectionTools(server);
  registerReadTools(server);
  registerHistoryTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, READ_ONLY_TOOLS);
  } finally {
    await client.close();
    await server.close();
  }
});

test("no MCP entrypoint or tool file references the work copy write module", () => {
  const srcDir = path.resolve(import.meta.dirname, "..", "src");
  const entrypoints = fs.readdirSync(srcDir).filter((f) => f === "index.ts" || f.endsWith("-tools.ts"));
  assert.ok(entrypoints.length >= 4);
  for (const file of entrypoints) {
    const text = fs.readFileSync(path.join(srcDir, file), "utf-8");
    assert.doesNotMatch(text, /workcopy-client/, `${file} 不能引用 workcopy-client（會讓 AI 拿到寫入 SVN 的能力）`);
  }
});
