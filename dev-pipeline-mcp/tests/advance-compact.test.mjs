import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await mkdtemp(path.join(os.tmpdir(), "adv-compact-"));
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

test("advance compact is much smaller than verbose and has nextAction", async () => {
  await newTicket("100");
  await store.writeArtifact("100", "01-analysis.md", "analysis body");
  const compact = await call("advance_ticket_stage", { taskGid: "100", stage: "analyzed" });
  assert.equal(compact.json.success, true);
  assert.equal(compact.json.stage, "analyzed");
  assert.equal(compact.json.needs_human_review, false);
  assert.equal(compact.json.consecutive_fail_count, 0);
  assert.ok(compact.json.nextAction.summary.length > 0);
  assert.ok(Array.isArray(compact.json.nextAction.suggestedTools));
  assert.equal(compact.json.status, undefined);
  assert.equal(compact.json.history, undefined);

  const verbose = await call("advance_ticket_stage", { taskGid: "100", stage: "analyzed", verbose: true });
  assert.equal(verbose.json.success, true);
  assert.equal(typeof verbose.json.needs_human_review, "boolean");
  assert.equal(verbose.json.status.stage, "analyzed");
  assert.ok(Array.isArray(verbose.json.status.history));
  assert.ok(verbose.json.status.sync);
  assert.ok(verbose.json.status.summaries);
  assert.ok(compact.text.length < verbose.text.length, `${compact.text.length} vs ${verbose.text.length}`);
});

test("guards still reject with clear errors", async () => {
  await newTicket("101");
  let r = await call("advance_ticket_stage", { taskGid: "101", stage: "analyzed" });
  assert.equal(r.isError, true);
  assert.match(r.json.message, /01-analysis\.md/);

  r = await call("advance_ticket_stage", { taskGid: "101", stage: "verified", verdict: "FAIL" });
  assert.equal(r.isError, true);
  assert.match(r.json.message, /rootCause/);

  r = await call("advance_ticket_stage", { taskGid: "101", stage: "verified", verdict: "PASS", rootCause: "analysis" });
  assert.equal(r.isError, true);
  assert.match(r.json.message, /rootCause/);

  r = await call("advance_ticket_stage", { taskGid: "101", stage: "project_dir_confirmed" });
  assert.equal(r.isError, true);
});

test("spec gate blocks implemented while sd_drafted is unconfirmed", async () => {
  await newTicket("102");
  await store.advanceStage("102", "sd_drafted", {});
  await store.writeArtifact("102", "02-implementation.md", "impl");
  const r = await call("advance_ticket_stage", { taskGid: "102", stage: "implemented" });
  assert.equal(r.isError, true);
  assert.match(r.json.message, /spec_confirmation/);
});

test("FAIL keeps root cause and failure counter in compact output", async () => {
  await newTicket("103");
  await store.writeArtifact("103", "03-verification.md", "verify");
  const r = await call("advance_ticket_stage", { taskGid: "103", stage: "verified", verdict: "FAIL", rootCause: "implementation" });
  assert.equal(r.json.success, true);
  assert.equal(r.json.verdict, "FAIL");
  assert.equal(r.json.verifier_root_cause, "implementation");
  assert.equal(r.json.consecutive_fail_count, 1);
});

test("record tools return compact by default and full with verbose", async () => {
  await newTicket("104");
  const sasd = await call("record_sasd_check", { taskGid: "104", hasSasd: false });
  assert.equal(sasd.json.success, true);
  assert.equal(sasd.json.status, undefined);
  assert.ok(sasd.json.nextAction);
  const sasdFull = await call("record_sasd_check", { taskGid: "104", hasSasd: false, verbose: true });
  assert.ok(sasdFull.json.status.sync);

  const early = await call("record_confirmation", { taskGid: "104", confirmed: true });
  assert.equal(early.isError, true);

  await store.writeArtifact("104", "04-test.md", "t");
  await store.advanceStage("104", "tested", { verdict: "PASS" });
  const c = await call("record_confirmation", { taskGid: "104", confirmed: true });
  assert.equal(c.json.success, true);
  assert.equal(c.json.confirmation.confirmed, true);
  assert.equal(c.json.status, undefined);

  const re = await call("request_reanalysis", { taskGid: "104" });
  assert.equal(re.json.taskGid, "104");
  assert.equal(re.json.status, undefined);
  const reFull = await call("request_reanalysis", { taskGid: "104", verbose: true });
  assert.equal(reFull.json.taskGid, "104");
  assert.ok(reFull.json.status.history);

  await newTicket("105");
  await store.advanceStage("105", "sd_drafted", {});
  const sc = await call("record_spec_confirmation", { taskGid: "105", confirmed: true });
  assert.equal(sc.json.spec_confirmation.confirmed, true);
  const bad = await call("record_spec_confirmation", { taskGid: "104", confirmed: true });
  assert.equal(bad.isError, true);
});
