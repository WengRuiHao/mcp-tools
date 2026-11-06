// getStageOrder：asana-ticket 與 STAGE_ORDER 一致、其他 workflow 依拓撲順序。
import test from "node:test";
import assert from "node:assert/strict";
import { STAGE_ORDER } from "../dist/pipeline-store.js";
import { getStageOrder, getBuiltinWorkflow } from "../dist/workflow/stage-order.js";

test("沒有 workflowId 或 asana-ticket → 與 STAGE_ORDER 相同", () => {
  assert.deepEqual(getStageOrder(), STAGE_ORDER);
  assert.deepEqual(getStageOrder(null), STAGE_ORDER);
  assert.deepEqual(getStageOrder("asana-ticket"), STAGE_ORDER);
});

test("回傳複本，改動不影響原陣列與下次結果", () => {
  const a = getStageOrder("asana-ticket");
  assert.notEqual(a, STAGE_ORDER);
  const before = [...STAGE_ORDER];
  a.push("x");
  a.length = 0;
  assert.deepEqual(STAGE_ORDER, before);
  assert.deepEqual(getStageOrder(), before);
});

test("spec-first 順序：new 開頭、spec-verifier 在 sd-analyst 後且在前後端前、tester 最後", () => {
  const o = getStageOrder("spec-first");
  const i = (id) => o.indexOf(id);
  assert.equal(o[0], "new");
  assert.ok(i("sd-analyst") >= 0 && i("spec-verifier") > i("sd-analyst"));
  assert.ok(i("spec-verifier") < i("frontend-engineer"));
  assert.ok(i("spec-verifier") < i("backend-engineer"));
  assert.ok(i("frontend-engineer") < i("backend-engineer"), "平行角色依定義順序");
  assert.equal(o[o.length - 1], "tester");
  assert.ok(i("baseline-survey") > 0, "optional 角色保留");
  assert.equal(o.length, 11);
});

test("不含重複", () => {
  for (const id of ["asana-ticket", "spec-first"]) {
    const o = getStageOrder(id);
    assert.equal(new Set(o).size, o.length);
  }
});

test("未知 workflow 無定義時報繁體中文錯誤；提供定義則可用", () => {
  assert.throws(() => getStageOrder("nope"), /找不到 workflow「nope」/);
  assert.equal(getBuiltinWorkflow("nope"), undefined);
  const def = getBuiltinWorkflow("spec-first");
  assert.deepEqual(getStageOrder("custom", def), getStageOrder("spec-first"));
});

test("角色依賴循環時報錯", () => {
  const def = getBuiltinWorkflow("spec-first");
  const bad = { ...def, roles: [{ ...def.roles[0], dependsOn: ["tester"] }, ...def.roles.slice(1)] };
  assert.throws(() => getStageOrder("spec-first", bad), /循環/);
});
