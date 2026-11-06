// resolveConfirmMode（inherit／locked／硬停點）與 mergeProjectOverride（拒絕越權）。
import test from "node:test";
import assert from "node:assert/strict";
import { resolveConfirmMode, mergeProjectOverride, resolveWorkflow } from "../dist/workflow/resolve.js";
import { HARD_STOP_IDS } from "../dist/workflow/schema.js";
import { buildAsanaTicketWorkflow } from "../dist/workflow/builtin/asana-ticket.js";

const base = () => buildAsanaTicketWorkflow();
const withAuto = () => ({ ...base(), confirmDefault: "auto" });

test("inherit／未設定跟隨 workflow 預設", () => {
  assert.deepEqual(resolveConfirmMode(base(), "sd-confirm-first"), { mode: "manual", reason: "inherit-default" });
  assert.deepEqual(resolveConfirmMode(withAuto(), "sd-confirm-first"), { mode: "auto", reason: "inherit-default" });
  assert.equal(resolveConfirmMode(withAuto(), "verdict").mode, "auto");
});

test("關卡明確設定優先於預設", () => {
  const d = withAuto();
  d.gates = d.gates.map((g) => (g.id === "sd-confirm-first" ? { ...g, confirmMode: "manual" } : g));
  assert.deepEqual(resolveConfirmMode(d, "sd-confirm-first"), { mode: "manual", reason: "gate" });
});

test("locked 關卡永遠 manual，即使預設是 auto", () => {
  assert.deepEqual(resolveConfirmMode(withAuto(), "final-acceptance"), { mode: "manual", reason: "locked" });
});

test("6 個硬停點任一觸發，auto 也被強制 manual", () => {
  for (const h of HARD_STOP_IDS) {
    const r = resolveConfirmMode(withAuto(), "sd-confirm-first", [h]);
    assert.deepEqual(r, { mode: "manual", reason: "hard-stop", hardStop: h });
  }
});

test("即使 workflow 沒宣告該硬停點，被觸發仍強制 manual", () => {
  const d = { ...withAuto(), hardStops: [] };
  assert.equal(resolveConfirmMode(d, "verdict", ["destructive-db"]).mode, "manual");
});

test("不存在的關卡丟錯", () => {
  assert.throws(() => resolveConfirmMode(base(), "ghost"));
});

test("合法覆寫：confirmMode／optional／checks／roleNotes 生效且不改原物件", () => {
  const d = base();
  const snapshot = JSON.stringify(d);
  const r = mergeProjectOverride(d, {
    schemaVersion: 1,
    confirmDefault: "auto",
    gates: { "sd-confirm-first": { confirmMode: "manual" }, "implementation-content": { checks: [{ id: "c1", description: "查重" }] } },
    roles: { tester: { optional: true, roleNotes: "note" } },
  });
  assert.equal(r.ok, true);
  assert.equal(r.workflow.confirmDefault, "auto");
  assert.equal(r.workflow.gates.find((g) => g.id === "implementation-content").checks[0].id, "c1");
  const tester = r.workflow.roles.find((r2) => r2.id === "tester");
  assert.deepEqual([tester.optional, tester.roleNotes], [true, "note"]);
  assert.equal(JSON.stringify(d), snapshot);
});

test("locked 關卡的 confirmMode 被覆寫會被拒（含設成 manual）", () => {
  for (const mode of ["auto", "manual", "inherit"]) {
    const r = mergeProjectOverride(base(), { schemaVersion: 1, gates: { "final-acceptance": { confirmMode: mode } } });
    assert.equal(r.ok, false, mode);
    assert.match(r.errors[0], /locked/);
  }
});

test("非 content 關卡覆寫 checks、引用不存在的關卡或角色被拒", () => {
  const checks = [{ id: "c", description: "d" }];
  assert.equal(mergeProjectOverride(base(), { schemaVersion: 1, gates: { verdict: { checks } } }).ok, false);
  assert.equal(mergeProjectOverride(base(), { schemaVersion: 1, gates: { ghost: { confirmMode: "auto" } } }).ok, false);
  assert.equal(mergeProjectOverride(base(), { schemaVersion: 1, roles: { ghost: { optional: true } } }).ok, false);
});

test("resolveWorkflow：略過角色會從 dependsOn 移除，關卡只留有啟用角色的", () => {
  const r = resolveWorkflow(base(), { sdMode: "external" });
  assert.deepEqual(r.roles.map((x) => x.id), ["analyst", "engineer", "verifier", "tester"]);
  assert.deepEqual(r.roles.find((x) => x.id === "engineer").dependsOn, ["analyst"]);
  assert.ok(!r.gates.some((g) => g.id.startsWith("sd-confirm")));
  assert.equal(r.gates.find((g) => g.id === "final-acceptance").effectiveConfirm.mode, "manual");
});
