// spec-first 推進引擎：角色順序、平行、optional 略過、關卡卡點。
import test from "node:test";
import assert from "node:assert/strict";
import { fakeStatus } from "./helpers/support.mjs";
import { computeSpecFirstNext, applyRoleDone, applyGateDecision } from "../dist/workflow/spec-first-engine.js";
import { resolveWorkflow } from "../dist/workflow/resolve.js";
import { getBuiltinWorkflow } from "../dist/workflow/stage-order.js";
import { buildWhenContext } from "../dist/work-item-store.js";

const def = getBuiltinWorkflow("spec-first");
const mk = (o = {}) => fakeStatus({ workflow_id: "spec-first", baseline: "brownfield", scope: "both", has_db: true, ...o });
const next = (s) => computeSpecFirstNext(s, resolveWorkflow(def, buildWhenContext(s)), def.artifacts);
const must = (r) => {
  assert.equal(r.ok, true, r.error);
  return r.status;
};
const done = (s, ...ids) => ids.reduce((acc, id) => must(applyRoleDone(acc, id)), s);
const ok = (s, g, decision = "confirmed", by = "human") => must(applyGateDecision(s, g, { decision, by }));
const avail = (s) => next(s).available.map((a) => a.roleId);
const ids = (o) => resolveWorkflow(def, buildWhenContext(mk(o))).roles.map((r) => r.id);

test("both + hasDb + brownfield：角色依序推進，關卡未過前擋住後續", () => {
  let s = mk();
  assert.deepEqual(avail(s), ["baseline-survey"]);
  assert.deepEqual(next(s).available[0].files, ["baseline.md", "impact.md"]);
  s = done(s, "baseline-survey");
  assert.deepEqual(avail(s), []);
  assert.equal(next(s).pendingGates[0].gateId, "impact-content");
  s = ok(s, "impact-content", "passed", "agent");
  assert.deepEqual(avail(s), ["tech-selector"]);
  s = ok(done(s, "tech-selector"), "tech-confirm");
  assert.deepEqual(avail(s), ["mockup-designer"]);
  s = done(s, "mockup-designer");
  assert.equal(next(s).pendingGates[0].mode, "manual");
  s = ok(s, "mockup-confirm");
  assert.deepEqual(avail(s), ["sa-analyst"]);
  s = done(s, "sa-analyst");
  assert.deepEqual(next(s).pendingGates.map((g) => g.gateId).sort(), ["sa-confirm", "sa-content-check"]);
  s = ok(ok(s, "sa-content-check", "passed", "agent"), "sa-confirm", "confirmed", "agent");
  assert.deepEqual(avail(s), ["db-designer"]);
  s = done(s, "db-designer");
  assert.deepEqual(avail(s), ["flow-analyst"]);
});

test("greenfield 略過 baseline-survey；backend 略過 mockup 與前端；無 DB 略過 db-designer", () => {
  let s = mk({ baseline: "greenfield", scope: "backend", has_db: false });
  assert.deepEqual(avail(s), ["tech-selector"]);
  s = ok(done(s, "tech-selector"), "tech-confirm");
  assert.deepEqual(avail(s), ["sa-analyst"]);
  assert.deepEqual(ids({ baseline: "greenfield", scope: "backend", has_db: false }), ["tech-selector", "sa-analyst", "flow-analyst", "sd-analyst", "spec-verifier", "backend-engineer", "verifier", "tester"]);
  s = ok(ok(done(s, "sa-analyst"), "sa-content-check", "passed", "agent"), "sa-confirm", "confirmed", "agent");
  assert.deepEqual(avail(s), ["flow-analyst"]);
});

test("各 scope 與 hasDb 的角色集合", () => {
  assert.ok(ids({ scope: "frontend" }).includes("frontend-engineer"));
  assert.ok(!ids({ scope: "frontend" }).includes("backend-engineer"));
  assert.ok(ids({ scope: "frontend" }).includes("mockup-designer"));
  assert.ok(ids({ scope: "both" }).includes("frontend-engineer") && ids({ scope: "both" }).includes("backend-engineer"));
  assert.ok(!ids({ scope: "backend" }).includes("mockup-designer"));
  assert.ok(ids({ has_db: true }).includes("db-designer") && !ids({ has_db: false }).includes("db-designer"));
  assert.ok(ids({ baseline: "brownfield" }).includes("baseline-survey") && !ids({ baseline: "greenfield" }).includes("baseline-survey"));
});

test("前後端平行；兩者都完成才輪到 verifier", () => {
  let s = mk({ baseline: "greenfield", scope: "both" });
  s = ok(done(s, "tech-selector"), "tech-confirm");
  s = ok(done(s, "mockup-designer"), "mockup-confirm");
  s = ok(ok(done(s, "sa-analyst"), "sa-content-check", "passed", "agent"), "sa-confirm", "confirmed", "agent");
  s = ok(done(s, "db-designer", "flow-analyst"), "db-flow-confirm", "confirmed", "agent");
  s = ok(done(s, "sd-analyst"), "sd-confirm", "confirmed", "agent");
  s = ok(done(s, "spec-verifier"), "spec-check-verdict", "passed", "agent");
  assert.deepEqual(avail(s), ["frontend-engineer", "backend-engineer"]);
  assert.deepEqual(next(s).available[1].files, ["impl-be.md"]);
  s = done(s, "frontend-engineer");
  assert.deepEqual(avail(s), ["backend-engineer"]);
  s = done(s, "backend-engineer");
  assert.deepEqual(avail(s), []);
  s = ok(s, "implementation-content", "passed", "agent");
  assert.deepEqual(avail(s), ["verifier"]);
});

test("optional 略過：單邊 scope 時 verifier 只依賴存在的那一邊", () => {
  const r = resolveWorkflow(def, buildWhenContext(mk({ scope: "backend" })));
  assert.deepEqual(r.roles.find((x) => x.id === "verifier").dependsOn, ["backend-engineer"]);
});

test("全部完成後停在 locked 的 final-acceptance，只能 human", () => {
  let s = mk({ scope: "backend", has_db: false, baseline: "greenfield" });
  s = ok(done(s, "tech-selector"), "tech-confirm");
  s = ok(ok(done(s, "sa-analyst"), "sa-content-check", "passed", "agent"), "sa-confirm", "confirmed", "agent");
  s = ok(done(s, "flow-analyst"), "db-flow-confirm", "confirmed", "agent");
  s = ok(done(s, "sd-analyst"), "sd-confirm", "confirmed", "agent");
  s = ok(done(s, "spec-verifier"), "spec-check-verdict", "passed", "agent");
  s = ok(done(s, "backend-engineer"), "implementation-content", "passed", "agent");
  s = ok(done(s, "verifier"), "verdict", "passed", "agent");
  s = done(s, "tester");
  assert.deepEqual(next(s).pendingGates.map((g) => g.gateId).sort(), ["final-acceptance", "test-evidence"]);
  const r = applyGateDecision(s, "final-acceptance", { decision: "confirmed", by: "agent" });
  assert.equal(r.ok, false);
  assert.match(r.error, /locked/);
  assert.equal(next(s).complete, false);
  s = ok(ok(s, "test-evidence", "passed", "agent"), "final-acceptance", "confirmed", "human");
  assert.equal(next(s).complete, true);
});

test("pending 關卡的 mode：manual／auto", () => {
  const s = done(mk(), "baseline-survey", "mockup-designer");
  s.work_item_progress.gates["impact-content"] = { decision: "passed", by: "agent", at: "t" };
  assert.equal(next(s).pendingGates.find((x) => x.gateId === "mockup-confirm").mode, "manual");
  const s2 = done(mk({ scope: "backend", baseline: "greenfield" }), "sa-analyst");
  assert.equal(next(s2).pendingGates.find((x) => x.gateId === "sa-confirm").mode, "auto");
});

test("when context 的值是字串 true／false", () => {
  const c = buildWhenContext(mk({ scope: "frontend", has_db: false }));
  assert.equal(c.hasFrontend, "true");
  assert.equal(c.hasBackend, "false");
  assert.equal(c.hasDb, "false");
});

test("applyRoleDone／applyGateDecision 的錯誤與不可變", () => {
  const s = mk({ scope: "backend" });
  const snap = JSON.stringify(s);
  assert.equal(applyRoleDone(s, "nope").ok, false);
  assert.match(applyRoleDone(s, "frontend-engineer").error, /略過/);
  assert.equal(applyGateDecision(s, "nope", { decision: "confirmed", by: "human" }).ok, false);
  assert.match(applyGateDecision(s, "sa-confirm", { decision: "confirmed", by: "human" }).error, /尚未到達/);
  const reached = done(s, "baseline-survey", "sa-analyst");
  assert.match(applyGateDecision(reached, "sa-confirm", { decision: "passed", by: "human" }).error, /不接受/);
  must(applyRoleDone(s, "baseline-survey"));
  assert.equal(JSON.stringify(s), snap);
});

test("tech-selector：greenfield（略過現況盤點）也能啟動；mockup 與 sa 都依賴它，技術確認通過前被擋住", () => {
  let s = mk({ baseline: "greenfield", scope: "both" });
  assert.deepEqual(avail(s), ["tech-selector"]);
  assert.deepEqual(resolveWorkflow(def, buildWhenContext(s)).roles.find((r) => r.id === "tech-selector").dependsOn, []);
  s = done(s, "tech-selector");
  assert.deepEqual(avail(s), []);
  assert.equal(next(s).pendingGates[0].gateId, "tech-confirm");
  s = ok(s, "tech-confirm");
  assert.deepEqual(avail(s), ["mockup-designer"]);
  const back = mk({ baseline: "greenfield", scope: "backend" });
  assert.deepEqual(resolveWorkflow(def, buildWhenContext(back)).roles.find((r) => r.id === "sa-analyst").dependsOn, ["tech-selector"]);
});

test("tech-confirm：沿用現有＝程式檢查（waitingFor program-check），其他來源＝等使用者，且不受 confirmMode 覆寫為 auto 影響", () => {
  const gateOf = (source) => next(done(mk({ baseline: "greenfield", tech_source: source }), "tech-selector")).pendingGates.find((g) => g.gateId === "tech-confirm");
  const existing = gateOf("existing");
  assert.equal(existing.waitingFor, "program-check");
  for (const src of ["change", "new-guided", "new-select"]) {
    const g = gateOf(src);
    assert.equal(g.mode, "manual", src);
    assert.equal(g.waitingFor, undefined, src);
  }
  const auto = { ...def, gates: def.gates.map((g) => (g.id === "tech-confirm" ? { ...g, confirmMode: "auto" } : g)) };
  const s = done(mk({ baseline: "greenfield", tech_source: "new-select" }), "tech-selector");
  const g = computeSpecFirstNext(s, resolveWorkflow(auto, buildWhenContext(s)), auto.artifacts).pendingGates.find((x) => x.gateId === "tech-confirm");
  assert.equal(g.mode, "manual");
});

test("tech-confirm 打回會倒回 tech-selector 與全部下游", () => {
  let s = mk({ baseline: "greenfield", scope: "backend", has_db: false, tech_source: "new-select" });
  s = ok(done(s, "tech-selector"), "tech-confirm");
  s = done(s, "sa-analyst");
  const r = applyGateDecision(s, "tech-confirm", { decision: "rejected", by: "human", reason: "換方案" });
  const rewound = must(r);
  assert.deepEqual(avail(rewound), ["tech-selector"]);
  assert.equal(rewound.work_item_progress.roles["sa-analyst"], undefined);
});
