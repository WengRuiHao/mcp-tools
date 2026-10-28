import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await mkdtemp(path.join(os.tmpdir(), "adv-guards-"));
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


test("external modification blocks advance until resync", async () => {
  await newTicket("200");
  await store.writeArtifact("200", "01-analysis.md", "original");
  await store.recordArtifactHash("200", "01-analysis.md", "original");
  await store.writeArtifact("200", "01-analysis.md", "edited outside MCP");
  const blocked = await call("advance_ticket_stage", { taskGid: "200", stage: "analyzed" });
  assert.equal(blocked.isError, true);
  assert.match(blocked.json.message, /read_ticket_artifact/);
  assert.match(blocked.json.message, /resync_ticket_artifact/);
  assert.equal((await store.readStatus("200")).stage, "snapshot");

  await store.recordArtifactHash("200", "01-analysis.md", "edited outside MCP");
  const ok = await call("advance_ticket_stage", { taskGid: "200", stage: "analyzed" });
  assert.equal(ok.json.success, true);
});

test("verdict is rejected outside verified/tested", async () => {
  await newTicket("201");
  await store.writeArtifact("201", "01-analysis.md", "a");
  const r = await call("advance_ticket_stage", { taskGid: "201", stage: "analyzed", verdict: "PASS" });
  assert.equal(r.isError, true);
  assert.match(r.json.message, /verified/);
  assert.equal((await store.readStatus("201")).verdict, null);
  const withNull = await call("advance_ticket_stage", { taskGid: "201", stage: "analyzed", verdict: null });
  assert.equal(withNull.json.success, true);
});

test("get_ticket_status is slim by default and full with verbose", async () => {
  await newTicket("202");
  const slim = await call("get_ticket_status", { taskGid: "202" });
  assert.equal(slim.json.history, undefined);
  assert.equal(slim.json.sync, undefined);
  for (const k of ["stage", "verdict", "needs_human_review", "sync_flags", "external_changes", "summaries", "confirmation", "nextAction"]) {
    assert.ok(k in slim.json, k);
  }
  const full = await call("get_ticket_status", { taskGid: "202", verbose: true });
  assert.ok(Array.isArray(full.json.history));
  assert.ok(full.json.sync);
  assert.ok(slim.text.length < full.text.length);
});
