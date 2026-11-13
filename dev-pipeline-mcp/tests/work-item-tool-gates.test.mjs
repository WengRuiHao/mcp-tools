// work_item confirm／verdict：human／agent 授權、final-acceptance 與 manual 關卡不可代確認、硬停點、倒回。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { writeExistingUtil, setupEnv, fulfil, runUntil, CLEAN_REVIEW, VALID_SD } from "./helpers/work-item-env.mjs";

const env = await setupEnv("wi-gates-");
after(() => env.cleanup());
const confirm = (id, gateId, by, extra = {}) => env.call({ action: "confirm", workItemId: id, gateId, decision: "confirmed", by, ...extra });
const verdict = (id, gateId, extra) => env.call({ action: "verdict", workItemId: id, gateId, ...extra });
const gateDecision = async (id, gateId) => (await env.store.readStatus(id)).work_item_progress?.gates[gateId];

test("manual 關卡（mockup-confirm）agent 代確認被拒、不寫入；human 可確認", async () => {
  const { id, dir } = await env.create({ styleSource: "new-guided" });
  await runUntil(env, id, dir, "mockup-confirm");
  const r = await confirm(id, "mockup-confirm", "agent", { review: CLEAN_REVIEW });
  assert.equal(r.isError, true);
  assert.equal(await gateDecision(id, "mockup-confirm"), undefined);
  const h = await confirm(id, "mockup-confirm", "human", { reason: "使用者說確認" });
  assert.equal(h.isError, false);
  assert.equal((await gateDecision(id, "mockup-confirm")).by, "human");
});

test("auto 關卡：agent 需完整審查申報；申報不完整或任一硬停點申報都被拒", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "sa-confirm");
  assert.equal((await confirm(id, "sa-confirm", "agent")).isError, true);
  assert.equal((await confirm(id, "sa-confirm", "agent", { review: { breaksExisting: false } })).isError, true);
  for (const k of ["breaksExisting", "reviewerUncertain", "scopeSplit"]) {
    const r = await confirm(id, "sa-confirm", "agent", { review: { ...CLEAN_REVIEW, [k]: true, reasons: { [k]: "審查員申報的測試理由" } } });
    assert.equal(r.isError, true, k);
    assert.ok(r.json.hardStop || r.json.reason, k);
    assert.notEqual(r.json.reason, "review-reason-missing", k);
  }
  assert.equal(await gateDecision(id, "sa-confirm"), undefined);
  const ok = await confirm(id, "sa-confirm", "agent", { review: CLEAN_REVIEW, reason: "審查通過" });
  assert.equal(ok.isError, false);
  const rec = await gateDecision(id, "sa-confirm");
  assert.equal(rec.by, "agent");
  assert.match(rec.reason, /審查通過.*breaksExisting=false/);
});

test("destructive-db：SQL 含 DROP 時 agent 無法確認 db-flow-confirm，human 可以", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "db-designer");
  await fulfil(dir, "db-designer", { sql: "DROP TABLE users; CREATE TABLE t (id INT PRIMARY KEY);" });
  assert.equal((await env.call({ action: "done", workItemId: id, roleId: "db-designer" })).isError, false);
  await fulfil(dir, "flow-analyst");
  await env.call({ action: "done", workItemId: id, roleId: "flow-analyst" });
  const r = await confirm(id, "db-flow-confirm", "agent", { review: CLEAN_REVIEW });
  assert.equal(r.isError, true);
  assert.equal(r.json.hardStop, "destructive-db");
  assert.equal((await confirm(id, "db-flow-confirm", "human", { reason: "使用者核准破壞性 SQL" })).isError, false);
});

test("sensitive-data：關卡相關產出含密碼時 agent 被拒", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "sd-analyst");
  await writeExistingUtil(env.projectDir);
  await writeFile(path.join(dir, "03-sd.md"), `${VALID_SD}\n連線 password=hunter2secret\n`);
  assert.equal((await env.call({ action: "done", workItemId: id, roleId: "sd-analyst" })).isError, false);
  const r = await confirm(id, "sd-confirm", "agent", { review: CLEAN_REVIEW });
  assert.equal(r.isError, true);
  assert.equal(r.json.hardStop, "sensitive-data");
});

test("final-acceptance：agent 任何路徑（含乾淨申報、打回）都不可能成功", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "final-acceptance-none");
  const gate = "final-acceptance";
  for (const review of [undefined, CLEAN_REVIEW, { ...CLEAN_REVIEW, scopeSplit: true }]) {
    const r = await confirm(id, gate, "agent", review ? { review } : {});
    assert.equal(r.isError, true);
  }
  const rej = await env.call({ action: "confirm", workItemId: id, gateId: gate, decision: "rejected", by: "agent", review: CLEAN_REVIEW });
  assert.equal(rej.isError, true);
  assert.equal(await gateDecision(id, gate), undefined);
  const ok = await confirm(id, gate, "human", { reason: "使用者驗收" });
  assert.equal(ok.isError, false);
  assert.equal((await env.call({ action: "get", workItemId: id })).json.complete, true);
});

test("verdict：agent 結果必須與報告一致；pass 清零連續失敗；fail 倒回並計數", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "spec-verifier");
  await fulfil(dir, "spec-verifier", { verdictText: "FAIL\nrootCause: sd" });
  await env.call({ action: "done", workItemId: id, roleId: "spec-verifier" });
  const lie = await verdict(id, "spec-check-verdict", { result: "pass", by: "agent", review: CLEAN_REVIEW });
  assert.equal(lie.isError, true);
  assert.match(lie.json.message, /不一致/);
  assert.equal((await verdict(id, "spec-check-verdict", { result: "fail", by: "agent", review: CLEAN_REVIEW, reason: "不一致" })).isError, true);
  const f = await verdict(id, "spec-check-verdict", { result: "fail", rootCause: "sd", by: "agent", review: CLEAN_REVIEW, reason: "SD 缺欄位" });
  assert.equal(f.isError, false);
  assert.equal(f.json.routedTo, "sd-analyst");
  assert.equal(f.json.consecutiveFailCount, 1);
  assert.ok(f.json.rewoundRoles.includes("spec-verifier"));
  assert.equal(f.json.nextRoles[0].roleId, "sd-analyst");
});

test("verdict：連續失敗 3 次後 agent 不可再判，只能 human；不接受非判定關卡", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "spec-verifier");
  for (let i = 0; i < 3; i++) {
    await fulfil(dir, "sd-analyst");
    if (i > 0) assert.equal((await env.call({ action: "done", workItemId: id, roleId: "sd-analyst" })).isError, false);
    await fulfil(dir, "spec-verifier", { verdictText: "FAIL\nrootCause: sd" });
    if (i > 0) await confirm(id, "sd-confirm", "agent", { review: CLEAN_REVIEW });
    assert.equal((await env.call({ action: "done", workItemId: id, roleId: "spec-verifier" })).isError, false, `第 ${i} 輪交件`);
    const f = await verdict(id, "spec-check-verdict", { result: "fail", rootCause: "sd", by: i < 2 ? "agent" : "human", reason: "第" + i + "輪不通過", ...(i < 2 ? { review: CLEAN_REVIEW } : {}) });
    assert.equal(f.isError, false, `第 ${i} 輪判定`);
    if (i === 2) assert.equal(f.json.requireManual, true);
  }
  assert.equal((await env.store.readStatus(id)).consecutive_fail_count, 3);
  await fulfil(dir, "sd-analyst");
  assert.equal((await env.call({ action: "done", workItemId: id, roleId: "sd-analyst" })).isError, false);
  const blocked = await confirm(id, "sd-confirm", "agent", { review: CLEAN_REVIEW });
  assert.equal(blocked.isError, true);
  assert.equal(blocked.json.hardStop, "consecutive-fail-3");
  assert.equal((await confirm(id, "sd-confirm", "human", { reason: "使用者核准" })).isError, false);
  assert.equal((await verdict(id, "sd-confirm", { result: "pass", by: "human" })).isError, true);
});

test("confirm：判定關卡要改用 verdict；rejected 倒回角色；content 關卡由程式檢查、confirm 直接拒絕", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "spec-check-verdict");
  assert.match((await confirm(id, "spec-check-verdict", "human")).json.message, /verdict/);
  await runUntil(env, id, dir, "spec-verifier");
  const rej = await env.call({ action: "confirm", workItemId: id, gateId: "sa-confirm", decision: "rejected", by: "human", reason: "打回" });
  assert.equal(rej.isError, false);
  assert.ok(rej.json.rewoundRoles.includes("sa-analyst") && rej.json.rewoundRoles.includes("sd-analyst"));
  const { id: id2, dir: dir2 } = await env.create();
  await runUntil(env, id2, dir2, "implementation-content");
  const c = await confirm(id2, "implementation-content", "human", { reason: "使用者說確認" });
  assert.equal(c.isError, true);
  assert.match(c.json.message, /由程式檢查，不需確認/);
  assert.equal((await gateDecision(id2, "implementation-content")).by, "agent");
  const r2 = await env.call({ action: "confirm", workItemId: id2, gateId: "nope", decision: "confirmed", by: "human" });
  assert.equal(r2.isError, true);
});
