// 內建 spec-first：規格驗證師位置與依賴、FAIL 退回目標、locked 驗收、optional 角色可略過。
import test from "node:test";
import assert from "node:assert/strict";
import { buildSpecFirstWorkflow, SPEC_CHECK_ROUTES } from "../dist/workflow/builtin/spec-first.js";
import { parseWorkflowDefinition } from "../dist/workflow/schema.js";
import { validateWorkflow } from "../dist/workflow/validate.js";
import { resolveWorkflow, mergeProjectOverride } from "../dist/workflow/resolve.js";

const ids = (rs) => rs.map((r) => r.id);

test("通過 schema 與語意驗證", () => {
  const d = buildSpecFirstWorkflow();
  assert.equal(parseWorkflowDefinition(d).ok, true);
  assert.deepEqual(validateWorkflow(d), []);
});

test("spec-verifier 在 SD 之後、前後端之前，前後端依賴它", () => {
  const d = buildSpecFirstWorkflow();
  const order = ids(resolveWorkflow(d, { baseline: "brownfield" }).roles);
  const at = (id) => order.indexOf(id);
  assert.ok(at("sd-analyst") < at("spec-verifier"));
  for (const e of ["frontend-engineer", "backend-engineer"]) {
    assert.ok(at("spec-verifier") < at(e), e);
    assert.ok(d.roles.find((r) => r.id === e).dependsOn.includes("spec-verifier"), e);
  }
  assert.ok(d.roles.find((r) => r.id === "spec-verifier").dependsOn.includes("sd-analyst"));
});

test("規格驗證關卡：非 locked、inherit，FAIL 的 rootCause 目標都是存在的角色", () => {
  const d = buildSpecFirstWorkflow();
  const g = d.gates.find((x) => x.after === "spec-verifier");
  assert.deepEqual([g.type, g.confirmMode, Boolean(g.locked)], ["verdict", "inherit", false]);
  assert.deepEqual(Object.keys(g.routeOnFail).sort(), ["db", "sa", "sd"]);
  const roleIds = new Set(ids(d.roles));
  for (const t of Object.values(g.routeOnFail)) assert.ok(roleIds.has(t), t);
  assert.deepEqual(g.routeOnFail, SPEC_CHECK_ROUTES);
  assert.ok(d.artifacts.some((a) => a.id === "spec-check" && a.file === "spec-check.md"));
});

test("locked 最終驗收不可被覆寫為 auto", () => {
  const d = buildSpecFirstWorkflow();
  const fin = d.gates.find((g) => g.id === "final-acceptance");
  assert.deepEqual([fin.locked, fin.confirmMode], [true, "manual"]);
  const r = mergeProjectOverride(d, { schemaVersion: 1, gates: { "final-acceptance": { confirmMode: "auto" } } });
  assert.equal(r.ok, false);
  const bad = { ...d, gates: d.gates.map((g) => (g.id === "final-acceptance" ? { ...g, confirmMode: "auto" } : g)) };
  assert.ok(validateWorkflow(bad).some((e) => e.includes("locked")));
});

test("optional 角色可略過：greenfield 不啟用盤點，略過後依賴仍可排序", () => {
  const d = buildSpecFirstWorkflow();
  for (const id of ["baseline-survey", "db-designer", "frontend-engineer", "backend-engineer"]) {
    assert.equal(d.roles.find((r) => r.id === id).optional, true, id);
  }
  const green = resolveWorkflow(d, { baseline: "greenfield" });
  assert.ok(!ids(green.roles).includes("baseline-survey"));
  assert.deepEqual(green.roles.find((r) => r.id === "sa-analyst").dependsOn, []);
  const m = mergeProjectOverride(d, { schemaVersion: 1, roles: { "db-designer": { optional: true } } });
  assert.equal(m.ok, true);
});
