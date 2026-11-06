// 步驟 4a：ticket-lifecycle 工具對外雙收 taskGid / workItemId。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await mkdtemp(path.join(os.tmpdir(), "wi-4a-"));
process.env.ASANA_PIPELINE_DATA_DIR = path.join(tmp, "data");
const projectDir = path.join(tmp, "proj");

const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { registerTicketLifecycleTools } = await import("../dist/ticket-lifecycle-tools.js");
const store = await import("../dist/pipeline-store.js");

let client;
before(async () => {
  const server = new McpServer({ name: "t", version: "0" });
  registerTicketLifecycleTools(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "c", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
});
after(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content[0].text;
  return { isError: !!r.isError, text, json: JSON.parse(text) };
}

async function newTicket(gid) {
  await store.assignTicketDir(projectDir, gid, "Proj", "T-" + gid);
  await store.advanceStage(gid, "snapshot", {});
}

const TOOLS = ["get_ticket_status", "record_confirmation", "record_spec_confirmation", "record_sasd_check", "resolve_manual_action", "request_reanalysis", "advance_ticket_stage"];

test("tool list: lifecycle 工具的 taskGid 與 workItemId 皆為選填", async () => {
  const { tools } = await client.listTools();
  for (const name of TOOLS) {
    const t = tools.find((x) => x.name === name);
    assert.ok(t, name);
    assert.ok(t.inputSchema.properties.taskGid, `${name} taskGid`);
    assert.ok(t.inputSchema.properties.workItemId, `${name} workItemId`);
    assert.ok(!(t.inputSchema.required ?? []).includes("taskGid"), `${name} taskGid 不應必填`);
    assert.ok(!(t.inputSchema.required ?? []).includes("workItemId"), `${name} workItemId 不應必填`);
  }
});

test("get_ticket_status: workItemId 與 taskGid 結果等價，輸出含 workItemId", async () => {
  await newTicket("4a1");
  const byGid = await call("get_ticket_status", { taskGid: "4a1" });
  const byWid = await call("get_ticket_status", { workItemId: "4a1" });
  assert.equal(byWid.isError, false);
  assert.equal(byWid.json.workItemId, "4a1");
  assert.deepEqual(byWid.json, byGid.json);
  assert.equal(byGid.json.stage, "snapshot");
});

test("advance_ticket_stage: 兩種入參等價；輸出保留 taskGid 並多帶 workItemId", async () => {
  await newTicket("4a2");
  await store.writeArtifact("4a2", "01-analysis.md", "body");
  const viaWid = await call("advance_ticket_stage", { workItemId: "4a2", stage: "analyzed" });
  assert.equal(viaWid.json.success, true);
  assert.equal(viaWid.json.taskGid, "4a2");
  assert.equal(viaWid.json.workItemId, "4a2");
  assert.equal(viaWid.json.stage, "analyzed");
  const viaGid = await call("advance_ticket_stage", { taskGid: "4a2", stage: "analyzed" });
  assert.deepEqual(viaGid.json, viaWid.json);
});

test("request_reanalysis 與 resolve_manual_action: workItemId 可用", async () => {
  await newTicket("4a3");
  const r = await call("request_reanalysis", { workItemId: "4a3" });
  assert.equal(r.json.success, true);
  assert.equal(r.json.taskGid, "4a3");
  assert.equal(r.json.workItemId, "4a3");
  const m = await call("resolve_manual_action", { workItemId: "4a3", filename: "02-implementation.md", action: "不存在" });
  assert.equal(m.isError, true);
  assert.equal(m.json.workItemId, "4a3");
});

test("兩者都缺：每個工具回 isError 與繁體中文錯誤，不拋例外", async () => {
  for (const name of TOOLS) {
    const args = { stage: "analyzed", confirmed: true, filename: "02-implementation.md", action: "x", hasSasd: false };
    const r = await call(name, args);
    assert.equal(r.isError, true, name);
    assert.equal(r.json.success, false, name);
    assert.match(r.json.message, /taskGid 或 workItemId/, name);
  }
});

test("兩者衝突：回 isError，且不動到任何票單", async () => {
  await newTicket("4a4");
  for (const name of TOOLS) {
    const r = await call(name, { taskGid: "4a4", workItemId: "other", stage: "analyzed", confirmed: true, filename: "02-implementation.md", action: "x", hasSasd: false });
    assert.equal(r.isError, true, name);
    assert.match(r.json.message, /同時提供但值不同/, name);
  }
  assert.equal((await store.readStatus("4a4")).stage, "snapshot");
});

test("兩者相同值：視為合法", async () => {
  await newTicket("4a5");
  const r = await call("get_ticket_status", { taskGid: "4a5", workItemId: "4a5" });
  assert.equal(r.isError, false);
  assert.equal(r.json.workItemId, "4a5");
});
