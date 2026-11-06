// stepPlan：依專案 sdMode／specOrder 算出該走的步驟；分析師角色說明只留適用的規格取得做法。
import test from "node:test";
import assert from "node:assert/strict";
import { buildStepPlan } from "../dist/step-plan.js";
import { getRolePrompt } from "../dist/prompts.js";
import { getOverview } from "../dist/overview-prompts.js";

const BASE = ["3.1", "3.2", "3.3", "3.5", "3.7", "3.8"];

test("stepPlan: 沒有 sasd 設定回 null", () => {
  assert.equal(buildStepPlan(null), null);
});

test("stepPlan: external／self／unregistered 不含規格撰寫者步驟", () => {
  for (const sdMode of ["external", "self", "unregistered"]) {
    const plan = buildStepPlan({ sdMode, specOrder: "spec_first" });
    assert.deepEqual(plan.steps, BASE, sdMode);
    assert.equal(plan.specOrder, null, "非 self-generated 一律忽略 specOrder");
    assert.equal(plan.specWriterStep, undefined);
  }
  assert.ok(buildStepPlan({ sdMode: "external" }).notes[0].includes("不可建議修改 SD"));
});

test("stepPlan: self-generated spec_first 只含 3.4，且說明只有 3.4", () => {
  const plan = buildStepPlan({ sdMode: "self-generated", specOrder: "spec_first" });
  assert.deepEqual(plan.steps, ["3.1", "3.2", "3.3", "3.4", "3.5", "3.7", "3.8"]);
  assert.ok(plan.specWriterStep.startsWith("3.4") && !plan.specWriterStep.includes("3.6"));
});

test("stepPlan: self-generated code_first 只含 3.6，且說明只有 3.6", () => {
  const plan = buildStepPlan({ sdMode: "self-generated", specOrder: "code_first" });
  assert.deepEqual(plan.steps, ["3.1", "3.2", "3.3", "3.5", "3.6", "3.7", "3.8"]);
  assert.ok(plan.specWriterStep.startsWith("3.6") && !plan.specWriterStep.includes("3.4"));
});

test("stepPlan: self-generated 缺 specOrder 時不猜，兩段都列", () => {
  const plan = buildStepPlan({ sdMode: "self-generated", specOrder: null });
  assert.equal(plan.specOrder, null);
  assert.ok(plan.specWriterStep.includes("3.4") && plan.specWriterStep.includes("3.6"));
});

test("analyst prompt: 依 sdMode 只留適用的規格取得做法；未知時全留", () => {
  const external = getRolePrompt("analyst", { sdMode: "external" });
  assert.ok(external.includes("SD 是別人的") && !external.includes("唯一要逐票問") && !external.includes("read_project_sd_doc"));
  const self = getRolePrompt("analyst", { sdMode: "self" });
  assert.ok(self.includes("SD 是自己團隊產的") && !self.includes("SD 是別人的"));
  const sg = getRolePrompt("analyst", { sdMode: "self-generated" });
  assert.ok(sg.includes("read_project_sd_doc") && !sg.includes("一律以 SVN 遠端為準"));
  const un = getRolePrompt("analyst", { sdMode: "unregistered" });
  assert.ok(un.includes("唯一要逐票問") && !un.includes("read_project_sd_doc"));
  const all = getRolePrompt("analyst");
  for (const needle of ["SD 是別人的", "SD 是自己團隊產的", "read_project_sd_doc", "唯一要逐票問"]) assert.ok(all.includes(needle), needle);
  for (const text of [external, self, sg, un, all]) assert.ok(text.includes("record_sasd_check"));
});

test("overview core: 3.4／3.6 只留指向 stepPlan 的指引，不再內嵌規格撰寫細節", () => {
  const core = getOverview("core");
  assert.ok(core.includes("stepPlan"));
  assert.ok(!core.includes("規格先定案才能寫程式碼"));
  assert.ok(!core.includes("依剛寫完的程式碼反推補規格"));
});
