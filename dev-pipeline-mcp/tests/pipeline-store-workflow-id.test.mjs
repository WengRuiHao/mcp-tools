// TicketStatus.workflow_id：舊格式讀寫不變、asana-ticket/缺省行為不變、其他 workflow 依自己的順序只前進不倒退。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTmpDir, removeDir, isolateDataDir } from "./helpers/support.mjs";

const iso = isolateDataDir();
const projectDir = makeTmpDir("dpm-wfid-proj-");
test.after(() => {
  iso.cleanup();
  removeDir(projectDir);
});
const store = await import("../dist/pipeline-store.js");

let counter = 0;
async function newTicket(statusOverrides) {
  const gid = `wf${Date.now()}${counter++}`;
  const dir = await store.assignTicketDir(projectDir, gid, "Proj", `T-${gid}`);
  if (statusOverrides) {
    const file = path.join(dir, "status.json");
    const base = JSON.parse(JSON.stringify(await store.readStatus(gid)));
    fs.writeFileSync(file, JSON.stringify({ ...base, ...statusOverrides }, null, 2), "utf-8");
  }
  return { gid, file: path.join(dir, "status.json") };
}

test("舊格式 status.json（無 workflow_id）讀取後再寫回，內容與原檔逐字相同", async () => {
  const { gid, file } = await newTicket();
  await store.updateStatus(gid, (s) => s); // 先寫出一份標準化檔案
  const original = fs.readFileSync(file, "utf-8");
  assert.ok(!original.includes("workflow_id"));
  await store.updateStatus(gid, (s) => s);
  assert.equal(fs.readFileSync(file, "utf-8"), original);
  assert.equal("workflow_id" in (await store.readStatus(gid)), false);
});

test("workflow_id 有值時讀寫會保留", async () => {
  const { gid } = await newTicket({ workflow_id: "spec-first" });
  await store.updateStatus(gid, (s) => s);
  assert.equal((await store.readStatus(gid)).workflow_id, "spec-first");
});

test("缺省與 asana-ticket：階段只前進不倒退，行為一致", async () => {
  for (const wf of [undefined, "asana-ticket"]) {
    const { gid } = await newTicket(wf ? { workflow_id: wf } : undefined);
    let s = await store.advanceStageIfForward(gid, "analyzed");
    assert.equal(s.stage, "analyzed");
    s = await store.advanceStageIfForward(gid, "snapshot", { name: "n" });
    assert.equal(s.stage, "analyzed");
    assert.equal(s.name, "n");
    assert.deepEqual(s.history.map((h) => h.stage), ["analyzed"]);
  }
});

test("asana-ticket 內容變動且已有進度 → needs_reanalysis（hadPriorProgress 行為不變）", async () => {
  for (const wf of [undefined, "asana-ticket"]) {
    const { gid } = await newTicket(wf ? { workflow_id: wf } : undefined);
    await store.recordSnapshotContent(gid, "v1", null);
    await store.advanceStageIfForward(gid, "analyzed");
    const r = await store.recordSnapshotContent(gid, "v2", null);
    assert.equal(r.changed, true);
    assert.equal(r.status.needs_reanalysis, true);
    assert.equal(r.status.stage, "analyzed");
  }
});

test("spec-first：依自己的順序只前進不倒退", async () => {
  const { gid } = await newTicket({ workflow_id: "spec-first" });
  const order = ["sd-analyst", "spec-verifier", "backend-engineer", "tester"];
  let s = await store.advanceStageIfForward(gid, order[1]);
  assert.equal(s.stage, order[1]);
  s = await store.advanceStageIfForward(gid, order[0], { name: "keep" });
  assert.equal(s.stage, order[1], "倒退被擋");
  assert.equal(s.name, "keep");
  s = await store.advanceStageIfForward(gid, order[3]);
  assert.equal(s.stage, order[3]);
  s = await store.advanceStageIfForward(gid, order[2]);
  assert.equal(s.stage, order[3]);
});

test("spec-first：recordSnapshotContent 在角色階段視為已有進度", async () => {
  const { gid } = await newTicket({ workflow_id: "spec-first" });
  await store.recordSnapshotContent(gid, "v1", null);
  const r0 = await store.recordSnapshotContent(gid, "v1b", null);
  assert.equal(r0.status.needs_reanalysis, false, "仍在 new 階段不算已有進度");
  await store.advanceStageIfForward(gid, "backend-engineer");
  const r = await store.recordSnapshotContent(gid, "v2", null);
  assert.equal(r.status.needs_reanalysis, true);
});
