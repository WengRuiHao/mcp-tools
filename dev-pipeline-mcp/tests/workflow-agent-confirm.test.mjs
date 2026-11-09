// S3：確認類工具的 confirmedBy／auto 判斷；Asana 票單的 status.json 與確認紀錄不得多出新 key。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTmpDir, removeDir, isolateDataDir } from "./helpers/support.mjs";

const iso = isolateDataDir();
const projectDir = makeTmpDir("dpm-agentconf-");
const prevPath = process.env.ASANA_MCP_PATH;
const prevGid = process.env.PIPELINE_ASANA_USER_GID;
process.env.ASANA_MCP_PATH = path.join(projectDir, "no-such-asana-mcp.js");
process.env.PIPELINE_ASANA_USER_GID = "gid-test-user";

const store = await import("../dist/pipeline-store.js");
const { registerTicketLifecycleTools } = await import("../dist/ticket-lifecycle-tools.js");
const { evaluateAgentConfirmation } = await import("../dist/workflow/agent-confirm.js");
const { buildSpecFirstWorkflow } = await import("../dist/workflow/builtin/spec-first.js");
const { closeChildMcpClients } = await import("../dist/mcp-clients.js");
const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const server = new McpServer({ name: "t", version: "0" });
registerTicketLifecycleTools(server);
const [a, b] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "c", version: "0" });
await Promise.all([server.connect(a), client.connect(b)]);

// 專案 flow.json 把 sd-confirm 設為 auto，才有 auto 路徑可測（內建 spec-first 預設 manual）。
const autoDir = makeTmpDir("dpm-agentconf-auto-");
fs.mkdirSync(path.join(autoDir, ".pipeline"), { recursive: true });
fs.writeFileSync(path.join(autoDir, ".pipeline", "flow.json"), JSON.stringify({ schemaVersion: 1, gates: { "sd-confirm": { confirmMode: "auto" } } }));

after(async () => {
  await client.close();
  await closeChildMcpClients();
  if (prevPath === undefined) delete process.env.ASANA_MCP_PATH;
  else process.env.ASANA_MCP_PATH = prevPath;
  if (prevGid === undefined) delete process.env.PIPELINE_ASANA_USER_GID;
  else process.env.PIPELINE_ASANA_USER_GID = prevGid;
  iso.cleanup();
  removeDir(projectDir);
  removeDir(autoDir);
});

async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  return { isError: !!r.isError, json: JSON.parse(r.content[0].text) };
}

let n = 0;
async function ticket(overrides, dir = projectDir) {
  const gid = `ac${Date.now()}${n++}`;
  const d = await store.assignTicketDir(dir, gid, "Proj", `T-${gid}`);
  const file = path.join(d, "status.json");
  const base = JSON.parse(JSON.stringify(await store.readStatus(gid)));
  fs.writeFileSync(file, JSON.stringify({ ...base, project_dir: dir, ...overrides }, null, 2), "utf-8");
  return { gid, file };
}
const OK_REVIEW = { breaksExisting: false, reviewerUncertain: false, scopeSplit: false };

test("Asana 票單（缺省與 asana-ticket）傳 confirmedBy:agent 一律拒絕，且不寫任何東西", async () => {
  for (const wf of [undefined, "asana-ticket"]) {
    const { gid, file } = await ticket({ stage: "sd_drafted", ...(wf ? { workflow_id: wf } : {}) }, autoDir);
    const before = fs.readFileSync(file, "utf-8");
    const r = await call("record_spec_confirmation", { taskGid: gid, confirmed: true, confirmedBy: "agent", review: OK_REVIEW });
    assert.equal(r.isError, true);
    assert.equal(r.json.reason, "asana-confirmation");
    assert.equal(fs.readFileSync(file, "utf-8"), before);
  }
});

test("Asana 票單人工確認：紀錄與 status.json 不多出任何新 key（含 confirmedBy:human）", async () => {
  for (const extra of [{}, { confirmedBy: "human" }]) {
    const { gid, file } = await ticket({ stage: "sd_drafted" });
    const r = await call("record_spec_confirmation", { taskGid: gid, confirmed: true, note: "ok", ...extra });
    assert.equal(r.isError, false);
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    assert.deepEqual(Object.keys(raw.spec_confirmation).sort(), ["confirmed", "confirmedAt", "note"]);
    assert.equal("workflow_id" in raw, false);
  }
});

test("Asana 票單 record_confirmation 紀錄 key 不變，status.json 讀出再寫回逐字相同", async () => {
  const { gid, file } = await ticket({ stage: "tested" });
  const r = await call("record_confirmation", { taskGid: gid, confirmed: true, note: "n", confirmedBy: "agent" });
  assert.equal(r.isError, false);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, "utf-8")).confirmation).sort(), ["confirmed", "confirmedAt", "note"]);
  const text = fs.readFileSync(file, "utf-8");
  await store.updateStatus(gid, (s) => s);
  assert.equal(fs.readFileSync(file, "utf-8"), text);
});

test("record_confirmation 沒有 agent／auto 參數，非 Asana 票也永遠不寫 confirmedBy", async () => {
  const tools = (await client.listTools()).tools;
  const props = Object.keys(tools.find((t) => t.name === "record_confirmation").inputSchema.properties);
  assert.deepEqual(props.filter((p) => /confirmedBy|review|auto|agent/i.test(p)), []);
  const { gid, file } = await ticket({ stage: "tested", workflow_id: "spec-first" }, autoDir);
  assert.equal((await call("record_confirmation", { taskGid: gid, confirmed: true, confirmedBy: "agent" })).isError, false);
  assert.equal("confirmedBy" in JSON.parse(fs.readFileSync(file, "utf-8")).confirmation, false);
});

test("final-acceptance（locked）即使套 auto 覆寫與完整申報也永遠被拒", async () => {
  const def = buildSpecFirstWorkflow();
  const forced = { ...def, confirmDefault: "auto", gates: def.gates.map((g) => (g.id === "final-acceptance" ? { ...g, confirmMode: "auto" } : g)) };
  for (const d of [def, forced]) {
    const v = await evaluateAgentConfirmation({ workflow_id: "spec-first", project_dir: null, consecutive_fail_count: 0 }, "final-acceptance", OK_REVIEW, d);
    assert.equal(v.ok, false);
    assert.equal(v.reason, "locked");
  }
});

test("spec-first：auto 且申報完整 → 放行並寫入 confirmedBy:agent", async () => {
  const { gid, file } = await ticket({ stage: "sd_drafted", workflow_id: "spec-first" }, autoDir);
  const r = await call("record_spec_confirmation", { taskGid: gid, confirmed: true, confirmedBy: "agent", review: OK_REVIEW });
  assert.equal(r.isError, false);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf-8")).spec_confirmation.confirmedBy, "agent");
});

test("spec-first：硬停點、申報缺漏、預設 manual 皆被拒且不寫入", async () => {
  const cases = [
    [autoDir, 0, { ...OK_REVIEW, breaksExisting: true }, "hard-stop", "breaks-existing"],
    [autoDir, 3, OK_REVIEW, "hard-stop", "consecutive-fail-3"],
    [autoDir, 0, undefined, "declaration-incomplete", undefined],
    [autoDir, 0, { breaksExisting: false }, "declaration-incomplete", undefined],
    [projectDir, 0, OK_REVIEW, "inherit-default", undefined],
  ];
  for (const [dir, fails, review, reason, hardStop] of cases) {
    const { gid } = await ticket({ stage: "sd_drafted", workflow_id: "spec-first", consecutive_fail_count: fails }, dir);
    const r = await call("record_spec_confirmation", { taskGid: gid, confirmed: true, confirmedBy: "agent", ...(review ? { review } : {}) });
    assert.equal(r.isError, true, reason);
    assert.equal(r.json.reason, reason);
    assert.equal(r.json.hardStop, hardStop);
    assert.equal((await store.readStatus(gid)).spec_confirmation, null);
  }
});

test("spec-first 預設（未傳 confirmedBy）人工確認不受影響，也不寫 confirmedBy", async () => {
  const { gid } = await ticket({ stage: "sd_drafted", workflow_id: "spec-first" });
  const r = await call("record_spec_confirmation", { taskGid: gid, confirmed: true });
  assert.equal(r.isError, false);
  assert.equal("confirmedBy" in (await store.readStatus(gid)).spec_confirmation, false);
});
