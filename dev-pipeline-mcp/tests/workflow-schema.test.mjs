// workflow schema：合法定義通過；缺欄位、未知欄位、錯誤列舉、專案覆寫越權欄位都被拒絕。
import test from "node:test";
import assert from "node:assert/strict";
import { parseWorkflowDefinition, parseProjectFlowOverride, HARD_STOP_IDS } from "../dist/workflow/schema.js";
import { buildAsanaTicketWorkflow } from "../dist/workflow/builtin/asana-ticket.js";

test("內建 asana-ticket 通過 schema", () => {
  assert.equal(parseWorkflowDefinition(buildAsanaTicketWorkflow()).ok, true);
});

test("6 個硬停點 id 固定", () => {
  assert.deepEqual([...HARD_STOP_IDS], ["destructive-db", "breaks-existing", "consecutive-fail-3", "reviewer-uncertain", "scope-split", "sensitive-data"]);
});

test("schemaVersion 不是 1 被拒絕", () => {
  const r = parseWorkflowDefinition({ ...buildAsanaTicketWorkflow(), schemaVersion: 2 });
  assert.equal(r.ok, false);
});

test("未知欄位、非法 granularity、非法硬停點、非法 confirmMode 被拒絕", () => {
  const base = buildAsanaTicketWorkflow();
  assert.equal(parseWorkflowDefinition({ ...base, extra: 1 }).ok, false);
  assert.equal(parseWorkflowDefinition({ ...base, granularity: "epic" }).ok, false);
  assert.equal(parseWorkflowDefinition({ ...base, hardStops: ["nope"] }).ok, false);
  const bad = { ...base, gates: [{ id: "g", after: "analyst", type: "confirmation", confirmMode: "maybe" }] };
  assert.equal(parseWorkflowDefinition(bad).ok, false);
});

test("缺必要欄位回傳帶路徑的錯誤", () => {
  const { roles, ...rest } = buildAsanaTicketWorkflow();
  const r = parseWorkflowDefinition(rest);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.startsWith("roles")));
});

test("非物件輸入被拒絕", () => {
  assert.equal(parseWorkflowDefinition(null).ok, false);
  assert.equal(parseWorkflowDefinition("x").ok, false);
});

test("專案覆寫：只允許 confirmMode／optional／checks／roleNotes", () => {
  const ok = parseProjectFlowOverride({
    schemaVersion: 1,
    confirmDefault: "auto",
    gates: { "sd-confirm-first": { confirmMode: "auto" }, "analysis-content": { checks: [{ id: "c", description: "d" }] } },
    roles: { tester: { optional: true, roleNotes: "x" } },
  });
  assert.equal(ok.ok, true);
});

test("專案覆寫：locked、hardStops、dependsOn 等越權欄位被 schema 拒絕", () => {
  for (const o of [
    { schemaVersion: 1, hardStops: [] },
    { schemaVersion: 1, gates: { g: { locked: false } } },
    { schemaVersion: 1, roles: { r: { dependsOn: [] } } },
    { schemaVersion: 1, gates: { g: { confirmMode: "bogus" } } },
  ]) {
    assert.equal(parseProjectFlowOverride(o).ok, false, JSON.stringify(o));
  }
});
