// decideGate：locked／硬停點／申報 fail-closed／asana 確認類關卡／SQL 掃描。
import test from "node:test";
import assert from "node:assert/strict";
import { decideGate, isDestructiveSql } from "../dist/workflow/enforce.js";
import { HARD_STOP_IDS } from "../dist/workflow/schema.js";
import { buildAsanaTicketWorkflow } from "../dist/workflow/builtin/asana-ticket.js";
import { buildSpecFirstWorkflow } from "../dist/workflow/builtin/spec-first.js";

const auto = (d) => ({ ...d, confirmDefault: "auto" });
const okDecl = { breaksExisting: false, reviewerUncertain: false, scopeSplit: false };
const clean = () => ({ consecutiveFailCount: 0, sensitiveDataHit: false, reviewerDeclaration: { ...okDecl } });
const allHit = () => ({
  consecutiveFailCount: 9,
  sqlArtifactText: "DROP TABLE t;",
  sensitiveDataHit: true,
  reviewerDeclaration: { breaksExisting: true, reviewerUncertain: true, scopeSplit: true },
});
const workflows = () => [buildAsanaTicketWorkflow(), buildSpecFirstWorkflow()];

test("locked 關卡在各種 signals 下都不會回 auto", () => {
  const combos = [clean(), allHit(), {}, { consecutiveFailCount: 0 }, { consecutiveFailCount: 0, reviewerDeclaration: "x" }];
  for (const h of HARD_STOP_IDS) combos.push({ ...clean(), ...(h === "destructive-db" ? { sqlArtifactText: "DROP TABLE x" } : {}) });
  for (const wf of workflows()) {
    const locked = wf.gates.filter((g) => g.locked);
    assert.ok(locked.length > 0);
    for (const g of locked) for (const s of combos) assert.equal(decideGate(auto(wf), g.id, null, s).mode, "manual");
  }
  assert.equal(decideGate(auto(buildAsanaTicketWorkflow()), "final-acceptance", null, clean()).reason, "locked");
});

test("每個硬停點觸發都回 manual 且 hardStop 正確", () => {
  const wf = auto(buildSpecFirstWorkflow());
  const cases = {
    "destructive-db": { ...clean(), sqlArtifactText: "TRUNCATE TABLE a" },
    "breaks-existing": { ...clean(), reviewerDeclaration: { ...okDecl, breaksExisting: true } },
    "consecutive-fail-3": { ...clean(), consecutiveFailCount: 3 },
    "reviewer-uncertain": { ...clean(), reviewerDeclaration: { ...okDecl, reviewerUncertain: true } },
    "scope-split": { ...clean(), reviewerDeclaration: { ...okDecl, scopeSplit: true } },
    "sensitive-data": { ...clean(), sensitiveDataHit: true },
  };
  assert.deepEqual(Object.keys(cases).sort(), [...HARD_STOP_IDS].sort());
  for (const [h, s] of Object.entries(cases)) {
    assert.deepEqual(decideGate(wf, "impact-content", null, s), { mode: "manual", reason: "hard-stop", hardStop: h });
  }
});

test("consecutiveFailCount 2 不觸發、3 觸發", () => {
  const wf = auto(buildSpecFirstWorkflow());
  assert.equal(decideGate(wf, "impact-content", null, { ...clean(), consecutiveFailCount: 2 }).mode, "auto");
  assert.equal(decideGate(wf, "impact-content", null, { ...clean(), consecutiveFailCount: 3 }).hardStop, "consecutive-fail-3");
});

test("SQL 掃描：DROP／TRUNCATE／ALTER TYPE／無 where 的 DELETE 觸發", () => {
  for (const sql of ["DROP TABLE a;", "drop column x", "truncate t", "ALTER TABLE a ALTER COLUMN c TYPE text;", "delete from a;", "DELETE FROM a; SELECT 1"]) {
    assert.equal(isDestructiveSql(sql), true, sql);
  }
});

test("SQL 掃描：SELECT、有 where 的 DELETE、註解與外鍵 cascade 不觸發", () => {
  for (const sql of ["SELECT * FROM a;", "DELETE FROM a WHERE id = 1;", "-- DROP TABLE a\nSELECT 1;", "/* TRUNCATE x */ SELECT 1", "CREATE TABLE b (a int REFERENCES c ON DELETE CASCADE);", "ALTER TABLE a ADD COLUMN z int;"]) {
    assert.equal(isDestructiveSql(sql), false, sql);
  }
});

test("申報缺漏、欄位缺少或型別不對：auto 時 fail-closed 為 manual", () => {
  const wf = auto(buildSpecFirstWorkflow());
  const bad = [undefined, null, "yes", {}, { breaksExisting: false, reviewerUncertain: false }, { ...okDecl, scopeSplit: "false" }];
  for (const d of bad) {
    const r = decideGate(wf, "impact-content", null, { consecutiveFailCount: 0, reviewerDeclaration: d });
    assert.deepEqual(r, { mode: "manual", reason: "declaration-incomplete" });
  }
});

test("asana-ticket 確認類關卡不可 auto（即使預設與關卡都設 auto）", () => {
  const wf = auto(buildAsanaTicketWorkflow());
  wf.gates = wf.gates.map((g) => (g.id === "sd-confirm-first" ? { ...g, confirmMode: "auto" } : g));
  for (const id of ["sd-confirm-first", "sd-confirm-reverse"]) {
    assert.deepEqual(decideGate(wf, id, null, clean()), { mode: "manual", reason: "asana-confirmation" });
  }
  assert.equal(decideGate(wf, "analysis-content", null, clean()).mode, "auto");
});

test("spec-first 的確認類關卡在 auto 預設且乾淨時可回 auto", () => {
  assert.equal(decideGate(auto(buildSpecFirstWorkflow()), "sd-confirm", null, clean()).mode, "auto");
});

test("auto 預設、無硬停點、申報完整：非 locked 內容／判定關卡回 auto", () => {
  const wf = auto(buildAsanaTicketWorkflow());
  assert.deepEqual(decideGate(wf, "implementation-content", null, clean()), { mode: "auto", reason: "inherit-default" });
  assert.equal(decideGate(wf, "verdict", null, clean()).mode, "auto");
});

test("預設 manual 時維持 manual；gate 不存在丟中文錯誤", () => {
  assert.equal(decideGate(buildAsanaTicketWorkflow(), "verdict", null, clean()).mode, "manual");
  assert.throws(() => decideGate(buildAsanaTicketWorkflow(), "nope", null, clean()), /找不到關卡：nope/);
});

test("不改傳入物件", () => {
  const wf = auto(buildAsanaTicketWorkflow());
  const s = allHit();
  const before = JSON.stringify([wf, s]);
  decideGate(wf, "verdict", null, s);
  decideGate(wf, "final-acceptance", null, s);
  assert.equal(JSON.stringify([wf, s]), before);
});
