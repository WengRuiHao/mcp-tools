// 內建 spec-first：規格驗證師位置與依賴、FAIL 退回目標、locked 驗收、optional 角色可略過。
import test from "node:test";
import assert from "node:assert/strict";
import { buildSpecFirstWorkflow, SPEC_CHECK_ROUTES } from "../dist/workflow/builtin/spec-first.js";
import { parseWorkflowDefinition } from "../dist/workflow/schema.js";
import { validateWorkflow } from "../dist/workflow/validate.js";
import { resolveWorkflow, mergeProjectOverride, resolveConfirmMode } from "../dist/workflow/resolve.js";
import { decideGate } from "../dist/workflow/enforce.js";
import { KNOWN_WHEN_KEYS } from "../dist/workflow/validate.js";
import { buildAsanaTicketWorkflow } from "../dist/workflow/builtin/asana-ticket.js";

const ids = (rs) => rs.map((r) => r.id);
const ALL_SCOPE = { baseline: "brownfield", hasFrontend: "true", hasBackend: "true", hasDb: "true" };
const CLEAN = { consecutiveFailCount: 0, reviewerDeclaration: { breaksExisting: false, reviewerUncertain: false, scopeSplit: false } };

test("通過 schema 與語意驗證", () => {
  const d = buildSpecFirstWorkflow();
  assert.equal(parseWorkflowDefinition(d).ok, true);
  assert.deepEqual(validateWorkflow(d), []);
});

test("spec-verifier 在 SD 之後、前後端之前，前後端依賴它", () => {
  const d = buildSpecFirstWorkflow();
  const order = ids(resolveWorkflow(d, ALL_SCOPE).roles);
  const at = (id) => order.indexOf(id);
  assert.ok(at("sd-analyst") < at("spec-verifier"));
  for (const e of ["frontend-engineer", "backend-engineer"]) {
    assert.ok(at("spec-verifier") < at(e), e);
    assert.ok(d.roles.find((r) => r.id === e).dependsOn.includes("spec-verifier"), e);
  }
  assert.ok(d.roles.find((r) => r.id === "spec-verifier").dependsOn.includes("sd-analyst"));
});

test("規格驗證關卡：非 locked、預設 auto，FAIL 的 rootCause 目標都是存在的角色", () => {
  const d = buildSpecFirstWorkflow();
  const g = d.gates.find((x) => x.after === "spec-verifier");
  assert.deepEqual([g.type, g.confirmMode, Boolean(g.locked)], ["verdict", "auto", false]);
  assert.deepEqual(Object.keys(g.routeOnFail).sort(), ["db", "flow", "sa", "sd"]);
  assert.equal(g.routeOnFail.flow, "flow-analyst");
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
  for (const id of ["baseline-survey", "mockup-designer", "db-designer", "frontend-engineer", "backend-engineer"]) {
    assert.equal(d.roles.find((r) => r.id === id).optional, true, id);
  }
  const green = resolveWorkflow(d, { baseline: "greenfield" });
  assert.ok(!ids(green.roles).includes("baseline-survey"));
  assert.deepEqual(green.roles.find((r) => r.id === "sa-analyst").dependsOn, ["tech-selector"]);
  assert.deepEqual(green.roles.find((r) => r.id === "tech-selector").dependsOn, [], "baseline-survey 被略過時 tech-selector 仍能啟動");
  assert.notEqual(d.roles.find((r) => r.id === "tech-selector").optional, true, "tech-selector 不是 optional");
  const m = mergeProjectOverride(d, { schemaVersion: 1, roles: { "db-designer": { optional: true } } });
  assert.equal(m.ok, true);
});

test("sa 內容關卡：mockup 截圖檢查存在，排在 sa 確認之前，且 sa 確認保留（預設 auto）", () => {
  const d = buildSpecFirstWorkflow();
  assert.deepEqual(validateWorkflow(d), []);
  const gi = (id) => d.gates.findIndex((g) => g.id === id);
  const content = d.gates[gi("sa-content-check")];
  assert.deepEqual([content.type, content.after], ["content", "sa-analyst"]);
  assert.equal(content.checks.length, 1);
  assert.match(content.checks[0].description, /mockup/);
  assert.match(content.checks[0].description, /sa-images\//);
  assert.ok(gi("sa-content-check") < gi("sa-confirm"));
  const confirm = d.gates[gi("sa-confirm")];
  assert.deepEqual([confirm.type, confirm.confirmMode, confirm.after], ["confirmation", "auto", "sa-analyst"]);
  assert.equal(d.gates.length, 12);
  assert.ok(d.artifacts.find((a) => a.id === "sa").attachments.includes("sa-images/"));
});

test("sa-analyst 與 spec-verifier 的 roleNotes 提到 mockup 截圖", () => {
  const d = buildSpecFirstWorkflow();
  const notes = (id) => d.roles.find((r) => r.id === id).roleNotes;
  assert.match(notes("sa-analyst"), /mockup[\s\S]*sa-images\//);
  assert.match(notes("sa-analyst"), /不換成實際系統畫面/);
  assert.match(notes("spec-verifier"), /mockup 截圖/);
  assert.match(notes("spec-verifier"), /前端功能與 API 對應表/);
  assert.match(notes("sa-analyst"), /sa-notes\.md/);
});

test("resolve 後 sa-content-check 仍在，stage 順序不受內容關卡影響", () => {
  const d = buildSpecFirstWorkflow();
  const r = resolveWorkflow(d, ALL_SCOPE);
  assert.ok(r.gates.some((g) => g.id === "sa-content-check"));
  assert.equal(ids(r.roles).length, 12);
});

test("sa-content-check 描述：至少一張畫面圖、所有圖片引用有效、提示狀態附圖、取自已確認 mockup，check id 不變", () => {
  const c = buildSpecFirstWorkflow().gates.find((g) => g.id === "sa-content-check").checks[0];
  assert.equal(c.id, "sa-mockup-screenshot");
  assert.match(c.description, /至少一張畫面圖且所有圖片引用有效/);
  assert.match(c.description, /sa-images\//);
  assert.match(c.description, /每個提示狀態附有效截圖/);
  assert.match(c.description, /已確認的 mockup/);
  assert.doesNotMatch(c.description, /純後端|功能標題/);
});

test("sa-notes：內部產出物（sa-notes.md、markdown），由 sa-analyst 產出", () => {
  const d = buildSpecFirstWorkflow();
  assert.deepEqual(d.artifacts.find((a) => a.id === "sa-notes"), { id: "sa-notes", file: "sa-notes.md", kind: "markdown" });
  assert.deepEqual(d.roles.find((r) => r.id === "sa-analyst").outputs, ["sa", "sa-notes"]);
});

test("mockup-designer：optional、hasFrontend==true、位於 baseline-survey 之後 sa-analyst 之前，產出 mockup", () => {
  const d = buildSpecFirstWorkflow();
  const m = d.roles.find((r) => r.id === "mockup-designer");
  assert.deepEqual([m.optional, m.when, m.dependsOn, m.outputs], [true, "hasFrontend==true", ["baseline-survey", "tech-selector"], ["mockup"]]);
  assert.ok(d.roles.find((r) => r.id === "sa-analyst").dependsOn.includes("mockup-designer"));
  assert.deepEqual(d.artifacts.find((a) => a.id === "mockup"), { id: "mockup", file: "sa-mockup/", kind: "html" });
  const order = ids(resolveWorkflow(d, ALL_SCOPE).roles);
  assert.ok(order.indexOf("baseline-survey") < order.indexOf("mockup-designer"));
  assert.ok(order.indexOf("mockup-designer") < order.indexOf("sa-analyst"));
});

test("mockup-confirm：confirmation、manual、after mockup-designer，排在 sa-content-check 之前", () => {
  const d = buildSpecFirstWorkflow();
  const g = d.gates.find((x) => x.id === "mockup-confirm");
  assert.deepEqual([g.type, g.after, g.confirmMode, Boolean(g.locked)], ["confirmation", "mockup-designer", "manual", false]);
  assert.ok(d.gates.indexOf(g) < d.gates.findIndex((x) => x.id === "sa-content-check"));
});

test("範圍條件：hasFrontend／hasBackend／hasDb 決定角色是否出現，被略過者依賴自動移除", () => {
  const d = buildSpecFirstWorkflow();
  const when = (id) => d.roles.find((r) => r.id === id).when;
  assert.equal(when("frontend-engineer"), "hasFrontend==true");
  assert.equal(when("backend-engineer"), "hasBackend==true");
  assert.equal(when("db-designer"), "hasDb==true");
  const pureBackend = resolveWorkflow(d, { baseline: "greenfield", hasFrontend: "false", hasBackend: "true", hasDb: "false" });
  const got = ids(pureBackend.roles);
  for (const gone of ["mockup-designer", "frontend-engineer", "db-designer", "baseline-survey"]) assert.ok(!got.includes(gone), gone);
  assert.deepEqual(pureBackend.roles.find((r) => r.id === "sa-analyst").dependsOn, ["tech-selector"]);
  assert.deepEqual(pureBackend.roles.find((r) => r.id === "flow-analyst").dependsOn, ["sa-analyst"]);
  assert.deepEqual(pureBackend.roles.find((r) => r.id === "verifier").dependsOn, ["backend-engineer"]);
  assert.ok(!pureBackend.gates.some((g) => g.id === "mockup-confirm"));
  const pureFrontend = ids(resolveWorkflow(d, { baseline: "greenfield", hasFrontend: "true", hasBackend: "false", hasDb: "false" }).roles);
  assert.ok(pureFrontend.includes("mockup-designer") && pureFrontend.includes("frontend-engineer") && !pureFrontend.includes("backend-engineer"));
  assert.equal(ids(resolveWorkflow(d, { baseline: "greenfield" }).roles).includes("frontend-engineer"), false);
});

test("when 使用的 key 都在白名單，新增 hasFrontend／hasBackend／hasDb", () => {
  for (const k of ["hasFrontend", "hasBackend", "hasDb"]) assert.ok(KNOWN_WHEN_KEYS.includes(k), k);
  assert.deepEqual(validateWorkflow(buildSpecFirstWorkflow(), KNOWN_WHEN_KEYS), []);
});

test("各關卡預設確認模式解析結果（resolveConfirmMode 與 decideGate）", () => {
  const d = buildSpecFirstWorkflow();
  const expected = {
    "mockup-confirm": "manual",
    "sa-confirm": "auto",
    "db-flow-confirm": "auto",
    "sd-confirm": "auto",
    "final-acceptance": "manual",
    "spec-check-verdict": "auto",
    verdict: "auto",
  };
  for (const [id, mode] of Object.entries(expected)) assert.equal(resolveConfirmMode(d, id).mode, mode, id);
  assert.equal(resolveConfirmMode(d, "mockup-confirm").reason, "gate");
  assert.equal(resolveConfirmMode(d, "final-acceptance").reason, "locked");
  for (const id of ["mockup-confirm", "sa-confirm", "db-flow-confirm", "sd-confirm"]) {
    assert.notEqual(d.gates.find((g) => g.id === id).confirmMode, "inherit", id);
  }
  for (const id of ["sa-confirm", "db-flow-confirm", "sd-confirm", "spec-check-verdict", "verdict"]) assert.equal(decideGate(d, id, null, CLEAN).mode, "auto", id);
  for (const id of ["mockup-confirm", "final-acceptance"]) assert.equal(decideGate(d, id, null, CLEAN).mode, "manual", id);
});

test("auto 關卡遇硬停點、申報不完整仍 fail-closed 為 manual", () => {
  const d = buildSpecFirstWorkflow();
  for (const id of ["db-flow-confirm", "sd-confirm"]) {
    assert.equal(resolveConfirmMode(d, id, ["destructive-db"]).mode, "manual", id);
    assert.equal(decideGate(d, id, null, { ...CLEAN, sqlArtifactText: "DROP TABLE a;" }).mode, "manual", id);
    assert.equal(decideGate(d, id, null, { ...CLEAN, consecutiveFailCount: 3 }).mode, "manual", id);
    assert.equal(decideGate(d, id, null, { consecutiveFailCount: 0 }).reason, "declaration-incomplete", id);
  }
});

test("final-acceptance（locked）在任何 signals 與 auto 預設下都不可能 auto", () => {
  const d = buildSpecFirstWorkflow();
  const forcedAuto = { ...d, confirmDefault: "auto" };
  const signalSets = [CLEAN, { consecutiveFailCount: 0 }, { consecutiveFailCount: Number.NaN }, { ...CLEAN, sensitiveDataHit: true }];
  for (const wf of [d, forcedAuto]) {
    for (const sig of signalSets) assert.equal(decideGate(wf, "final-acceptance", null, sig).mode, "manual");
  }
});

test("verdict 關卡退回目標：flow→flow-analyst 且所有目標角色存在", () => {
  const d = buildSpecFirstWorkflow();
  const roleIds = new Set(ids(d.roles));
  const verdict = d.gates.find((g) => g.id === "verdict");
  assert.deepEqual(verdict.routeOnFail, { sa: "sa-analyst", db: "db-designer", flow: "flow-analyst", sd: "sd-analyst", fe: "frontend-engineer", be: "backend-engineer" });
  for (const g of d.gates) for (const t of Object.values(g.routeOnFail ?? {})) assert.ok(roleIds.has(t), `${g.id}:${t}`);
});

test("asana-ticket builtin 不受影響（無 mockup、when key 不含範圍衍生 key）", () => {
  const a = buildAsanaTicketWorkflow();
  assert.ok(!a.roles.some((r) => r.id === "mockup-designer"));
  assert.ok(!a.roles.some((r) => /^has/.test(r.when ?? "")));
  assert.ok(!a.artifacts.some((x) => x.id === "mockup"));
});

test("tech-selector／tech-stack／tech-confirm：定義、依賴、關卡型別", () => {
  const d = buildSpecFirstWorkflow();
  assert.deepEqual(validateWorkflow(d), []);
  const t = d.roles.find((r) => r.id === "tech-selector");
  assert.deepEqual([t.dependsOn, t.outputs, t.when], [["baseline-survey"], ["tech-stack"], undefined]);
  for (const id of ["mockup-designer", "sa-analyst"]) assert.ok(d.roles.find((r) => r.id === id).dependsOn.includes("tech-selector"), id);
  for (const id of ["mockup-designer", "sa-analyst", "db-designer", "sd-analyst", "spec-verifier", "frontend-engineer", "backend-engineer", "verifier", "tester"]) {
    assert.ok(d.roles.find((r) => r.id === id).inputs.includes("tech-stack"), `${id} 輸入含 tech-stack`);
  }
  assert.deepEqual(d.artifacts.find((a) => a.id === "tech-stack"), { id: "tech-stack", file: "tech-stack.md", kind: "markdown" });
  const g = d.gates.find((x) => x.id === "tech-confirm");
  assert.deepEqual([g.type, g.after, g.confirmMode, Boolean(g.locked)], ["confirmation", "tech-selector", "manual", false]);
  const order = ids(resolveWorkflow(d, ALL_SCOPE).roles);
  assert.ok(order.indexOf("baseline-survey") < order.indexOf("tech-selector") && order.indexOf("tech-selector") < order.indexOf("mockup-designer"));
});
