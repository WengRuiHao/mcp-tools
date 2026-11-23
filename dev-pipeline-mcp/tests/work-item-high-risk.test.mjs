// highRisk 開關（批次 1-A）：只在 true 時寫入狀態檔與回覆；SA 確認後鎖定；進入 when context。全部用暫存目錄隔離。
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "wi-hr-data-"));
process.env.ASANA_PIPELINE_DATA_DIR = dataDir;

const { createWorkItem, updateWorkItemScope, buildWhenContext } = await import("../dist/work-item-store.js");
const { readStatus, recordSpecConfirmation } = await import("../dist/pipeline-store.js");
const { KNOWN_WHEN_KEYS, evalWhen } = await import("../dist/workflow/validate.js");

const base = { title: "高風險示範", requirement: "需求原文", baseline: "greenfield", scope: "both", hasDb: true, workflow: "spec-first" };
const newProject = () => mkdtemp(path.join(os.tmpdir(), "wi-hr-proj-"));
const readRaw = (dir) => readFile(path.join(dir, "status.json"), "utf-8");

test("沒給 highRisk：status.json 完全沒有 high_risk 這個 key（簡單需求逐字不變）", async () => {
  const { dir } = await createWorkItem({ ...base, projectDir: await newProject() });
  assert.ok(!Object.keys(JSON.parse(await readRaw(dir))).includes("high_risk"));
});

test("highRisk=false 也不寫入 high_risk", async () => {
  const { dir } = await createWorkItem({ ...base, highRisk: false, projectDir: await newProject() });
  assert.ok(!Object.keys(JSON.parse(await readRaw(dir))).includes("high_risk"));
});

test("highRisk=true：寫入 high_risk=true", async () => {
  const { id } = await createWorkItem({ ...base, highRisk: true, projectDir: await newProject() });
  assert.equal((await readStatus(id)).high_risk, true);
});

test("highRisk 不是布林值就拒絕建立與修改", async () => {
  const projectDir = await newProject();
  await assert.rejects(createWorkItem({ ...base, highRisk: "yes", projectDir }), /highRisk 必須是布林值/);
  const { id } = await createWorkItem({ ...base, projectDir });
  await assert.rejects(updateWorkItemScope(id, { highRisk: 1 }), /highRisk 必須是布林值/);
});

test("set_scope：SA 確認前可開可關，確認後鎖定", async () => {
  const { id } = await createWorkItem({ ...base, projectDir: await newProject() });
  assert.equal((await updateWorkItemScope(id, { highRisk: true })).high_risk, true);
  const off = await updateWorkItemScope(id, { highRisk: false });
  assert.ok(!Object.keys(off).includes("high_risk"), "關掉後不留 high_risk key");
  await updateWorkItemScope(id, { highRisk: true });
  await recordSpecConfirmation(id, true, "ok", false, "human");
  await assert.rejects(updateWorkItemScope(id, { highRisk: false }), /已確認/);
  assert.equal((await readStatus(id)).high_risk, true);
});

test("buildWhenContext 帶 highRisk 字串；when 可以用 highRisk==true 並可與 baseline 以 && 組合", () => {
  assert.equal(buildWhenContext({ baseline: "greenfield", scope: "both", has_db: true }).highRisk, "false");
  const on = buildWhenContext({ baseline: "greenfield", scope: "both", has_db: true, high_risk: true });
  assert.equal(on.highRisk, "true");
  assert.ok(KNOWN_WHEN_KEYS.includes("highRisk"));
  assert.equal(evalWhen("baseline==greenfield&&highRisk==true", on), true);
  assert.equal(evalWhen("baseline==greenfield&&highRisk==true", buildWhenContext({ baseline: "greenfield", scope: "both", has_db: true })), false);
  assert.equal(evalWhen("baseline==brownfield&&highRisk==true", on), false);
});

// ---- work_item 工具層：create／get／set_scope／交付摘要 ----
const { setupEnv } = await import("./helpers/work-item-env.mjs");
const { after } = await import("node:test");
const env = await setupEnv("wi-hr-");
after(() => env.cleanup());
const createArgs = (extra = {}) => ({ action: "create", projectDir: env.projectDir, title: "訂單", requirement: "要處理高併發訂單", baseline: "greenfield", scope: "both", hasDb: true, ...extra });

test("工具：create 沒給 highRisk，回覆與 get 都沒有 highRisk 欄位", async () => {
  const c = await env.call(createArgs());
  assert.equal(c.isError, false);
  assert.ok(!("highRisk" in c.json));
  const g = await env.call({ action: "get", workItemId: c.json.workItemId });
  assert.ok(!("highRisk" in g.json));
});

test("工具：create highRisk=true，回覆與 get 都顯示 highRisk=true", async () => {
  const c = await env.call(createArgs({ highRisk: true }));
  assert.equal(c.isError, false);
  assert.equal(c.json.highRisk, true);
  const g = await env.call({ action: "get", workItemId: c.json.workItemId });
  assert.equal(g.json.highRisk, true);
});

test("工具：set_scope 只給 highRisk 也可以，SA 確認後被鎖定", async () => {
  const c = await env.call(createArgs());
  const id = c.json.workItemId;
  const on = await env.call({ action: "set_scope", workItemId: id, highRisk: true });
  assert.equal(on.isError, false);
  assert.equal(on.json.highRisk, true);
  const off = await env.call({ action: "set_scope", workItemId: id, highRisk: false });
  assert.ok(!("highRisk" in off.json));
  const none = await env.call({ action: "set_scope", workItemId: id });
  assert.equal(none.isError, true);
  assert.match(none.json.message, /highRisk/);
});

test("工具：參數 schema 有 highRisk（布林）", async () => {
  const { tools } = await env.client.listTools();
  const t = tools.find((x) => x.name === "work_item");
  assert.equal(t.inputSchema.properties.highRisk.type, "boolean");
});
