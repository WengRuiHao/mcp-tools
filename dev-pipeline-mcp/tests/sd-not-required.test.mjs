// record_spec_confirmation 的 sdNotRequired（使用者明確表示本票不需 SD）。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sd-not-required-"));
process.env.ASANA_PIPELINE_DATA_DIR = path.join(tmpRoot, "data");
// 狀態寫入會連帶重建 PENDING_HUMAN_ACTIONS.html 並查 pipeline 帳號 gid（會 spawn 真的 asana-mcp 子行程）；
// 指到不存在的檔案讓它立刻連線失敗，並預先給定 gid，不打網路、不碰真實 Asana。
const previousAsanaPath = process.env.ASANA_MCP_PATH;
const previousUserGid = process.env.PIPELINE_ASANA_USER_GID;
process.env.ASANA_MCP_PATH = path.join(tmpRoot, "no-such-asana-mcp.js");
process.env.PIPELINE_ASANA_USER_GID = "gid-test-user";
const projectDir = path.join(tmpRoot, "proj");
await fs.mkdir(projectDir, { recursive: true });

const store = await import("../dist/pipeline-store.js");
const registry = await import("../dist/project-registry.js");
const { registerTicketLifecycleTools } = await import("../dist/ticket-lifecycle-tools.js");
const { buildCompactStatus } = await import("../dist/stage-response.js");
const { closeChildMcpClients } = await import("../dist/mcp-clients.js");
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
  await closeChildMcpClients();
  if (previousAsanaPath === undefined) delete process.env.ASANA_MCP_PATH;
  else process.env.ASANA_MCP_PATH = previousAsanaPath;
  if (previousUserGid === undefined) delete process.env.PIPELINE_ASANA_USER_GID;
  else process.env.PIPELINE_ASANA_USER_GID = previousUserGid;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const cfg = (sdMode, specOrder) => ({ saRoot: "/sa", sdMode, sdRoot: null, sdOutputPath: "out", svnConnectionId: null, specOrder });
await registry.registerSasdConfig("G-SF", cfg("self-generated", "spec_first"));
await registry.registerSasdConfig("G-CF", cfg("self-generated", "code_first"));
await registry.registerSasdConfig("G-EXT", { saRoot: "/sa", sdMode: "external", sdRoot: "/sd", sdOutputPath: null, svnConnectionId: null, specOrder: null });

async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content[0].text;
  return { isError: !!r.isError, json: JSON.parse(text) };
}

// 建一張票並寫好 01/02/03 產出，讓 advance 的證據檢查不擋。
async function ticketAt(gid, projectGid, stage) {
  await store.assignTicketDir(projectDir, gid, "Proj", gid, null, "t");
  await store.recordProjectContext(gid, projectDir, "Proj", "t", null, false, projectGid);
  for (const f of ["01-analysis.md", "02-implementation.md", "03-verification.md"]) {
    await store.writeArtifact(gid, f, "content");
    await store.recordArtifactHash(gid, f, "content");
  }
  await store.advanceStage(gid, stage);
}
const SKIP = { confirmed: true, sdNotRequired: true, userInstruction: "這張只改前端不需要 SD" };
const NOTICE = /本票未產出 SD，依使用者指示略過：這張只改前端不需要 SD/;

test("spec_first: sdNotRequired at analyzed is recorded and lets implemented through", async () => {
  await ticketAt("sf1", "G-SF", "analyzed");
  const r = await call("record_spec_confirmation", { taskGid: "sf1", ...SKIP });
  assert.equal(r.isError, false);
  assert.equal(r.json.spec_confirmation.sdNotRequired, true);
  assert.match(r.json.spec_confirmation.sdSkipNotice, NOTICE);
  const s = (await store.readStatus("sf1")).spec_confirmation;
  assert.deepEqual({ c: s.confirmed, n: s.sdNotRequired, note: s.note }, { c: true, n: true, note: SKIP.userInstruction });
  assert.equal((await call("advance_ticket_stage", { taskGid: "sf1", stage: "implemented" })).isError, false);
});

test("also allowed at sd_drafted, and unblocks the sd_drafted gate", async () => {
  await ticketAt("sf2", "G-SF", "sd_drafted");
  assert.equal((await call("advance_ticket_stage", { taskGid: "sf2", stage: "implemented" })).isError, true);
  assert.equal((await call("record_spec_confirmation", { taskGid: "sf2", ...SKIP })).isError, false);
  assert.equal((await call("advance_ticket_stage", { taskGid: "sf2", stage: "implemented" })).isError, false);
});

test("code_first: implemented -> verified passes without any SD draft", async () => {
  await ticketAt("cf1", "G-CF", "analyzed");
  assert.equal((await call("record_spec_confirmation", { taskGid: "cf1", ...SKIP })).isError, false);
  assert.equal((await call("advance_ticket_stage", { taskGid: "cf1", stage: "implemented" })).isError, false);
  const next = (await buildCompactStatus("cf1", await store.readStatus("cf1"))).nextAction;
  assert.doesNotMatch(JSON.stringify(next), /反推 SD 草稿/);
  assert.equal((await call("advance_ticket_stage", { taskGid: "cf1", stage: "verified", verdict: "PASS" })).isError, false);
});

test("missing / blank userInstruction is rejected and nothing is recorded", async () => {
  await ticketAt("bad1", "G-SF", "analyzed");
  for (const userInstruction of [undefined, null, "", "   \n\t"]) {
    const r = await call("record_spec_confirmation", { taskGid: "bad1", confirmed: true, sdNotRequired: true, userInstruction });
    assert.equal(r.isError, true);
    assert.match(r.json.message, /userInstruction/);
  }
  assert.equal((await store.readStatus("bad1")).spec_confirmation, null);
});

test("non self-generated project and unknown project are rejected", async () => {
  await ticketAt("ext1", "G-EXT", "analyzed");
  const r = await call("record_spec_confirmation", { taskGid: "ext1", ...SKIP });
  assert.equal(r.isError, true);
  assert.match(r.json.message, /self-generated/);
  await ticketAt("nogid", null, "analyzed");
  assert.equal((await call("record_spec_confirmation", { taskGid: "nogid", ...SKIP })).isError, true);
  assert.equal((await store.readStatus("ext1")).spec_confirmation, null);
});

test("other stages are rejected", async () => {
  for (const stage of ["snapshot", "implemented", "verified"]) {
    await ticketAt("st-" + stage, "G-SF", stage);
    const r = await call("record_spec_confirmation", { taskGid: "st-" + stage, ...SKIP });
    assert.equal(r.isError, true, stage);
    assert.match(r.json.message, /analyzed/);
  }
});

test("sdNotRequired with confirmed:false is rejected", async () => {
  await ticketAt("cf-false", "G-SF", "analyzed");
  const r = await call("record_spec_confirmation", { taskGid: "cf-false", confirmed: false, sdNotRequired: true, userInstruction: "x" });
  assert.equal(r.isError, true);
});

test("regular flow unchanged: analyzed still rejected without sdNotRequired; confirm and reject at sd_drafted", async () => {
  await ticketAt("reg1", "G-SF", "analyzed");
  const early = await call("record_spec_confirmation", { taskGid: "reg1", confirmed: true });
  assert.equal(early.isError, true);
  assert.match(early.json.message, /sd_drafted/);
  await ticketAt("reg2", "G-SF", "sd_drafted");
  const rej = await call("record_spec_confirmation", { taskGid: "reg2", confirmed: false, note: "改一下" });
  assert.equal(rej.json.spec_confirmation.confirmed, false);
  assert.equal(rej.json.spec_confirmation.sdNotRequired, undefined);
  assert.equal((await call("advance_ticket_stage", { taskGid: "reg2", stage: "implemented" })).isError, true);
  const ok = await call("record_spec_confirmation", { taskGid: "reg2", confirmed: true });
  assert.equal(ok.isError, false);
  assert.equal((await call("advance_ticket_stage", { taskGid: "reg2", stage: "implemented" })).isError, false);
  assert.equal((await store.readStatus("reg2")).spec_confirmation.sdNotRequired, undefined);
});

test("get_ticket_status shows the audit notice with the user's words", async () => {
  const r = await call("get_ticket_status", { taskGid: "sf1" });
  assert.equal(r.json.spec_confirmation.sdNotRequired, true);
  assert.match(r.json.spec_confirmation.sdSkipNotice, NOTICE);
});

test("re-drafting (advance to sd_drafted) clears a previous sdNotRequired", async () => {
  await ticketAt("redo", "G-SF", "analyzed");
  await call("record_spec_confirmation", { taskGid: "redo", ...SKIP });
  await store.advanceStage("redo", "sd_drafted");
  assert.equal((await store.readStatus("redo")).spec_confirmation, null);
});

test("self-generated spec_first: analyzed -> implemented without any SD confirmation is rejected", async () => {
  await ticketAt("gate-sf", "G-SF", "analyzed");
  const r = await call("advance_ticket_stage", { taskGid: "gate-sf", stage: "implemented" });
  assert.equal(r.isError, true);
  assert.match(r.json.message, /self-generated/);
  assert.match(r.json.message, /AI 不可自行略過/);
  assert.equal((await store.readStatus("gate-sf")).stage, "analyzed");
});

test("self-generated spec_first: allowed once sdNotRequired is recorded", async () => {
  await ticketAt("gate-sf2", "G-SF", "analyzed");
  await call("record_spec_confirmation", { taskGid: "gate-sf2", ...SKIP });
  const r = await call("advance_ticket_stage", { taskGid: "gate-sf2", stage: "implemented" });
  assert.equal(r.isError, false);
  assert.equal((await store.readStatus("gate-sf2")).stage, "implemented");
});

test("self-generated code_first: implemented is allowed without SD, verified is rejected", async () => {
  await ticketAt("gate-cf", "G-CF", "analyzed");
  const toImplemented = await call("advance_ticket_stage", { taskGid: "gate-cf", stage: "implemented" });
  assert.equal(toImplemented.isError, false);
  const toVerified = await call("advance_ticket_stage", { taskGid: "gate-cf", stage: "verified", verdict: "PASS" });
  assert.equal(toVerified.isError, true);
  assert.match(toVerified.json.message, /self-generated/);
  assert.equal((await store.readStatus("gate-cf")).stage, "implemented");
});

test("other sdModes and tickets without a project config are not gated", async () => {
  await ticketAt("gate-ext", "G-EXT", "analyzed");
  assert.equal((await call("advance_ticket_stage", { taskGid: "gate-ext", stage: "implemented" })).isError, false);
  await ticketAt("gate-none", null, "analyzed");
  assert.equal((await call("advance_ticket_stage", { taskGid: "gate-none", stage: "implemented" })).isError, false);
});
