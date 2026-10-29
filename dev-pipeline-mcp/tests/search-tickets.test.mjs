// list_pending_tickets 的 search 參數：純函式 + 以假 asana-mcp 做端對端（含報告檔不受影響）。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "search-tickets-"));
const dataDir = path.join(tmpRoot, "data");
const projectDir = path.join(tmpRoot, "proj");
await fs.mkdir(dataDir, { recursive: true });
await fs.mkdir(projectDir, { recursive: true });
process.env.ASANA_PIPELINE_DATA_DIR = dataDir;
process.env.ASANA_MCP_PATH = fileURLToPath(new URL("./helpers/fake-asana-mcp.mjs", import.meta.url));
process.env.PIPELINE_ASANA_USER_GID = "ME";

const cf = (name, v) => [{ name, display_value: v }];
const board = [
  { gid: "g1", name: "修正報表匯出", custom_fields: cf("單號", "UGLT-159"), due_on: "2026-10-01" },
  { gid: "g2", name: "UGLT-1590 另一張", custom_fields: cf("單號", "UGLT-1590") },
  { gid: "g3", name: "Login 逾時處理", custom_fields: [] },
  { gid: "g4", name: "待確認的票", custom_fields: cf("單號", "UGLT-7") },
];
process.env.FAKE_ASANA_TASKS = JSON.stringify(board);

const store = await import("../dist/pipeline-store.js");
const registry = await import("../dist/project-registry.js");
await registry.registerProjectDir("P1", projectDir);
const { filterAndLimitTickets, detectTicketNumber } = await import("../dist/ticket-list-filter.js");
const { registerTicketLifecycleTools } = await import("../dist/ticket-lifecycle-tools.js");
const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const server = new McpServer({ name: "t", version: "0" });
registerTicketLifecycleTools(server);
const [a, b] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "c", version: "0" });
await Promise.all([server.connect(a), client.connect(b)]);

after(async () => {
  await client.close();
  const { closeChildMcpClients } = await import("../dist/mcp-clients.js");
  await closeChildMcpClients();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function list(args) {
  const r = await client.callTool({ name: "list_pending_tickets", arguments: { projectGid: "P1", onlyAssignedToMe: false, ...args } });
  return JSON.parse(r.content[0].text);
}

test("pure: ticket number equality, title contains, case-insensitive", () => {
  const items = [
    { name: "報表", ticketNumber: "UGLT-159" },
    { name: "UGLT-1590 x", ticketNumber: "UGLT-1590" },
    { name: "Login Timeout" },
  ];
  const names = (s) => filterAndLimitTickets(items, { search: s, today: "2026-10-01" }).tickets.map((t) => t.name);
  assert.deepEqual(names("uglt-159"), ["報表", "UGLT-1590 x"]);
  assert.deepEqual(names("LOGIN"), ["Login Timeout"]);
  assert.deepEqual(names("nope"), []);
  assert.equal(filterAndLimitTickets(items, { search: "  ", today: "2026-10-01" }).tickets, items);
});

test("detectTicketNumber prefers the 單號 field", () => {
  assert.equal(detectTicketNumber({ custom_fields: [{ name: "x", display_value: "AB-1" }, { name: "單號", display_value: "UGLT-9" }] }), "UGLT-9");
  assert.equal(detectTicketNumber({ custom_fields: [] }), null);
});

test("e2e: search by ticket number returns taskGid + number + name; other lists stay complete", async () => {
  await store.assignTicketDir(projectDir, "g4", "Proj", "UGLT-7", null, "待確認的票");
  await store.advanceStage("g4", "sd_drafted");
  const r = await list({ search: "uglt-159" });
  assert.equal(r.success, true);
  // 票號完全相等 + 標題包含：g1(票號相等)、g2(標題含 UGLT-1590 ⊃ uglt-159)
  assert.deepEqual(r.tickets.map((t) => t.taskGid).sort(), ["g1", "g2"]);
  const g1 = r.tickets.find((t) => t.taskGid === "g1");
  assert.equal(g1.ticketNumber, "UGLT-159");
  assert.equal(g1.name, "修正報表匯出");
  assert.deepEqual(r.filters, { search: "uglt-159" });
  // g4 卡在 sd_drafted，進 awaitingSpecConfirmation，不受 search 影響
  assert.deepEqual(r.awaitingSpecConfirmation.map((t) => t.taskGid), ["g4"]);
});

test("e2e: exact ticket number does not match a longer number's number, title substring works, no match is explained", async () => {
  const exact = await list({ search: "UGLT-1590" });
  assert.deepEqual(exact.tickets.map((t) => t.taskGid), ["g2"]);
  const byTitle = await list({ search: "逾時" });
  assert.deepEqual(byTitle.tickets.map((t) => t.taskGid), ["g3"]);
  const none = await list({ search: "ZZZ-999" });
  assert.deepEqual(none.tickets, []);
  assert.equal(none.count, 0);
  assert.match(none.searchNote, /ZZZ-999/);
  assert.equal(none.awaitingSpecConfirmationCount, 1);
});

test("e2e: search never shrinks the PENDING_HUMAN_ACTIONS.html report", async () => {
  const reportPath = path.join(projectDir, ".asana-pipeline", "Proj", "PENDING_HUMAN_ACTIONS.html");
  await list({ projectName: "Proj" });
  const full = await fs.readFile(reportPath, "utf-8");
  await list({ projectName: "Proj", search: "ZZZ-999" });
  const filtered = await fs.readFile(reportPath, "utf-8");
  assert.ok(full.includes("g4") || full.includes("UGLT-7"));
  assert.equal(filtered.replace(/\d{4}-\d\d-\d\d[T ][\d:.]+Z?/g, ""), full.replace(/\d{4}-\d\d-\d\d[T ][\d:.]+Z?/g, ""));
});

test("e2e: with search the manualActions detail is omitted, without search it is returned", async () => {
  const withSearch = await list({ search: "uglt-159" });
  assert.equal(withSearch.manualActions, undefined);
  assert.equal(typeof withSearch.manualActionsCount, "number");
  const withoutSearch = await list({});
  assert.ok(Array.isArray(withoutSearch.manualActions));
});
