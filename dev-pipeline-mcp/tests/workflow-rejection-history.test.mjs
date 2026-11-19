// 退回歷程：confirm rejected 與 verdict fail 追加 rejections，倒回與重做不洗掉；摘要列出每次退回與次數；舊資料相容。
import test from "node:test";
import assert from "node:assert/strict";
import { fakeStatus } from "./helpers/support.mjs";
import { applyRoleDone, applyGateDecision, applyVerdictFail } from "../dist/workflow/spec-first-engine.js";
import { buildFinalSummary } from "../dist/workflow/final-summary.js";

const mk = () => fakeStatus({ workflow_id: "spec-first", baseline: "greenfield", scope: "both", has_db: true });
const must = (r) => {
  assert.equal(r.ok, true, r.error);
  return r.status;
};
const saRound = (s, decision, by, reason) => {
  s = must(applyRoleDone(s, "sa-analyst"));
  s = must(applyGateDecision(s, "sa-content-check", { decision: "passed", by: "agent" }));
  return must(applyGateDecision(s, "sa-confirm", { decision, by, ...(reason ? { reason } : {}) }));
};

test("confirm rejected 追加歷程，重做後通過仍保留；同關卡打回兩次共兩筆", () => {
  let s = saRound(mk(), "rejected", "human", "缺流程圖");
  s = saRound(s, "rejected", "agent", "欄位不齊");
  s = saRound(s, "confirmed", "agent");
  const rej = s.work_item_progress.rejections;
  assert.equal(rej.length, 2);
  assert.deepEqual(rej.map((r) => [r.gate, r.by, r.reason]), [["sa-confirm", "human", "缺流程圖"], ["sa-confirm", "agent", "欄位不齊"]]);
  assert.ok(rej[0].at);
});

test("confirmed 不追加歷程", () => {
  const s = saRound(mk(), "confirmed", "agent");
  assert.equal(s.work_item_progress.rejections, undefined);
});

test("verdict FAIL 追加歷程（含 rootCause、by、reason）", () => {
  let s = mk();
  const ids = ["sa-analyst", "db-designer", "sd-analyst", "spec-verifier", "frontend-engineer", "backend-engineer", "verifier"];
  const after = { "sa-analyst": [["sa-content-check", "passed"], ["sa-confirm", "confirmed"]], "db-designer": [["db-flow-confirm", "confirmed"]], "sd-analyst": [["sd-confirm", "confirmed"]], "spec-verifier": [["spec-check-verdict", "passed"]], "backend-engineer": [["implementation-content", "passed"]] };
  for (const id of ids) {
    s = must(applyRoleDone(s, id));
    for (const [g, d] of after[id] ?? []) s = must(applyGateDecision(s, g, { decision: d, by: "agent" }));
  }
  const r = applyVerdictFail(s, "verdict", "sd", { reason: "介面不符" });
  assert.equal(r.ok, true, r.error);
  const rej = r.status.work_item_progress.rejections;
  assert.equal(rej.length, 1);
  assert.deepEqual([rej[0].gate, rej[0].rootCause, rej[0].by, rej[0].reason], ["verdict", "sd", "agent", "介面不符"]);
});

const summaryInput = (progress, gates) => ({
  workItemId: "w", title: "t", requirement: "r", baseline: "greenfield", scope: "both", hasDb: true, createdAt: undefined,
  gates, artifacts: [], consecutiveFailCount: 0, dupReport: undefined, files: [], progress,
});
const GATES = [{ id: "sa-confirm", after: "sa-analyst", type: "confirmation" }, { id: "sd-confirm", after: "sd-analyst", type: "confirmation" }];

test("摘要：有歷程時列出每次退回與次數（含已被通過取代的）", () => {
  const t = buildFinalSummary(summaryInput({
    roles: {}, gates: { "sa-confirm": { decision: "confirmed", by: "agent", at: "2026-01-01T01:00:00.000Z" } },
    rejections: [
      { gate: "sa-confirm", by: "human", at: "2026-01-01T00:10:00.000Z", reason: "缺流程圖" },
      { gate: "sd-confirm", by: "agent", at: "2026-01-01T00:20:00.000Z", reason: "介面不齊" },
      { gate: "sa-confirm", by: "agent", at: "2026-01-01T00:30:00.000Z" },
    ],
  }, GATES));
  assert.match(t, /完整歷程.*共 3 次（SA 確認（sa-confirm） 2 次、SD 確認（sd-confirm） 1 次）/);
  assert.match(t, /1\. SA 確認（sa-confirm）：退回（使用者本人、.*使用者原話：缺流程圖/);
  assert.match(t, /2\. SD 確認（sd-confirm）：退回（AI／程式、.*理由：介面不齊/);
  assert.match(t, /3\. SA 確認（sa-confirm）：退回/);
});

test("舊工作項目沒有 rejections：沿用只看最後決定的寫法，不報錯", () => {
  const t = buildFinalSummary(summaryInput({ roles: {}, gates: {} }, GATES));
  assert.match(t, /沒有完整歷程.*：無紀錄/);
});