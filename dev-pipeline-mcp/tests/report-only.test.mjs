// list_pending_tickets 的 reportOnly 參數：精簡回傳、報告照寫、等確認清單仍附明細、向下相容。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "report-only-"));
const dataDir = path.join(tmpRoot, "data");
const projectDir = path.join(tmpRoot, "proj");
await fs.mkdir(dataDir, { recursive: true });
await fs.mkdir(projectDir, { recursive: true });
process.env.ASANA_PIPELINE_DATA_DIR = dataDir;
process.env.ASANA_MCP_PATH = fileURLToPath(new URL("./helpers/fake-asana-mcp.mjs", import.meta.url));
process.env.PIPELINE_ASANA_USER_GID = "ME";

const board = [
  { gid: "g1", name: "一般票", custom_fields: [] },
  { gid: "g2", name: "草稿待確認", custom_fields: [] },
];
process.env.FAKE_ASANA_TASKS = JSON.stringify(board);

const store = await import("../dist/pipeline-store.js");
const registry = await import("../dist/project-registry.js");
await registry.registerProjectDir("P1", projectDir);
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
  return { isError: r.isError === true, body: JSON.parse(r.content[0].text) };
}
const reportPath = path.join(projectDir, ".asana-pipeline", "Proj", "PENDING_HUMAN_ACTIONS.html");

test("reportOnly without projectName returns a clear error", async () => {
  const { isError, body } = await list({ reportOnly: true });
  assert.equal(isError, true);
  assert.equal(body.success, false);
  assert.match(body.message, /projectName/);
});

test("reportOnly: slim body with path and counts, no ticket detail, report written", async () => {
  await store.assignTicketDir(projectDir, "g1", "Proj", null, null, "一般票");
  const { isError, body } = await list({ reportOnly: true, projectName: "Proj" });
  assert.equal(isError, false);
  assert.equal(body.success, true);
  assert.equal(body.pendingActionsReportPath, reportPath);
  assert.equal(body.totalMatched, 2); // g1 與尚未追蹤的 g2 都算待處理
  for (const k of ["awaitingConfirmationCount", "awaitingSpecConfirmationCount", "needsHumanReviewCount", "contentChangedCount", "manualActionsCount"]) {
    assert.equal(body[k], 0, k);
  }
  assert.deepEqual(body.uncommittedChanges, { registered: false, fileCount: 0 });
  for (const k of ["tickets", "contentChangedList", "manualActions", "needsHumanReview", "awaitingConfirmation", "awaitingSpecConfirmation"]) {
    assert.equal(body[k], undefined, k);
  }
  assert.ok((await fs.stat(reportPath)).isFile());
});

test("reportOnly: awaitingSpecConfirmation detail is still returned when non-empty", async () => {
  await store.assignTicketDir(projectDir, "g2", "Proj", null, null, "草稿待確認");
  await store.advanceStage("g2", "sd_drafted");
  const { body } = await list({ reportOnly: true, projectName: "Proj" });
  assert.equal(body.awaitingSpecConfirmationCount, 1);
  assert.deepEqual(body.awaitingSpecConfirmation.map((t) => t.taskGid), ["g2"]);
  assert.equal(body.tickets, undefined);
  assert.equal(body.awaitingConfirmation, undefined);
});

test("without reportOnly the full body is unchanged", async () => {
  const { body } = await list({ projectName: "Proj" });
  assert.deepEqual(body.tickets.map((t) => t.taskGid), ["g1"]);
  assert.ok(Array.isArray(body.contentChangedList));
  assert.ok(Array.isArray(body.manualActions));
  assert.equal(body.reportOnly, undefined);
  assert.equal(body.pendingActionsReportPath, reportPath);
  const off = await list({ projectName: "Proj", reportOnly: false });
  assert.deepEqual(off.body.tickets, body.tickets);
});
