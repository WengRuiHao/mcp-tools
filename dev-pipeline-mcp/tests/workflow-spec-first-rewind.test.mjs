// spec-first 驗證不通過：退回目標、倒回範圍、連續 FAIL、dispatch 與 Asana 往返。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fakeStatus, makeTmpDir, removeDir, isolateDataDir } from "./helpers/support.mjs";
import { applyRoleDone, applyGateDecision, applyVerdictFail } from "../dist/workflow/spec-first-engine.js";
import { computeNextActionForWorkflow } from "../dist/workflow/next-action-dispatch.js";
import { computeNextAction } from "../dist/next-action.js";
import { isSaConfirmed } from "../dist/work-item-store.js";

const mk = (o = {}) => fakeStatus({ workflow_id: "spec-first", baseline: "greenfield", scope: "both", has_db: true, ...o });
const must = (r) => {
  assert.equal(r.ok, true, r.error);
  return r.status;
};
const gate = (s, g, decision, by = "agent") => must(applyGateDecision(s, g, { decision, by }));
const ALL = ["sa-analyst", "db-designer", "flow-analyst", "sd-analyst", "spec-verifier", "frontend-engineer", "backend-engineer", "verifier"];
const AFTER_GATES = {
  "sa-analyst": [["sa-content-check", "passed"], ["sa-confirm", "confirmed"]],
  "flow-analyst": [["db-flow-confirm", "confirmed"]],
  "sd-analyst": [["sd-confirm", "confirmed"]],
  "spec-verifier": [["spec-check-verdict", "passed"]],
  "backend-engineer": [["implementation-content", "passed"]],
};

/** 走到 verifier 完成，其前所有關卡通過。 */
function atVerdict(o) {
  let s = mk(o);
  for (const id of ALL) {
    if (id === "db-designer" && o?.has_db === false) continue;
    s = must(applyRoleDone(s, id));
    for (const [g, d] of AFTER_GATES[id] ?? []) s = gate(s, g, d);
  }
  return s;
}
/** 把從 target 起（含）的角色重做完成，並讓途中關卡通過。 */
function redo(s, target) {
  for (const id of ALL.slice(ALL.indexOf(target))) {
    if (s.work_item_progress.roles[id]?.done) continue;
    s = must(applyRoleDone(s, id));
    for (const [g, d] of AFTER_GATES[id] ?? []) s = gate(s, g, d);
  }
  return s;
}

test("verdict FAIL 各 rootCause：退回目標與倒回範圍（下游清除、上游保留）", () => {
  const cases = {
    sa: ["sa-analyst", ALL],
    db: ["db-designer", ALL.slice(1)],
    flow: ["flow-analyst", ALL.slice(2)],
    sd: ["sd-analyst", ALL.slice(3)],
    fe: ["frontend-engineer", ["frontend-engineer", "verifier"]],
    be: ["backend-engineer", ["backend-engineer", "verifier"]],
  };
  for (const [cause, [target, rewound]] of Object.entries(cases)) {
    const s0 = atVerdict();
    const before = JSON.stringify(s0);
    const r = applyVerdictFail(s0, "verdict", cause, { now: "T" });
    assert.equal(r.ok, true, cause);
    assert.equal(r.routedTo, target);
    assert.deepEqual(r.rewound, [...ALL.filter((id) => rewound.includes(id)), "tester"], cause);
    const p = r.status.work_item_progress;
    for (const id of ALL) assert.equal(p.roles[id]?.done === true, !rewound.includes(id), `${cause}/${id}`);
    assert.equal(p.gates.verdict.rootCause, cause);
    assert.equal(r.status.consecutive_fail_count, 1);
    assert.equal(JSON.stringify(s0), before, "原物件不被改");
  }
});

test("上游關卡決定保留、下游關卡決定清除", () => {
  const g = applyVerdictFail(atVerdict(), "verdict", "sd").status.work_item_progress.gates;
  assert.ok(g["sa-confirm"] && g["db-flow-confirm"]);
  assert.equal(g["sd-confirm"], undefined);
  assert.equal(g["spec-check-verdict"], undefined);
  assert.equal(g["implementation-content"], undefined);
});

test("spec-check-verdict 的 FAIL、不合法 rootCause、被略過的角色", () => {
  let s = mk();
  for (const id of ["sa-analyst", "db-designer", "flow-analyst", "sd-analyst", "spec-verifier"]) s = must(applyRoleDone(s, id));
  assert.equal(applyVerdictFail(s, "spec-check-verdict", "fe").ok, false);
  assert.match(applyVerdictFail(s, "spec-check-verdict", "toString").error, /routeOnFail/);
  assert.equal(applyVerdictFail(s, "spec-check-verdict", "db").routedTo, "db-designer");
  assert.equal(applyVerdictFail(s, "sa-confirm", "sa").ok, false);
  assert.match(applyVerdictFail(atVerdict({ has_db: false }), "verdict", "db").error, /略過/);
  assert.equal(applyVerdictFail(mk(), "verdict", "sa").ok, false, "verifier 未完成不可判 FAIL");
});

test("連續 3 次 FAIL 要求 manual；passed 歸零", () => {
  const r1 = applyVerdictFail(atVerdict(), "verdict", "be");
  assert.equal(r1.requireManual, false);
  const r2 = applyVerdictFail(redo(r1.status, "backend-engineer"), "verdict", "be");
  assert.equal(r2.consecutiveFailCount, 2);
  assert.equal(r2.requireManual, false);
  const r3 = applyVerdictFail(redo(r2.status, "backend-engineer"), "verdict", "be");
  assert.equal(r3.consecutiveFailCount, 3);
  assert.equal(r3.requireManual, true);
  assert.equal(r3.hardStop, "consecutive-fail-3");
  assert.equal(gate(redo(r3.status, "backend-engineer"), "verdict", "passed").consecutive_fail_count, 0);
});

test("confirmation rejected 會倒回該角色", () => {
  let s = must(applyRoleDone(mk(), "sa-analyst"));
  s = gate(s, "sa-confirm", "rejected", "human");
  assert.equal(s.work_item_progress.roles["sa-analyst"], undefined);
  assert.equal(s.work_item_progress.gates["sa-confirm"].decision, "rejected");
  assert.equal(isSaConfirmed(s), false);
});

test("isSaConfirmed：逐關卡紀錄優先，缺紀錄維持近似判斷", () => {
  const s = must(applyRoleDone(mk(), "sa-analyst"));
  assert.equal(isSaConfirmed(s), false);
  assert.equal(isSaConfirmed(gate(s, "sa-confirm", "confirmed", "human")), true);
  assert.equal(isSaConfirmed(mk({ spec_confirmation: { confirmed: true, confirmedAt: "x", note: null } })), true);
});

test("dispatch：spec-first 回引擎結果；Asana／缺省與舊結果逐字相同", () => {
  const r = computeNextActionForWorkflow(mk({ scope: "backend" }), {}, "spec-first");
  assert.match(r.summary, /tech-selector/);
  assert.match(r.summary, /tech-stack/);
  assert.deepEqual(r.suggestedTools, []);
  const waiting = must(applyRoleDone(mk({ scope: "backend" }), "sa-analyst"));
  assert.match(computeNextActionForWorkflow(waiting, {}, "spec-first").summary, /審查員/);
  const a = fakeStatus({ stage: "analyzed", project_dir: "/p" });
  for (const id of [undefined, null, "asana-ticket"]) assert.equal(JSON.stringify(computeNextActionForWorkflow(a, {}, id)), JSON.stringify(computeNextAction(a, {})));
  assert.match(computeNextActionForWorkflow(a, {}, "other").summary, /尚未支援/);
});

test("Asana status.json 讀出再寫回逐字相同且不出現 work_item_progress", async () => {
  const iso = isolateDataDir();
  const projectDir = makeTmpDir("dpm-wip-proj-");
  try {
    const store = await import("../dist/pipeline-store.js");
    const dir = await store.assignTicketDir(projectDir, "wip1", "Proj", "T-wip1");
    await store.updateStatus("wip1", (s) => s);
    const file = path.join(dir, "status.json");
    const before = fs.readFileSync(file, "utf-8");
    await store.updateStatus("wip1", (s) => s);
    assert.equal(fs.readFileSync(file, "utf-8"), before);
    assert.ok(!before.includes("work_item_progress"));
    const st = await store.updateStatus("wip1", (s) => ({ ...s, work_item_progress: { roles: { x: { done: true, at: "t" } }, gates: {} } }));
    assert.equal(st.work_item_progress.roles.x.done, true);
  } finally {
    iso.cleanup();
    removeDir(projectDir);
  }
});
