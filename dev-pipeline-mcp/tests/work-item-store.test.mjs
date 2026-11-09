// 手動來源資料層：編號、目錄、索引、範圍鎖定、快照、when context。全部用暫存目錄隔離。
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, writeFile, stat, readdir, rm } from "node:fs/promises";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "wi-data-"));
process.env.ASANA_PIPELINE_DATA_DIR = dataDir;
const indexFile = path.join(dataDir, "tickets-index.json");

const { createWorkItem, updateWorkItemScope, buildWhenContext, sanitizeWorkItemTitle } = await import("../dist/work-item-store.js");
const { assignTicketDir, updateStatus, readStatus, recordSpecConfirmation, advanceStage } = await import("../dist/pipeline-store.js");
const { getStageOrder, getBuiltinWorkflow } = await import("../dist/workflow/stage-order.js");
const { resolveWorkflow } = await import("../dist/workflow/resolve.js");

const base = { title: "新增訂單查詢", requirement: "需求原文：要能查訂單\n第二行", baseline: "brownfield", scope: "both", hasDb: true, workflow: "spec-first" };
const readIndex = async () => JSON.parse(await readFile(indexFile, "utf-8"));
const readIndexOrEmpty = () => readIndex().catch(() => ({}));
const newProject = () => mkdtemp(path.join(os.tmpdir(), "wi-proj-"));
const today = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
};
const NEW_KEYS = ["baseline", "scope", "has_db", "workflow_snapshot", "workflow_id"];

test("編號格式 wi-YYYYMMDD-NNN，同日遞增", async () => {
  const projectDir = await newProject();
  const a = await createWorkItem({ ...base, projectDir });
  const b = await createWorkItem({ ...base, projectDir });
  assert.match(a.id, /^wi-\d{8}-\d{3}$/);
  assert.equal(a.id.slice(0, 11), `wi-${today()}`);
  const n = (id) => Number(id.slice(-3));
  assert.equal(n(b.id), n(a.id) + 1);
});

test("並發建立不撞號", async () => {
  const projectDir = await newProject();
  const results = await Promise.all(Array.from({ length: 12 }, () => createWorkItem({ ...base, projectDir })));
  assert.equal(new Set(results.map((r) => r.id)).size, 12);
  assert.equal(new Set(results.map((r) => r.dir)).size, 12);
  const index = await readIndex();
  for (const r of results) assert.equal(index[r.id], r.dir);
});

test("索引不改既有條目，新條目沿用 編號 -> 目錄 格式", async () => {
  const projectDir = await newProject();
  const asanaDir = await assignTicketDir(projectDir, "1200000000001", "某專案", "T-1");
  const before = await readIndex();
  const item = await createWorkItem({ ...base, projectDir });
  const after = await readIndex();
  for (const [k, v] of Object.entries(before)) assert.equal(after[k], v);
  assert.equal(after["1200000000001"], asanaDir);
  assert.equal(after[item.id], item.dir);
  assert.equal(Object.keys(after).length, Object.keys(before).length + 1);
  assert.equal((await readStatus(item.id)).workflow_id, "spec-first");
});

test("目錄與檔案結構", async () => {
  const projectDir = await newProject();
  const { id, dir } = await createWorkItem({ ...base, projectDir });
  assert.equal(dir, path.join(path.resolve(projectDir), ".dev-pipeline", "work-items", `${id}_新增訂單查詢`));
  assert.equal(await readFile(path.join(dir, "item.md"), "utf-8"), base.requirement);
  for (const sub of ["sa-mockup", "sa-images", "evidence"]) assert.ok((await stat(path.join(dir, sub))).isDirectory());
  const status = JSON.parse(await readFile(path.join(dir, "status.json"), "utf-8"));
  assert.equal(status.stage, "new");
  assert.equal(status.baseline, "brownfield");
  assert.equal(status.scope, "both");
  assert.equal(status.has_db, true);
  assert.equal(status.name, "新增訂單查詢");
  assert.equal(status.workflow_snapshot.workflow_id, "spec-first");
  assert.equal(status.workflow_snapshot.stage_order[0], "new");
  assert.ok(status.workflow_snapshot.roles.some((r) => r.id === "sa-analyst"));
  await assert.rejects(stat(path.join(projectDir, ".asana-pipeline")));
});

test("projectDir 不存在、參數不合法皆拒絕且不留索引條目", async () => {
  const projectDir = await newProject();
  await createWorkItem({ ...base, projectDir });
  const before = await readIndexOrEmpty();
  await assert.rejects(createWorkItem({ ...base, projectDir: path.join(projectDir, "nope") }), /不存在/);
  await assert.rejects(createWorkItem({ ...base, projectDir, title: "  " }), /title/);
  await assert.rejects(createWorkItem({ ...base, projectDir, scope: "all" }), /scope/);
  await assert.rejects(createWorkItem({ ...base, projectDir, baseline: "x" }), /baseline/);
  await assert.rejects(createWorkItem({ ...base, projectDir, workflow: "asana-ticket" }), /workflow/);
  assert.deepEqual(await readIndexOrEmpty(), before);
});

test("標題含非法字元、過長、保留字都能建出合法目錄", async () => {
  const projectDir = await newProject();
  const nasty = 'a/b\\c:d*e?f"g<h>i|j  k\u0001l...';
  const { dir } = await createWorkItem({ ...base, projectDir, title: nasty });
  const leaf = path.basename(dir);
  assert.ok(!/[\\/:*?"<>|\u0000-\u001f]/.test(leaf));
  assert.ok(!/[. ]$/.test(leaf));
  assert.ok((await readdir(path.dirname(dir))).includes(leaf));
  const long = await createWorkItem({ ...base, projectDir, title: "長".repeat(300) });
  assert.ok(path.basename(long.dir).length <= 60);
  assert.equal(sanitizeWorkItemTitle("CON"), "CON_");
  assert.equal(sanitizeWorkItemTitle("///"), "untitled");
  assert.equal(sanitizeWorkItemTitle(" a b "), "a_b");
});

test("範圍在 SA 確認前可改，確認後鎖定", async () => {
  const projectDir = await newProject();
  const { id } = await createWorkItem({ ...base, projectDir });
  let s = await updateWorkItemScope(id, { scope: "frontend" });
  assert.equal(s.scope, "frontend");
  assert.equal(s.has_db, true);
  s = await updateWorkItemScope(id, { hasDb: false });
  assert.equal(s.scope, "frontend");
  assert.equal(s.has_db, false);
  await assert.rejects(updateWorkItemScope(id, {}), /至少/);
  await assert.rejects(updateWorkItemScope(id, { scope: "x" }), /scope/);
  await recordSpecConfirmation(id, true, "ok", false, "human");
  await assert.rejects(updateWorkItemScope(id, { scope: "backend" }), /已確認/);
  await assert.rejects(updateWorkItemScope(id, { hasDb: true }), /已確認/);
  assert.equal((await readStatus(id)).scope, "frontend");
});

test("階段已過 SA 分析師也視為鎖定；確認被打回（confirmed=false）仍可改", async () => {
  const projectDir = await newProject();
  const a = await createWorkItem({ ...base, projectDir });
  await recordSpecConfirmation(a.id, false, "打回");
  assert.equal((await updateWorkItemScope(a.id, { scope: "backend" })).scope, "backend");
  const b = await createWorkItem({ ...base, projectDir });
  await advanceStage(b.id, "db-designer");
  await assert.rejects(updateWorkItemScope(b.id, { scope: "backend" }), /已確認/);
});

test("舊 status.json 讀出再寫回逐字相同，Asana 狀態不多 key", async () => {
  const projectDir = await newProject();
  const gid = "1200000000777";
  const dir = await assignTicketDir(projectDir, gid, "某專案", "T-777");
  const fresh = await updateStatus(gid, (s) => s);
  for (const k of NEW_KEYS) assert.ok(!Object.keys(fresh).includes(k), `Asana 狀態不應有 ${k}`);
  const filePath = path.join(dir, "status.json");
  const old = { ...fresh, stage: "analyzed", project_dir: projectDir, history: [{ stage: "analyzed", at: "2026-01-01 00:00:00" }], summaries: { ...fresh.summaries, analysis: "x" } };
  await writeFile(filePath, JSON.stringify(old, null, 2), "utf-8");
  const text1 = await readFile(filePath, "utf-8");
  await updateStatus(gid, (s) => s);
  assert.equal(await readFile(filePath, "utf-8"), text1);
  const parsed = JSON.parse(text1);
  for (const k of NEW_KEYS) assert.ok(!(k in parsed));
  await advanceStage(gid, "implemented");
  const after = JSON.parse(await readFile(filePath, "utf-8"));
  assert.deepEqual(Object.keys(after).sort(), Object.keys(parsed).sort());
});

test("快照使 getStageOrder 不再 throw；無快照行為不變", () => {
  assert.throws(() => getStageOrder("custom-flow"), /找不到 workflow/);
  const snap = { stage_order: ["new", "a", "b"] };
  assert.deepEqual(getStageOrder("custom-flow", undefined, snap), ["new", "a", "b"]);
  getStageOrder("custom-flow", undefined, snap).push("x");
  assert.deepEqual(snap.stage_order, ["new", "a", "b"]);
  assert.deepEqual(getStageOrder("spec-first", undefined, null), getStageOrder("spec-first"));
  assert.equal(getStageOrder(undefined, undefined, undefined).length, 8);
});

test("快照存下後，advanceStage 以快照為準（模擬內建定義日後被改）", async () => {
  const projectDir = await newProject();
  const { id } = await createWorkItem({ ...base, projectDir });
  await updateStatus(id, (s) => ({ ...s, workflow_id: "removed-flow" }));
  const s = await advanceStage(id, "sa-analyst");
  assert.equal(s.stage, "sa-analyst");
});

test("buildWhenContext 各 scope 組合，且可餵給 resolveWorkflow", () => {
  const cases = [
    [{ scope: "frontend", has_db: false }, "true", "false", "false"],
    [{ scope: "backend", has_db: true }, "false", "true", "true"],
    [{ scope: "both", has_db: true }, "true", "true", "true"],
    [{ scope: "both", has_db: false }, "true", "true", "false"],
  ];
  for (const [st, fe, be, db] of cases) {
    const ctx = buildWhenContext({ baseline: "greenfield", ...st });
    assert.deepEqual(ctx, { baseline: "greenfield", hasFrontend: fe, hasBackend: be, hasDb: db });
  }
  const def = getBuiltinWorkflow("spec-first");
  const ids = (st) => resolveWorkflow(def, buildWhenContext(st)).roles.map((r) => r.id);
  const fe = ids({ baseline: "greenfield", scope: "frontend", has_db: false });
  assert.ok(fe.includes("mockup-designer") && fe.includes("frontend-engineer"));
  assert.ok(!fe.includes("backend-engineer") && !fe.includes("db-designer") && !fe.includes("baseline-survey"));
  const be = ids({ baseline: "brownfield", scope: "backend", has_db: true });
  assert.ok(be.includes("backend-engineer") && be.includes("db-designer") && be.includes("baseline-survey"));
  assert.ok(!be.includes("frontend-engineer") && !be.includes("mockup-designer"));
});

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});
