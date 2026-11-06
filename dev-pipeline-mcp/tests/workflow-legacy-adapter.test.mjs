// fromLegacy 對映與等價性：sdMode × specOrder × testCapabilityMode 各組合，與 step-plan.ts／STAGE_ORDER 一致。
import test from "node:test";
import assert from "node:assert/strict";
import { fromLegacy } from "../dist/workflow/legacy-adapter.js";
import { resolveWorkflow } from "../dist/workflow/resolve.js";
import { validateWorkflow } from "../dist/workflow/validate.js";
import { ASANA_ROLE_STAGE } from "../dist/workflow/builtin/asana-ticket.js";
import { buildStepPlan } from "../dist/step-plan.js";
import { STAGE_ORDER } from "../dist/pipeline-store.js";

const STEP_OF_ROLE = { analyst: "3.3", "spec-writer-first": "3.4", engineer: "3.5", "spec-writer-reverse": "3.6", verifier: "3.7", tester: "3.8" };
const sasd = (sdMode, specOrder = null) => ({ saRoot: "N/A-x", sdMode, sdRoot: null, sdOutputPath: sdMode === "self-generated" ? "sd.md" : null, svnConnectionId: null, specOrder });
const SD_CASES = [
  ["external", null],
  ["self", null],
  ["unregistered", null],
  ["self-generated", "spec_first"],
  ["self-generated", "code_first"],
];
const TEST_MODES = ["modern", "legacy_junit4", "none", null];

for (const [sdMode, specOrder] of SD_CASES) {
  for (const mode of TEST_MODES) {
    test(`等價：${sdMode}/${specOrder}/${mode} 的步驟順序等於 buildStepPlan`, () => {
      const cfg = sasd(sdMode, specOrder);
      const { workflow, context } = fromLegacy(cfg, mode ? { mode, note: null } : null, false, null);
      assert.deepEqual(validateWorkflow(workflow), []);
      const steps = resolveWorkflow(workflow, context).roles.map((r) => STEP_OF_ROLE[r.id]);
      assert.deepEqual(steps, buildStepPlan(cfg).steps.filter((s) => s >= "3.3"));
    });
  }
}

test("等價：非 code_first 的 stage 順序是 STAGE_ORDER 的子序列", () => {
  for (const [sdMode, specOrder] of SD_CASES.filter(([, o]) => o !== "code_first")) {
    const { workflow, context } = fromLegacy(sasd(sdMode, specOrder), null, false, null);
    const idx = resolveWorkflow(workflow, context).roles.map((r) => STAGE_ORDER.indexOf(ASANA_ROLE_STAGE[r.id]));
    assert.ok(idx.every((i) => i >= 0));
    assert.deepEqual(idx, [...idx].sort((a, b) => a - b));
  }
});

test("code_first：sd_drafted 排在 implemented 之後、verified 之前（對應 next-action 擋 verified）", () => {
  const { workflow, context } = fromLegacy(sasd("self-generated", "code_first"), null, false, null);
  const stages = resolveWorkflow(workflow, context).roles.map((r) => ASANA_ROLE_STAGE[r.id]);
  assert.deepEqual(stages, ["analyzed", "implemented", "sd_drafted", "verified", "tested"]);
});

test("self-generated 缺 specOrder：不猜，兩個規格撰寫者都不啟用並有 warning", () => {
  const r = fromLegacy(sasd("self-generated", null), null, false, null);
  assert.ok(r.warnings.some((w) => /specOrder/.test(w)));
  assert.deepEqual(resolveWorkflow(r.workflow, r.context).roles.map((x) => x.id), ["analyst", "engineer", "verifier", "tester"]);
});

test("沒有 sasd：warning 並退到最小角色集", () => {
  const r = fromLegacy(null, null, false, null);
  assert.ok(r.warnings.length > 0);
  assert.equal(resolveWorkflow(r.workflow, r.context).roles.length, 4);
});

test("gates.json 對映成內容關卡 checks", () => {
  const gates = {
    analysisReferences: [{ ticketNamePattern: ".*", heading: "舊碼參考", pathPrefix: "src/", minPaths: 2 }],
    implementationSections: [{ ticketNamePattern: ".*", heading: "查重", minChars: 40 }],
  };
  const { workflow } = fromLegacy(sasd("external"), null, false, gates);
  const gate = (id) => workflow.gates.find((g) => g.id === id);
  assert.equal(gate("analysis-content").checks[0].heading, "舊碼參考");
  assert.deepEqual([gate("implementation-content").checks[0].heading, gate("implementation-content").checks[0].minChars], ["查重", 40]);
  assert.deepEqual(fromLegacy(sasd("external"), null, false, null).workflow.gates.find((g) => g.id === "implementation-content").checks, []);
});

test("testCapability 與 legacyTestProfile 對映成 roleNotes", () => {
  const { workflow } = fromLegacy(sasd("external"), { mode: "legacy_junit4", note: "JDK6" }, true, null);
  const note = (id) => workflow.roles.find((r) => r.id === id).roleNotes;
  assert.match(note("engineer"), /JUnit4.*JDK6/);
  assert.match(note("tester"), /legacy_test_profile/);
  const none = fromLegacy(sasd("external"), { mode: "none", note: null }, false, null).workflow;
  assert.match(none.roles.find((r) => r.id === "engineer").roleNotes, /不能寫自動化測試/);
  const modern = fromLegacy(sasd("external"), { mode: "modern", note: null }, false, null).workflow;
  assert.equal(modern.roles.find((r) => r.id === "engineer").roleNotes, undefined);
});

test("不改傳入的設定物件", () => {
  const cfg = sasd("self-generated", "spec_first");
  const snap = JSON.stringify(cfg);
  fromLegacy(cfg, { mode: "none", note: null }, true, null);
  assert.equal(JSON.stringify(cfg), snap);
});
