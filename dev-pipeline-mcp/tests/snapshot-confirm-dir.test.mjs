// get_ticket_snapshot 的 confirmProjectDir 選項：與 advance_ticket_stage project_dir_confirmed 共用邏輯。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "snap-confirm-"));
const dataDir = path.join(tmpRoot, "data");
const projectDir = path.join(tmpRoot, "proj");
await fs.mkdir(dataDir, { recursive: true });
await fs.mkdir(projectDir, { recursive: true });
process.env.ASANA_PIPELINE_DATA_DIR = dataDir;
process.env.ASANA_MCP_PATH = fileURLToPath(new URL("./helpers/fake-asana-task-mcp.mjs", import.meta.url));

process.env.PIPELINE_ASANA_USER_GID = "ME";

const store = await import("../dist/pipeline-store.js");
const { registerTicketSnapshotTools } = await import("../dist/ticket-snapshot-tools.js");
const { registerTicketLifecycleTools } = await import("../dist/ticket-lifecycle-tools.js");
const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

// 先單獨建好橋接用的假 asana 連線：snapshot 內兩個 Asana 呼叫是並行的，冷啟動時會各自開一條連線，其中一條不會被 closeChildMcpClients 關掉而讓測試程序無法結束。
const { callAsanaTool, closeChildMcpClients: closeBridges } = await import("../dist/mcp-clients.js");
await callAsanaTool("asana_me", {});

const server = new McpServer({ name: "t", version: "0" });
registerTicketSnapshotTools(server);
registerTicketLifecycleTools(server);
const [a, b] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "c", version: "0" });
await Promise.all([server.connect(a), client.connect(b)]);

after(async () => {
  await client.close();
  await closeBridges();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  return { isError: !!r.isError, json: JSON.parse(r.content[0].text) };
}
const snap = (taskGid, extra = {}) =>
  call("get_ticket_snapshot", { taskGid, projectDir, projectName: "Proj", ticketNumber: `T-${taskGid}`, ...extra });
const stripTime = (s) => ({ ...s, history: s.history.map((h) => h.stage), last_seen_modified_at: null, content_hash: null });

test("不帶參數：snapshot 純抓取，stage 停在 snapshot，回傳無 projectDirConfirmed", async () => {
  const r = await snap("s1");
  assert.equal(r.json.success, true);
  assert.equal(r.json.projectDirConfirmed, undefined);
  assert.equal((await store.readStatus("s1")).stage, "snapshot");
});

test("confirmProjectDir:false 等同不帶", async () => {
  const r = await snap("s2", { confirmProjectDir: false });
  assert.equal(r.json.projectDirConfirmed, undefined);
  assert.equal((await store.readStatus("s2")).stage, "snapshot");
});

test("帶參數：同一次呼叫推進到 project_dir_confirmed，結果與舊路徑（snapshot + advance）一致", async () => {
  const fresh = await snap("n1", { confirmProjectDir: true });
  assert.equal(fresh.json.projectDirConfirmed, true);
  assert.ok(fresh.json.content, "首次抓取仍回全文");

  await snap("o1");
  const old = await call("advance_ticket_stage", { taskGid: "o1", stage: "project_dir_confirmed", project_dir: projectDir });
  assert.equal(old.json.success, true);

  const sn = await store.readStatus("n1");
  const so = await store.readStatus("o1");
  assert.equal(sn.stage, "project_dir_confirmed");
  assert.equal(sn.project_dir, projectDir);
  assert.deepEqual(
    stripTime({ ...sn, name: null, project_gid: null }),
    stripTime({ ...so, name: null, project_gid: null })
  );
});

test("重複呼叫冪等：不重複寫 history、unchanged 時也回 projectDirConfirmed", async () => {
  await snap("i1", { confirmProjectDir: true });
  const before = await store.readStatus("i1");
  const again = await snap("i1", { confirmProjectDir: true });
  assert.equal(again.json.unchanged, true);
  assert.equal(again.json.projectDirConfirmed, true);
  const after = await store.readStatus("i1");
  assert.deepEqual(after.history, before.history);
  assert.equal(after.stage, "project_dir_confirmed");
});

test("票已在更後面的階段：不倒退", async () => {
  await snap("f1");
  await store.writeArtifact("f1", "01-analysis.md", "analysis");
  await store.advanceStage("f1", "analyzed", {});
  const r = await snap("f1", { confirmProjectDir: true });
  assert.equal(r.json.projectDirConfirmed, true);
  assert.equal((await store.readStatus("f1")).stage, "analyzed");
});

test("前置條件不成立（project_dir 為空）：與舊路徑一樣被拒、stage 不變", async () => {
  const r = await snap("e1", { projectDir: "", confirmProjectDir: true });
  assert.equal(r.json.success, true, "snapshot 本身仍成功");
  assert.equal(r.json.projectDirConfirmed, false);
  const old = await call("advance_ticket_stage", { taskGid: "e1", stage: "project_dir_confirmed" });
  assert.equal(old.isError, true);
  assert.equal(r.json.confirmProjectDirError, old.json.message);
  assert.equal((await store.readStatus("e1")).stage, "snapshot");
});

test("舊路徑 advance_ticket_stage project_dir_confirmed 照常可用", async () => {
  await snap("a1");
  const r = await call("advance_ticket_stage", { taskGid: "a1", stage: "project_dir_confirmed" });
  assert.equal(r.json.success, true);
  assert.equal(r.json.stage, "project_dir_confirmed");
});
