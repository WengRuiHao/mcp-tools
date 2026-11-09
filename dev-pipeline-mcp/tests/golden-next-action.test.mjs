// 黃金快照：computeNextAction 在 stage × sasd 情境 × 旗標組合下的完整輸出，供重構時證明行為逐字不變。
// 預設逐項比對；UPDATE_GOLDEN=1 才會重寫 tests/golden/next-action.json。
import test from "node:test";
import { fakeStatus } from "./helpers/support.mjs";
import { checkGolden } from "./helpers/golden.mjs";
import { computeNextAction } from "../dist/next-action.js";

const rec = (confirmed, extra = {}) => ({ confirmed, confirmedAt: "2026-10-01 10:00:00", note: confirmed ? null : "打回", ...extra });

const SASD = {
  none: undefined,
  null: null,
  external: { sdMode: "external", specOrder: null },
  self: { sdMode: "self", specOrder: null },
  unregistered: { sdMode: "unregistered", specOrder: null },
  "sg-spec_first": { sdMode: "self-generated", specOrder: "spec_first" },
  "sg-code_first": { sdMode: "self-generated", specOrder: "code_first" },
  "sg-no_order": { sdMode: "self-generated", specOrder: null },
};
const SASD_ALL = ["none", "null", "external", "self", "unregistered", "sg-spec_first", "sg-code_first", "sg-no_order"];
const SASD_IRRELEVANT = ["none", "sg-code_first"];
const SASD_GLOBAL = ["none", "sg-spec_first"];

const SPEC = {
  "spec:null": null,
  "spec:rejected": rec(false),
  "spec:ok": rec(true),
  "spec:ok+skip": rec(true, { sdNotRequired: true }),
};
const CONF = { "conf:null": null, "conf:ok": rec(true), "conf:rejected": rec(false) };

/** 每個 stage 實際會讀的旗標變體（其餘旗標剪枝）。 */
function coreVariants(stage) {
  const v = (label, status) => ({ label, status: { stage, ...status } });
  switch (stage) {
    case "snapshot":
      return [v("dir:null", {}), v("dir:set", { project_dir: "/p" })];
    case "project_dir_confirmed":
      return [v("sasd:unchecked", {}), v("sasd:checked", { sasd_checked: true })];
    case "analyzed":
      return [v("spec:null", {}), v("spec:ok+skip", { spec_confirmation: SPEC["spec:ok+skip"] })];
    case "sd_drafted":
      return Object.entries(SPEC).map(([label, spec]) => v(label, { spec_confirmation: spec }));
    case "implemented":
      return [v("spec:null", {}), v("spec:ok", { spec_confirmation: SPEC["spec:ok"] }), v("spec:ok+skip", { spec_confirmation: SPEC["spec:ok+skip"] })];
    case "verified": {
      const out = [v("verdict:null", {}), v("verdict:PASS", { verdict: "PASS" })];
      for (const rc of [null, "analysis", "implementation"]) out.push(v(`verdict:FAIL/rc:${rc}`, { verdict: "FAIL", verifier_root_cause: rc }));
      return out;
    }
    case "tested": {
      const out = [];
      for (const [cl, c] of Object.entries(CONF)) {
        out.push(v(`verdict:null/${cl}`, { confirmation: c }));
        out.push(v(`verdict:PASS/${cl}`, { verdict: "PASS", confirmation: c }));
        for (const rc of [null, "analysis", "implementation"]) out.push(v(`verdict:FAIL/rc:${rc}/${cl}`, { verdict: "FAIL", verifier_root_cause: rc, confirmation: c }));
      }
      return out;
    }
    default:
      return [v("base", {})];
  }
}

const EXT_NONE = { analysis_externally_modified: false, implementation_externally_modified: false, verification_externally_modified: false, test_externally_modified: false };
const STALE_NONE = { analysis_stale: false, implementation_stale: false, verification_stale: false };

/** 與 stage 無關的全域旗標；每項可覆蓋 status 或 ctx。 */
const GLOBALS = {
  "g:ext01": { ctx: { externalChanges: { ...EXT_NONE, analysis_externally_modified: true } } },
  "g:ext-all": { ctx: { externalChanges: { analysis_externally_modified: true, implementation_externally_modified: true, verification_externally_modified: true, test_externally_modified: true } } },
  "g:ext-none": { ctx: { externalChanges: EXT_NONE } },
  "g:sync-analysis": { ctx: { syncFlags: { ...STALE_NONE, analysis_stale: true } } },
  "g:sync-all": { ctx: { syncFlags: { analysis_stale: true, implementation_stale: true, verification_stale: true } } },
  "g:sync-from-status": { status: { sync: { analysis_hash: "a2", analysis_hash_at_impl_write: "a1", verification_hash: "v2", verification_hash_at_test_write: "v1" } } },
  "g:manual": { status: { implementation_manual_actions: ["a", "b"], verification_manual_actions: ["c"], test_manual_actions: ["d"] } },
  "g:shots": { status: { test_evidence: [{ pendingManualScreenshot: true }, { pendingManualScreenshot: false }, { pendingManualScreenshot: true }] } },
  "g:human-reanalysis": { status: { human_requested_reanalysis: true } },
  "g:needs-reanalysis": { status: { needs_reanalysis: true } },
  "g:needs-reanalysis+checked": { status: { needs_reanalysis: true, sasd_checked: true } },
  "g:fail3": { status: { consecutive_fail_count: 3 } },
  "g:fail5+reanalysis": { status: { consecutive_fail_count: 5, needs_reanalysis: true } },
  "g:combo": {
    status: { needs_reanalysis: true, human_requested_reanalysis: true, implementation_manual_actions: ["a"], test_evidence: [{ pendingManualScreenshot: true }] },
    ctx: {
      externalChanges: { analysis_externally_modified: true, implementation_externally_modified: false, verification_externally_modified: true, test_externally_modified: false },
      syncFlags: { analysis_stale: true, implementation_stale: false, verification_stale: true },
    },
  },
};

const STAGES = ["new", "snapshot", "project_dir_confirmed", "analyzed", "sd_drafted", "implemented", "verified", "tested"];
const SASD_RELEVANT = new Set(["analyzed", "sd_drafted", "implemented"]);

function buildCases() {
  const cases = {};
  const add = (name, status, ctx) => {
    cases[name] = computeNextAction(fakeStatus(status), ctx);
  };
  for (const stage of STAGES) {
    const variants = coreVariants(stage);
    const sasdKeys = SASD_RELEVANT.has(stage) ? SASD_ALL : SASD_IRRELEVANT;
    for (const sk of sasdKeys) {
      for (const { label, status } of variants) {
        add(`${stage}|sasd:${sk}|${label}`, status, sk === "none" ? {} : { sasd: SASD[sk] });
      }
    }
    // 全域旗標：每個 stage 只挑一個代表變體
    const rep = variants[variants.length > 2 ? 1 : 0];
    for (const sk of SASD_GLOBAL) {
      for (const [gl, g] of Object.entries(GLOBALS)) {
        const ctx = { ...(sk === "none" ? {} : { sasd: SASD[sk] }), ...(g.ctx ?? {}) };
        add(`${stage}|sasd:${sk}|${rep.label}|${gl}`, { ...rep.status, ...(g.status ?? {}) }, ctx);
      }
    }
  }
  return cases;
}

test("golden: computeNextAction 全部組合與快照逐字相同", () => {
  checkGolden("next-action.json", buildCases());
});
