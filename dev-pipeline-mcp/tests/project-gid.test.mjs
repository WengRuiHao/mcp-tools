import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// 暫時資料目錄必須在載入 dist 之前設好；全程不連 Asana。
const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gid-test-"));
const dataDir = path.join(tmpRoot, "data");
const projectDir = path.join(tmpRoot, "proj");
await fs.mkdir(dataDir, { recursive: true });
await fs.mkdir(projectDir, { recursive: true });
process.env.ASANA_PIPELINE_DATA_DIR = dataDir;

const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const store = await import("../dist/pipeline-store.js");
const registry = await import("../dist/project-registry.js");
const { getRolePrompt } = await import("../dist/prompts.js");
const { getOverview } = await import("../dist/overview-prompts.js");
const { registerPipelineInfoTools } = await import("../dist/pipeline-info-tools.js");
const { registerTicketLifecycleTools } = await import("../dist/ticket-lifecycle-tools.js");

const ROLES = ["analyst", "spec-writer", "engineer", "verifier", "tester"];

let client;

before(async () => {
  const server = new McpServer({ name: "t", version: "0" });
  registerPipelineInfoTools(server);
  registerTicketLifecycleTools(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: "c", version: "0" });
  await client.connect(b);
});

after(async () => {
  await client?.close();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function parseText(res) {
  return res.content[0].text;
}

async function makeTicket(taskGid, gid, extra = {}) {
  await store.assignTicketDir(projectDir, taskGid, "Proj", taskGid, null, "t");
  await store.recordProjectContext(taskGid, projectDir, "Proj", "t", null, false, gid);
  if (Object.keys(extra).length > 0) await store.advanceStage(taskGid, extra.stage ?? "snapshot", extra);
}

async function rolePrompt(role, args = {}) {
  return parseText(await client.callTool({ name: "get_role_prompt", arguments: { role, ...args } }));
}

async function ticketStatus(taskGid) {
  return JSON.parse(parseText(await client.callTool({ name: "get_ticket_status", arguments: { taskGid } })));
}

test("old status.json without project_gid reads as null", async () => {
  const dir = await store.assignTicketDir(projectDir, "old1", "Proj", "old1", null, "t");
  await fs.writeFile(path.join(dir, "status.json"), JSON.stringify({ stage: "snapshot", project_dir: projectDir }));
  const status = await store.readStatus("old1");
  assert.equal(status.project_gid, null);
  assert.equal(status.stage, "snapshot");
});

test("recordProjectContext stores gid, keeps it when omitted, replaces it when changed", async () => {
  await makeTicket("rec1", "G1");
  assert.equal((await store.readStatus("rec1")).project_gid, "G1");
  await store.recordProjectContext("rec1", projectDir, "Proj", "t", null, false);
  assert.equal((await store.readStatus("rec1")).project_gid, "G1");
  await store.recordProjectContext("rec1", projectDir, "Proj", "t", null, false, "G2");
  assert.equal((await store.readStatus("rec1")).project_gid, "G2");
});

const SD_CASES = [
  { name: "external", sdMode: "external", specOrder: null },
  { name: "self", sdMode: "self", specOrder: null },
  { name: "unregistered", sdMode: "unregistered", specOrder: null },
  { name: "sg-spec-first", sdMode: "self-generated", specOrder: "spec_first" },
  { name: "sg-code-first", sdMode: "self-generated", specOrder: "code_first" },
];

const COMMON = {
  engineer: ["syncNote", "NO_SYNC_NEEDED", "manualActions", "search_project_text", "write_ticket_artifact", "02-implementation.md", "git push"],
  verifier: ["syncNote", "NO_SYNC_NEEDED", "manualActions", "rootCause", "03-verification.md", "search_project_text"],
  "spec-writer": ["sd_drafted", "record_spec_confirmation", "write_project_sd_doc", "read_project_sd_doc", "get_sd_spec_template"],
};

for (const c of SD_CASES) {
  test(`role prompts follow project config: ${c.name}`, async () => {
    const gid = `P-${c.name}`;
    await registry.registerSasdConfig(gid, { saRoot: "/sa", sdMode: c.sdMode, sdRoot: null, sdOutputPath: null, svnConnectionId: null, specOrder: c.specOrder });
    const taskGid = `T-${c.name}`;
    await makeTicket(taskGid, gid);

    const eng = await rolePrompt("engineer", { taskGid });
    const ver = await rolePrompt("verifier", { taskGid });
    const sw = await rolePrompt("spec-writer", { taskGid });
    for (const k of COMMON.engineer) assert.ok(eng.includes(k), `engineer missing ${k}`);
    for (const k of COMMON.verifier) assert.ok(ver.includes(k), `verifier missing ${k}`);
    for (const k of COMMON["spec-writer"]) assert.ok(sw.includes(k), `spec-writer missing ${k}`);

    const full = getRolePrompt("engineer");
    const selfGen = c.sdMode === "self-generated";
    assert.equal(eng.includes('"self-generated"'), selfGen);
    assert.equal(ver.includes('"self-generated"'), selfGen);
    assert.ok(eng.length < full.length);
    if (c.sdMode === "external") {
      assert.ok(eng.includes('"external"'));
    }
    if (c.sdMode === "self") assert.ok(eng.includes('"self"'));
    if (c.specOrder === "spec_first") {
      assert.ok(eng.includes('specOrder: "spec_first"') && !eng.includes('specOrder: "code_first"'));
      assert.ok(!sw.includes("code_first"));
    }
    if (c.specOrder === "code_first") {
      assert.ok(eng.includes('specOrder: "code_first"') && !eng.includes('specOrder: "spec_first"'));
      assert.ok(!sw.includes("spec_first"));
      assert.ok(sw.includes("summaries.implementation"));
    }
  });
}

test("unknown or missing config keeps the full prompt", async () => {
  await makeTicket("nogid", null);
  await makeTicket("unreg-gid", "P-not-registered");
  for (const role of ROLES) {
    const base = getRolePrompt(role);
    assert.equal(await rolePrompt(role), base, `${role} without taskGid`);
    assert.equal(await rolePrompt(role, { taskGid: "nogid" }), base, `${role} without gid`);
    assert.equal(await rolePrompt(role, { taskGid: "unreg-gid" }), base, `${role} gid not registered`);
    assert.equal(await rolePrompt(role, { projectDir }), base, `${role} projectDir only`);
  }
  // sdMode known but specOrder unknown (self-generated): both orders stay
  const eng = getRolePrompt("engineer", { sdMode: "self-generated", specOrder: null });
  assert.ok(eng.includes('specOrder: "spec_first"') && eng.includes('specOrder: "code_first"'));
  const sw = getRolePrompt("spec-writer", { sdMode: "self-generated", specOrder: null });
  assert.equal(sw, getRolePrompt("spec-writer"));
});

test("test capability is resolved by project gid, even when projects share a directory", async () => {
  await registry.registerProjectDir("CAP-A", projectDir);
  await registry.registerProjectDir("CAP-B", projectDir);
  await registry.registerTestCapability("CAP-A", { mode: "none", note: null });
  await registry.registerTestCapability("CAP-B", { mode: "modern", note: null });
  await makeTicket("cap-a", "CAP-A");
  await makeTicket("cap-b", "CAP-B");
  const none = await rolePrompt("engineer", { taskGid: "cap-a" });
  const modern = await rolePrompt("engineer", { taskGid: "cap-b" });
  assert.equal(none, getRolePrompt("engineer", { testCapabilityMode: "none" }));
  assert.equal(modern, getRolePrompt("engineer"));
  // no gid: inconsistent shared directory falls back to the full prompt
  assert.equal(await rolePrompt("engineer", { projectDir }), getRolePrompt("engineer"));
});

test("nextAction uses sasd for spec guidance", async () => {
  await registry.registerSasdConfig("NA-SF", { saRoot: "/sa", sdMode: "self-generated", sdRoot: null, sdOutputPath: "x", svnConnectionId: null, specOrder: "spec_first" });
  await registry.registerSasdConfig("NA-CF", { saRoot: "/sa", sdMode: "self-generated", sdRoot: null, sdOutputPath: "x", svnConnectionId: null, specOrder: "code_first" });

  await makeTicket("na-sf", "NA-SF");
  await makeTicket("na-cf", "NA-CF");
  await makeTicket("na-none", null);
  for (const g of ["na-sf", "na-cf", "na-none"]) await store.advanceStage(g, "sd_drafted");

  const sf = (await ticketStatus("na-sf")).nextAction;
  const cf = (await ticketStatus("na-cf")).nextAction;
  const none = (await ticketStatus("na-none")).nextAction;
  assert.ok(sf.blockedBy.some((b) => b.includes("implemented") && !b.includes("verified")));
  assert.ok(cf.blockedBy.some((b) => b.includes("verified") && !b.includes("implemented")));
  assert.ok(none.blockedBy.some((b) => b.includes("implemented／verified")));

  // code_first: after the engineer (stage implemented) the spec-writer goes before the verifier
  await store.advanceStage("na-cf", "implemented");
  const cfImpl = (await ticketStatus("na-cf")).nextAction;
  assert.ok(cfImpl.suggestedTools.includes('get_role_prompt({role:"spec-writer"})'));
  assert.ok(cfImpl.summary.includes("verified"));

  // without gid the verifier step is unchanged
  await store.advanceStage("na-none", "implemented");
  const noneImpl = (await ticketStatus("na-none")).nextAction;
  assert.ok(noneImpl.summary.includes("03-verification.md"));
  assert.ok(noneImpl.suggestedTools.includes('get_role_prompt({role:"verifier"})'));
});

test("overview core stays within budget and mentions projectGid for the snapshot call", () => {
  const core = getOverview("core");
  assert.ok(core.length <= 9500, `core length ${core.length}`);
  assert.ok(/get_ticket_snapshot\(\{[^}]*projectGid/.test(core));
});
