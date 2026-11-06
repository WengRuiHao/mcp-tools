// 步驟 4b：ticket-artifact 與 test-evidence 工具對外雙收 taskGid / workItemId。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTmpDir, removeDir, isolateDataDir, connectClient, callTool } from "./helpers/support.mjs";

const iso = isolateDataDir();
const tmp = makeTmpDir("dpm-wi4b-");
const projectDir = path.join(tmp, "proj");
fs.mkdirSync(path.join(tmp, "src"), { recursive: true });

const store = await import("../dist/pipeline-store.js");
const { registerTestEvidenceTools } = await import("../dist/test-evidence-tools.js");
const { registerTicketArtifactTools } = await import("../dist/ticket-artifact-tools.js");

let ctx;
before(async () => {
  ctx = await connectClient((s) => {
    registerTestEvidenceTools(s);
    registerTicketArtifactTools(s);
  });
});
after(async () => {
  await ctx.close();
  iso.cleanup();
  removeDir(tmp);
});

const call = (name, args) => callTool(ctx.client, name, args);
const SYNC = { syncNote: "NO_SYNC_NEEDED", manualActions: [] };
async function newTicket(gid) {
  await store.assignTicketDir(projectDir, gid, "Proj", `T-${gid}`);
  await store.advanceStage(gid, "snapshot", { project_dir: projectDir, sasd_checked: true });
}
const NAMES = ["write_ticket_artifact", "read_ticket_artifact", "resync_ticket_artifact", "record_test_evidence"];

test("工具清單：四個工具的 taskGid / workItemId 皆選填", async () => {
  const { tools } = await ctx.client.listTools();
  for (const n of NAMES) {
    const t = tools.find((x) => x.name === n);
    assert.ok(t.inputSchema.properties.taskGid && t.inputSchema.properties.workItemId, n);
    assert.deepEqual((t.inputSchema.required ?? []).filter((k) => k === "taskGid" || k === "workItemId"), [], n);
  }
});

test("write/read/resync：workItemId 與 taskGid 等價，輸出含 workItemId 且保留 taskGid", async () => {
  await newTicket("wi1");
  const w = await call("write_ticket_artifact", { workItemId: "wi1", filename: "03-verification.md", content: "hi", summary: "s", ...SYNC });
  assert.equal(w.isError, false, w.text);
  assert.equal(w.json.taskGid, "wi1");
  assert.equal(w.json.workItemId, "wi1");
  const w2 = await call("write_ticket_artifact", { taskGid: "wi1", filename: "03-verification.md", content: "hi", summary: "s", ...SYNC });
  assert.deepEqual(w2.json, w.json);

  const rGid = await call("read_ticket_artifact", { taskGid: "wi1", filename: "03-verification.md" });
  const rWid = await call("read_ticket_artifact", { workItemId: "wi1", filename: "03-verification.md" });
  assert.equal(rWid.json.content, "hi");
  assert.equal(rWid.json.workItemId, "wi1");
  assert.deepEqual({ ...rGid.json, workItemId: "wi1" }, rWid.json);

  const s = await call("resync_ticket_artifact", { workItemId: "wi1", filename: "03-verification.md" });
  assert.equal(s.json.success, true);
  assert.equal(s.json.taskGid, "wi1");
  assert.equal(s.json.workItemId, "wi1");
});

test("record_test_evidence：workItemId 可記錄證據，輸出含 workItemId 與 taskGid", async () => {
  await newTicket("wi2");
  const src = path.join(tmp, "src", "r.txt");
  fs.writeFileSync(src, "ok");
  const r = await call("record_test_evidence", {
    workItemId: "wi2", featureName: "f", fileKind: "test-report", testLevel: "unit-mock", sourceFile: src, usesFakeData: false,
  });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.taskGid, "wi2");
  assert.equal(r.json.workItemId, "wi2");
  assert.equal(r.json.totalEvidence, 1);
});

test("兩者都缺：回 isError 繁體中文錯誤", async () => {
  const args = { filename: "03-verification.md", content: "x", featureName: "f", fileKind: "test-report", testLevel: "unit-mock", sourceFile: "x", usesFakeData: false };
  for (const n of NAMES) {
    const r = await call(n, args);
    assert.equal(r.isError, true, n);
    assert.match(r.json.message, /taskGid 或 workItemId/, n);
  }
});

test("兩者衝突：回 isError 且不寫入", async () => {
  await newTicket("wi3");
  for (const n of NAMES) {
    const r = await call(n, { taskGid: "wi3", workItemId: "zzz", filename: "03-verification.md", content: "x", ...SYNC, featureName: "f", fileKind: "test-report", testLevel: "unit-mock", sourceFile: "x", usesFakeData: false });
    assert.equal(r.isError, true, n);
    assert.match(r.json.message, /同時提供但值不同/, n);
  }
  const rd = await call("read_ticket_artifact", { taskGid: "wi3", filename: "03-verification.md" });
  assert.equal(rd.isError, true);
});
