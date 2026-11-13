// work_item：註冊、create／get／set_scope／role_prompt、Asana 拒絕、錯誤格式。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setupEnv, runUntil } from "./helpers/work-item-env.mjs";

const env = await setupEnv("wi-basic-");
after(() => env.cleanup());

test("工具已註冊且 action 為必填 enum", async () => {
  const { tools } = await env.client.listTools();
  const t = tools.find((x) => x.name === "work_item");
  assert.ok(t);
  assert.equal(t.inputSchema.properties.action.enum.length, 12);
  assert.deepEqual(t.inputSchema.required, ["action"]);
});

test("create：回傳 workItemId、目錄與第一步", async () => {
  const r = await env.call({ action: "create", projectDir: env.projectDir, title: "匯出", requirement: "要匯出 Excel", baseline: "brownfield", scope: "both", hasDb: true });
  assert.equal(r.isError, false);
  assert.match(r.json.workItemId, /^wi-\d{8}-\d{3}$/);
  assert.ok(r.json.dir.includes(".dev-pipeline"));
  assert.equal(r.json.nextRoles[0].roleId, "baseline-survey");
  assert.match(r.json.summary, /現況盤點/);
});

test("create：缺欄位列出全部缺項；projectDir 不存在回 isError", async () => {
  const miss = await env.call({ action: "create", title: "x" });
  assert.equal(miss.isError, true);
  assert.match(miss.json.message, /projectDir.*requirement.*baseline.*scope.*hasDb/);
  const bad = await env.call({ action: "create", projectDir: path.join(env.tmp, "nope"), title: "x", requirement: "y", baseline: "greenfield", scope: "both", hasDb: false });
  assert.equal(bad.isError, true);
  assert.match(bad.json.message, /不存在/);
});

test("get：白話摘要說明下一步與卡住的關卡（等使用者／AI 審查）", async () => {
  const { id, dir } = await env.create();
  const g0 = await env.call({ action: "get", workItemId: id });
  assert.equal(g0.json.nextRoles[0].roleId, "tech-selector");
  await runUntil(env, id, dir, "mockup-designer");
  const g1 = await env.call({ action: "get", workItemId: id });
  assert.equal(g1.json.nextRoles[0].roleId, "mockup-designer");
  assert.deepEqual(g1.json.nextRoles[0].files, ["sa-mockup/"]);
  await runUntil(env, id, dir, "mockup-confirm");
  const g2 = await env.call({ action: "get", workItemId: id });
  assert.equal(g2.json.waitingGates[0].gateId, "mockup-confirm");
  assert.equal(g2.json.waitingGates[0].waitingFor, "user");
  await runUntil(env, id, dir, "sa-confirm");
  const g3 = await env.call({ action: "get", workItemId: id });
  assert.ok(g3.json.waitingGates.some((x) => x.gateId === "sa-confirm" && x.waitingFor === "ai-review"));
  assert.match(g3.json.summary, /AI 審查員/);
});

test("get：套用專案 flow.json 覆寫（把 mockup-confirm 改成 auto）", async () => {
  const { id, dir } = await env.create();
  await mkdir(path.join(env.projectDir, ".pipeline"), { recursive: true });
  await writeFile(path.join(env.projectDir, ".pipeline", "flow.json"), JSON.stringify({ schemaVersion: 1, gates: { "mockup-confirm": { confirmMode: "auto" } } }));
  await runUntil(env, id, dir, "mockup-confirm");
  const g = await env.call({ action: "get", workItemId: id });
  assert.equal(g.json.flowOverrideApplied, true);
  assert.equal(g.json.waitingGates.find((x) => x.gateId === "mockup-confirm").waitingFor, "ai-review");
  await writeFile(path.join(env.projectDir, ".pipeline", "flow.json"), "{壞掉");
  const bad = await env.call({ action: "get", workItemId: id });
  assert.equal(bad.isError, true);
  assert.match(bad.json.message, /flow\.json/);
  await rm0(path.join(env.projectDir, ".pipeline", "flow.json"));
});

async function rm0(p) {
  const { rm } = await import("node:fs/promises");
  await rm(p, { force: true });
}

test("role_prompt：回傳角色說明並附專案 roleNotes；未知角色回 isError", async () => {
  const { id } = await env.create();
  await mkdir(path.join(env.projectDir, ".pipeline"), { recursive: true });
  await writeFile(path.join(env.projectDir, ".pipeline", "flow.json"), JSON.stringify({ schemaVersion: 1, roles: { "sa-analyst": { roleNotes: "專案專屬補充XYZ" } } }));
  const r = await env.call({ action: "role_prompt", workItemId: id, roleId: "sa-analyst" });
  assert.equal(r.isError, false);
  assert.ok(r.json.prompt.includes("專案專屬補充XYZ"));
  assert.equal(r.json.hasProjectRoleNotes, true);
  await rm0(path.join(env.projectDir, ".pipeline", "flow.json"));
  const bad = await env.call({ action: "role_prompt", workItemId: id, roleId: "nope" });
  assert.equal(bad.isError, true);
  assert.match(bad.json.message, /未知/);
});

test("set_scope：SA 確認前可改、確認後鎖定；至少要給一個欄位", async () => {
  const { id, dir } = await env.create();
  const ok = await env.call({ action: "set_scope", workItemId: id, scope: "backend", hasDb: false });
  assert.equal(ok.json.scope, "backend");
  assert.equal((await env.call({ action: "set_scope", workItemId: id })).isError, true);
  const { id: id2, dir: dir2 } = await env.create({ scope: "both" });
  await runUntil(env, id2, dir2, "db-designer");
  const locked = await env.call({ action: "set_scope", workItemId: id2, scope: "frontend" });
  assert.equal(locked.isError, true);
  assert.match(locked.json.message, /鎖定/);
  void dir;
});

test("Asana 票單與不存在的編號一律拒絕", async () => {
  await env.store.assignTicketDir(env.projectDir, "123456", "Proj", "T-123456");
  await env.store.advanceStage("123456", "snapshot", {});
  for (const action of ["get", "set_scope", "done", "write", "role_prompt", "confirm"]) {
    const r = await env.call({ action, workItemId: "123456", scope: "both", roleId: "sa-analyst", filename: "01-sa.md", content: "x", gateId: "sd-confirm", decision: "confirmed", by: "human" });
    assert.equal(r.isError, true, action);
    assert.match(r.json.message, /Asana/, action);
  }
  const none = await env.call({ action: "get", workItemId: "wi-20000101-999" });
  assert.equal(none.isError, true);
  assert.match(none.json.message, /找不到工作項目/);
});
