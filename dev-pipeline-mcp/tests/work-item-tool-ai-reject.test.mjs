// 步驟 I：硬性停止只封鎖 AI 核准；AI 可打回（reason 必填、記錄 actor=agent、退回上一個工作階段）；final-acceptance 只有人可以。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setupEnv, fulfil, runUntil, CLEAN_REVIEW, VALID_SD } from "./helpers/work-item-env.mjs";

const env = await setupEnv("wi-aireject-");
after(() => env.cleanup());
const confirm = (id, gateId, by, extra = {}) => env.call({ action: "confirm", workItemId: id, gateId, by, decision: extra.decision ?? "confirmed", ...extra.rest });
const record = async (id, gateId) => (await env.store.readStatus(id)).work_item_progress.gates[gateId];
const doneRoles = async (id) => (await env.store.readStatus(id)).work_item_progress.roles;

/** 各硬性停止的設定方式：回傳要附的 review（breaks-existing 等靠申報），其餘靠改檔或狀態。sa-confirm 的 agent 核准在這些條件下都會被擋。 */
const HARD_STOPS = {
  "breaks-existing": async () => ({ ...CLEAN_REVIEW, breaksExisting: true }),
  "reviewer-uncertain": async () => ({ ...CLEAN_REVIEW, reviewerUncertain: true }),
  "scope-split": async () => ({ ...CLEAN_REVIEW, scopeSplit: true }),
  "destructive-db": async (_id, dir) => { await writeFile(path.join(dir, "02-db.sql"), "DROP TABLE users;"); return CLEAN_REVIEW; },
  "sensitive-data": async (_id, dir) => { await writeFile(path.join(dir, "sa-notes.md"), "連線 password=hunter2secret\n"); return CLEAN_REVIEW; },
  "consecutive-fail-3": async (id) => { await env.store.updateStatus(id, (s) => ({ ...s, consecutive_fail_count: 3 })); return CLEAN_REVIEW; },
};

for (const [hardStop, setup] of Object.entries(HARD_STOPS)) {
  test(`${hardStop}：AI 核准被擋，AI 打回通過並退回 SA 分析師，紀錄 actor=agent 與理由`, async () => {
    const { id, dir } = await env.create();
    await runUntil(env, id, dir, "sa-confirm");
    const review = await setup(id, dir);
    const approve = await confirm(id, "sa-confirm", "agent", { rest: { review, reason: "審查通過" } });
    assert.equal(approve.isError, true);
    assert.ok(approve.json.hardStop === hardStop || hardStop === "destructive-db" || hardStop === "sensitive-data" || approve.json.reason, approve.text);
    assert.equal(await record(id, "sa-confirm"), undefined);
    const rej = await confirm(id, "sa-confirm", "agent", { decision: "rejected", rest: { review, reason: "提示狀態截圖與說明對不上" } });
    assert.equal(rej.isError, false, rej.text);
    assert.deepEqual(rej.json.rewoundRoles, ["sa-analyst"]);
    assert.equal(rej.json.nextRoles[0].roleId, "sa-analyst");
    const rec = await record(id, "sa-confirm");
    assert.equal(rec.decision, "rejected");
    assert.equal(rec.by, "agent");
    assert.match(rec.reason, /提示狀態截圖與說明對不上/);
    assert.equal((await doneRoles(id))["sa-analyst"]?.done ?? false, false);
  });
}

test("AI 打回 reason 必填且至少 2 字；不帶 review 也可打回", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "sa-confirm");
  for (const reason of [undefined, "", " ", "好"]) {
    const r = await confirm(id, "sa-confirm", "agent", { decision: "rejected", rest: reason === undefined ? {} : { reason } });
    assert.equal(r.isError, true, String(reason));
    assert.match(r.json.message, /reason/);
  }
  assert.equal(await record(id, "sa-confirm"), undefined);
  assert.equal((await confirm(id, "sa-confirm", "agent", { decision: "rejected", rest: { reason: "缺少版本管控" } })).isError, false);
});

test("連續失敗計數沿用現有行為：confirm 打回不累計；verdict fail 累計，達 3 次後 AI 仍可判 fail、不可判 pass", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "sa-confirm");
  await confirm(id, "sa-confirm", "agent", { decision: "rejected", rest: { reason: "需要修改" } });
  assert.equal((await env.store.readStatus(id)).consecutive_fail_count, 0);
  const second = await env.create();
  await runUntil(env, second.id, second.dir, "spec-check-verdict");
  const [id2, dir2] = [second.id, second.dir];
  await env.store.updateStatus(id2, (s) => ({ ...s, consecutive_fail_count: 2 }));
  await fulfil(dir2, "spec-verifier", { verdictText: "FAIL\nrootCause: sa\n" });
  const f = await env.call({ action: "verdict", workItemId: id2, gateId: "spec-check-verdict", result: "fail", rootCause: "sa", by: "agent", review: CLEAN_REVIEW });
  assert.equal(f.isError, false, f.text);
  assert.equal(f.json.consecutiveFailCount, 3);
  assert.equal(f.json.hardStop, "consecutive-fail-3");
});

test("verdict：連續失敗已達 3 次，AI 判 pass 被擋、判 fail 通過（退回對應角色）", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "spec-check-verdict");
  await env.store.updateStatus(id, (s) => ({ ...s, consecutive_fail_count: 3 }));
  const pass = await env.call({ action: "verdict", workItemId: id, gateId: "spec-check-verdict", result: "pass", by: "agent", review: CLEAN_REVIEW });
  assert.equal(pass.isError, true);
  assert.equal(pass.json.hardStop, "consecutive-fail-3");
  await fulfil(dir, "spec-verifier", { verdictText: "FAIL\nrootCause: sd\n" });
  const fail = await env.call({ action: "verdict", workItemId: id, gateId: "spec-check-verdict", result: "fail", rootCause: "sd", by: "agent", review: CLEAN_REVIEW });
  assert.equal(fail.isError, false, fail.text);
  assert.equal(fail.json.routedTo, "sd-analyst");
});

test("人工關卡（mockup-confirm）：AI 不可核准，但可打回並退回 mockup 設計師", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "mockup-confirm");
  assert.equal((await confirm(id, "mockup-confirm", "agent", { rest: { review: CLEAN_REVIEW, reason: "看起來可以" } })).isError, true);
  const r = await confirm(id, "mockup-confirm", "agent", { decision: "rejected", rest: { reason: "缺少失敗狀態的畫面" } });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(r.json.rewoundRoles, ["mockup-designer"]);
  assert.equal((await record(id, "mockup-confirm")).by, "agent");
});

test("技術確認（tech-confirm）：AI 不可核准，可打回並退回技術選型師", async () => {
  const { id, dir } = await env.create({ baseline: "greenfield", techSource: "new-select" });
  await runUntil(env, id, dir, "tech-confirm");
  await fulfil(dir, "tech-selector");
  const ok = await confirm(id, "tech-confirm", "agent", { rest: { reason: "我覺得可以" } });
  assert.equal(ok.isError, true);
  const r = await confirm(id, "tech-confirm", "agent", { decision: "rejected", rest: { reason: "技術棧與需求不合" } });
  assert.equal(r.isError, false, r.text);
  assert.equal((await record(id, "tech-confirm")).decision, "rejected");
});

test("final-acceptance：AI 核准與打回都被擋（含乾淨申報與理由）；人工核准與打回不受影響", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "none-left");
  for (const decision of ["confirmed", "rejected"]) {
    const r = await confirm(id, "final-acceptance", "agent", { decision, rest: { review: CLEAN_REVIEW, reason: "沒問題的理由" } });
    assert.equal(r.isError, true, decision);
    assert.equal(r.json.reason, "locked");
  }
  assert.equal(await record(id, "final-acceptance"), undefined);
  const rejHuman = await confirm(id, "final-acceptance", "human", { decision: "rejected", rest: { reason: "使用者要求重做" } });
  assert.equal(rejHuman.isError, false, rejHuman.text);
  assert.equal((await record(id, "final-acceptance")).by, "human");
});

test("人工確認仍需使用者原話（≥2 字）；AI 打回不影響人工路徑", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "mockup-confirm");
  assert.equal((await confirm(id, "mockup-confirm", "human", {})).isError, true);
  assert.equal((await confirm(id, "mockup-confirm", "human", { rest: { reason: "好" } })).isError, true);
  assert.equal((await confirm(id, "mockup-confirm", "human", { rest: { reason: "使用者說確認" } })).isError, false);
});
