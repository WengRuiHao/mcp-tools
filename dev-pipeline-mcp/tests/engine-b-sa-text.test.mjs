// 問題 58：規格驗證 FAIL 的輕量根因 sa-text 只退回 SA 與規格驗證師，不動 DB／流程／SD；sa 根因行為不變。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { setupEnv, fulfil, runUntil, CLEAN_REVIEW } from "./helpers/work-item-env.mjs";
import { buildSpecFirstWorkflow } from "../dist/workflow/builtin/spec-first.js";
import { validateWorkflow } from "../dist/workflow/validate.js";
import { parseWorkflowDefinition } from "../dist/workflow/schema.js";

const env = await setupEnv("wi-eng-b-satext-");
after(() => env.cleanup());
const progress = async (id) => (await env.store.readStatus(id)).work_item_progress;
const failSpec = (id, rootCause, extra = {}) => env.call({ action: "verdict", workItemId: id, gateId: "spec-check-verdict", result: "fail", rootCause, by: "human", reason: "使用者說要退回", ...extra });

test("內建流程含 sa-text 且通過語意驗證；schema 接受 routeRewind", () => {
  const def = buildSpecFirstWorkflow();
  assert.deepEqual(validateWorkflow(def), []);
  const g = def.gates.find((x) => x.id === "spec-check-verdict");
  assert.equal(g.routeOnFail["sa-text"], "sa-analyst");
  assert.deepEqual(g.routeRewind["sa-text"], ["sa-analyst", "spec-verifier"]);
  assert.equal(g.routeOnFail.sa, "sa-analyst");
  assert.equal(parseWorkflowDefinition(JSON.parse(JSON.stringify(def))).ok, true);
});

test("validate：routeRewind 的根因不在 routeOnFail、漏掉退回目標、引用不存在角色都會報錯", () => {
  const def = buildSpecFirstWorkflow();
  const withRewind = (routeRewind) => ({ ...def, gates: def.gates.map((g) => (g.id === "spec-check-verdict" ? { ...g, routeRewind } : g)) });
  assert.match(validateWorkflow(withRewind({ nope: ["sa-analyst"] })).join("；"), /routeRewind 根因「nope」不在 routeOnFail/);
  assert.match(validateWorkflow(withRewind({ "sa-text": ["spec-verifier"] })).join("；"), /必須包含退回目標角色：sa-analyst/);
  assert.match(validateWorkflow(withRewind({ "sa-text": ["sa-analyst", "ghost"] })).join("；"), /不存在的角色：ghost/);
});

test("sa-text：只退回 SA 與規格驗證師，DB／流程／SD 的完成與確認保留，SA 確認被重置", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "spec-check-verdict");
  const before = await progress(id);
  const r = await failSpec(id, "sa-text");
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.routedTo, "sa-analyst");
  assert.deepEqual([...r.json.rewound].sort(), ["sa-analyst", "spec-verifier"]);
  assert.deepEqual([...r.json.rewoundRoles].sort(), ["sa-analyst", "spec-verifier"]);
  const p = await progress(id);
  for (const role of ["db-designer", "flow-analyst", "sd-analyst"]) assert.equal(p.roles[role].done, true, role);
  for (const gate of ["db-flow-confirm", "sd-confirm"]) assert.equal(p.gates[gate].decision, "confirmed", gate);
  assert.equal(p.gates["sa-confirm"], undefined);
  assert.equal(p.gates["sa-content-check"], undefined);
  assert.equal(p.roles["sa-analyst"], undefined);
  assert.equal(p.gates["spec-check-verdict"].rootCause, "sa-text");
  assert.equal(p.gates["spec-check-verdict"].reason, "使用者說要退回");
  assert.equal(before.roles["db-designer"].at, p.roles["db-designer"].at);
  assert.deepEqual(r.json.nextRoles.map((n) => n.roleId), ["sa-analyst"]);
});

test("sa-text 之後重做 SA、SA 確認，規格驗證師可再做（流程可走通）", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "spec-check-verdict");
  await failSpec(id, "sa-text");
  await fulfil(dir, "sa-analyst");
  assert.equal((await env.call({ action: "done", workItemId: id, roleId: "sa-analyst" })).isError, false);
  const c = await env.call({ action: "confirm", workItemId: id, gateId: "sa-confirm", decision: "confirmed", by: "human", reason: "使用者說確認" });
  assert.equal(c.isError, false, c.text);
  assert.deepEqual(c.json.nextRoles.map((n) => n.roleId), ["spec-verifier"]);
});

test("rootCause=sa 行為不變：連鎖退回 SA、DB、流程、SD、規格驗證", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "spec-check-verdict");
  const r = await failSpec(id, "sa");
  assert.equal(r.isError, false, r.text);
  assert.deepEqual([...r.json.rewoundRoles].sort(), ["db-designer", "flow-analyst", "sa-analyst", "sd-analyst", "spec-verifier"]);
  const p = await progress(id);
  assert.equal(p.roles["db-designer"], undefined);
  assert.equal(p.gates["sd-confirm"], undefined);
});

test("不合法的 rootCause：錯誤訊息列出可用值並說明 sa-text 的意義", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "spec-check-verdict");
  const r = await failSpec(id, "nope");
  assert.equal(r.isError, true);
  assert.match(r.json.message, /sa-text（SA 文字／截圖用字修正/);
  const none = await env.call({ action: "verdict", workItemId: id, gateId: "spec-check-verdict", result: "fail", by: "human", reason: "使用者說不通過" });
  assert.equal(none.isError, true);
  assert.match(none.json.message, /sa-text/);
});

test("agent 判 sa-text：spec-check.md 帶 rootCause: sa-text 可交件，判定與報告一致才成功", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "spec-verifier");
  await fulfil(dir, "spec-verifier", { verdictText: "FAIL\nrootCause: sa-text\n截圖用字與系統訊息不一致" });
  const d = await env.call({ action: "done", workItemId: id, roleId: "spec-verifier" });
  assert.equal(d.isError, false, d.text);
  const wrong = await env.call({ action: "verdict", workItemId: id, gateId: "spec-check-verdict", result: "fail", rootCause: "sa", by: "agent", review: CLEAN_REVIEW, reason: "用字不一致" });
  assert.equal(wrong.isError, true);
  const ok = await env.call({ action: "verdict", workItemId: id, gateId: "spec-check-verdict", result: "fail", rootCause: "sa-text", by: "agent", review: CLEAN_REVIEW, reason: "用字不一致" });
  assert.equal(ok.isError, false, ok.text);
  assert.equal((await progress(id)).roles["sd-analyst"].done, true);
});
