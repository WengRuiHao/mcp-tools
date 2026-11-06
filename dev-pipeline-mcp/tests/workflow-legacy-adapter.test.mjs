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

import { buildStepPlan as plan } from "../dist/step-plan.js";
import { parseLegacyGates } from "../dist/workflow/legacy-adapter.js";

test("M3 已知差異：self-generated 缺 specOrder，buildStepPlan 兩種都列、adapter 兩個規格撰寫者都不啟用", () => {
  const cfg = sasd("self-generated", null);
  const sp = plan(cfg);
  assert.equal(sp.specOrder, null);
  assert.ok(sp.steps.some((s) => s.includes("3.4｜3.6")));
  const r = fromLegacy(cfg, null, false, null);
  const roles = resolveWorkflow(r.workflow, r.context).roles.map((x) => x.id);
  assert.ok(!roles.includes("spec-writer-first") && !roles.includes("spec-writer-reverse"));
  assert.ok(r.warnings.some((w) => /specOrder/.test(w)));
});

test("M3 已知差異：fromLegacy(null) 退到 4 角色並警告，buildStepPlan(null) 回 null", () => {
  assert.equal(plan(null), null);
  const r = fromLegacy(null, null, false, null);
  assert.deepEqual(resolveWorkflow(r.workflow, r.context).roles.map((x) => x.id), ["analyst", "engineer", "verifier", "tester"]);
  assert.ok(r.warnings.some((w) => /sasd_config/.test(w)));
});

test("M4：確認關卡依 sdMode／specOrder 出現，final-acceptance 一律存在且 locked", () => {
  const expected = {
    "external/null": [],
    "self/null": [],
    "unregistered/null": [],
    "self-generated/spec_first": ["sd-confirm-first"],
    "self-generated/code_first": ["sd-confirm-reverse"],
  };
  for (const [sdMode, specOrder] of SD_CASES) {
    const { workflow, context } = fromLegacy(sasd(sdMode, specOrder), null, false, null);
    const gates = resolveWorkflow(workflow, context).gates;
    const confirms = gates.map((g) => g.id).filter((id) => id.startsWith("sd-confirm"));
    assert.deepEqual(confirms, expected[`${sdMode}/${specOrder}`], `${sdMode}/${specOrder}`);
    const fin = gates.find((g) => g.id === "final-acceptance");
    assert.ok(fin, "final-acceptance 存在");
    assert.deepEqual([fin.locked, fin.effectiveConfirm.mode], [true, "manual"]);
  }
});

test("M4：沒有 sasd 時也有 final-acceptance 且無 SD 確認關卡", () => {
  const { workflow, context } = fromLegacy(null, null, false, null);
  const ids = resolveWorkflow(workflow, context).gates.map((g) => g.id);
  assert.ok(ids.includes("final-acceptance") && !ids.some((i) => i.startsWith("sd-confirm")));
});

test("L5：gates.json 的 pathPrefix／minPaths／requireSasd 保留成 CheckDef 結構化欄位", () => {
  const gates = { analysisReferences: [{ ticketNamePattern: ".*", heading: "舊碼參考", pathPrefix: "src/", minPaths: 2, requireSasd: true }] };
  const c = fromLegacy(sasd("external"), null, false, gates).workflow.gates.find((g) => g.id === "analysis-content").checks[0];
  assert.deepEqual([c.pathPrefix, c.minPaths, c.requireSasd], ["src/", 2, true]);
  const bare = fromLegacy(sasd("external"), null, false, { analysisReferences: [{ ticketNamePattern: ".*", heading: "h", pathPrefix: "p/" }] })
    .workflow.gates.find((g) => g.id === "analysis-content").checks[0];
  assert.ok(!("minPaths" in bare) && !("requireSasd" in bare));
});

test("L5：gates.json 形狀不合法回清楚錯誤，不是 TypeError，也不產生 undefined", () => {
  const bad = [
    { analysisReferences: "oops" },
    { analysisReferences: [{ ticketNamePattern: ".*", pathPrefix: "src/" }] },
    { implementationSections: [{ ticketNamePattern: ".*" }] },
    { implementationSections: [null] },
    "text",
  ];
  for (const g of bad) {
    assert.throws(() => fromLegacy(sasd("external"), null, false, g), (e) => !(e instanceof TypeError) && /gates\.json 形狀不合法/.test(e.message), JSON.stringify(g));
  }
  assert.throws(() => parseLegacyGates({ analysisReferences: [{ ticketNamePattern: ".*", pathPrefix: "p" }] }), /heading/);
  const ok = fromLegacy(sasd("external"), null, false, { analysisReferences: [{ ticketNamePattern: ".*", heading: "x", pathPrefix: "p" }], other: 1 });
  assert.ok(!ok.workflow.gates.some((g) => (g.checks ?? []).some((c) => /undefined/.test(c.description))));
});
