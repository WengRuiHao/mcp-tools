// 黃金快照：getRolePrompt／getOverview／buildStepPlan 的輸出。
// 角色說明只存 sha256、長度與去重後的全文索引（相同全文只存一份）；UPDATE_GOLDEN=1 才會重寫 tests/golden/prompts.json。
import test from "node:test";
import crypto from "node:crypto";
import { checkGolden } from "./helpers/golden.mjs";
import { getRolePrompt } from "../dist/prompts.js";
import { getOverview, OVERVIEW_SECTIONS } from "../dist/overview-prompts.js";
import { buildStepPlan } from "../dist/step-plan.js";

const sha = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");

const ROLES = ["analyst", "spec-writer", "engineer", "verifier", "tester"];
const SD_MODES = ["(unset)", null, "external", "self", "self-generated", "unregistered"];
const SPEC_ORDERS = ["(unset)", null, "spec_first", "code_first"];
const TEST_MODES = ["(unset)", null, "modern", "legacy_junit4", "none"];

function buildSnapshot() {
  const bodies = {};
  const rolePrompts = {};
  const overview = {};
  for (const role of ROLES) {
    for (const sdMode of SD_MODES) {
      for (const specOrder of SPEC_ORDERS) {
        for (const testMode of TEST_MODES) {
          const options = {};
          if (sdMode !== "(unset)") options.sdMode = sdMode;
          if (specOrder !== "(unset)") options.specOrder = specOrder;
          if (testMode !== "(unset)") options.testCapabilityMode = testMode;
          const text = getRolePrompt(role, options);
          const hash = sha(text);
          bodies[hash] = text;
          rolePrompts[`${role}|sdMode:${sdMode}|specOrder:${specOrder}|test:${testMode}`] = { sha256: hash, length: text.length };
        }
      }
    }
  }
  for (const section of [undefined, ...OVERVIEW_SECTIONS]) {
    const text = getOverview(section);
    overview[`section:${section ?? "(default)"}`] = { sha256: sha(text), length: text.length, text };
  }
  const stepPlans = {};
  stepPlans["null"] = buildStepPlan(null);
  for (const sdMode of ["external", "self", "self-generated", "unregistered"]) {
    for (const specOrder of ["(unset)", null, "spec_first", "code_first"]) {
      const arg = specOrder === "(unset)" ? { sdMode } : { sdMode, specOrder };
      stepPlans[`sdMode:${sdMode}|specOrder:${specOrder}`] = buildStepPlan(arg);
    }
  }
  return { rolePrompts, overview, stepPlans, bodies };
}

// 全文索引拆成獨立快照檔，主檔只留雜湊與長度，方便檢視差異。
test("golden: getRolePrompt／getOverview／buildStepPlan 與快照逐字相同", () => {
  const { rolePrompts, overview, stepPlans, bodies } = buildSnapshot();
  const flat = {};
  for (const [k, v] of Object.entries(rolePrompts)) flat[`role|${k}`] = v;
  for (const [k, v] of Object.entries(overview)) flat[`overview|${k}`] = v;
  for (const [k, v] of Object.entries(stepPlans)) flat[`stepPlan|${k}`] = v;
  for (const [h, text] of Object.entries(bodies)) flat[`body|${h}`] = text;
  checkGolden("prompts.json", flat);
});
