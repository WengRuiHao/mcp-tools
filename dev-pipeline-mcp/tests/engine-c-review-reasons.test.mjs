// 問題 8、13：審查申報為 true 必須附理由；理由進關卡紀錄、00-索引.md 與 get；審查員說明書由 role_prompt roleId=reviewer 取得。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setupEnv, runUntil, CLEAN_REVIEW } from "./helpers/work-item-env.mjs";
import { withReviewNote, requireReviewReasons } from "../dist/work-item-actions/gate-guard.js";
import { SPEC_FIRST_ROLE_IDS } from "../dist/prompts-spec-first.js";
import { REVIEWER_PROMPT } from "../dist/prompts-spec-first/reviewer.js";

const env = await setupEnv("wi-eng-c-review-");
after(() => env.cleanup());
const agentConfirm = (id, review, extra = {}) => env.call({ action: "confirm", workItemId: id, gateId: "sa-confirm", decision: "confirmed", by: "agent", reason: "審查通過", review, ...extra });
const gate = async (id) => (await env.store.readStatus(id)).work_item_progress.gates["sa-confirm"];
const atSaConfirm = async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "sa-confirm");
  return { id, dir };
};

test("單元：requireReviewReasons 只管 agent；缺理由、空白、太短都列出哪一項", () => {
  assert.doesNotThrow(() => requireReviewReasons("human", { ...CLEAN_REVIEW, scopeSplit: true }));
  assert.doesNotThrow(() => requireReviewReasons("agent", CLEAN_REVIEW));
  assert.doesNotThrow(() => requireReviewReasons("agent", { ...CLEAN_REVIEW, scopeSplit: true, reasons: { scopeSplit: "模組切分使用者尚未決定" } }));
  assert.throws(() => requireReviewReasons("agent", { ...CLEAN_REVIEW, scopeSplit: true }), /scopeSplit/);
  assert.throws(() => requireReviewReasons("agent", { ...CLEAN_REVIEW, breaksExisting: true, reasons: { breaksExisting: "  好 \n " } }), /breaksExisting/);
  assert.throws(() => requireReviewReasons("agent", { ...CLEAN_REVIEW, reviewerUncertain: true, scopeSplit: true, reasons: { reviewerUncertain: "SA 與 impact 矛盾" } }), /scopeSplit/);
});

test("單元：withReviewNote 把理由寫進紀錄；false 且沒理由時格式與原本相同", () => {
  assert.equal(withReviewNote("審查通過", "agent", CLEAN_REVIEW), "審查通過（審查申報 breaksExisting=false、reviewerUncertain=false、scopeSplit=false）");
  assert.match(withReviewNote(undefined, "agent", { ...CLEAN_REVIEW, scopeSplit: true, reasons: { scopeSplit: "切分未決定" } }), /申報理由：scopeSplit＝切分未決定/);
  assert.equal(withReviewNote("原話", "human", { scopeSplit: true }), "原話");
});

for (const key of ["breaksExisting", "reviewerUncertain", "scopeSplit"]) {
  test(`${key}=true 沒附理由：拒絕並指出哪一項，關卡沒有紀錄`, async () => {
    const { id } = await atSaConfirm();
    const r = await agentConfirm(id, { ...CLEAN_REVIEW, [key]: true });
    assert.equal(r.isError, true);
    assert.match(r.json.message, new RegExp(key));
    assert.match(r.json.message, /reasons/);
    assert.deepEqual(r.json.missingReasons, [key]);
    assert.equal(await gate(id), undefined);
  });
}

test("附了理由：仍升級給使用者（AI 不可核准），訊息與 get 看得到理由；使用者確認後清掉升級紀錄", async () => {
  const { id } = await atSaConfirm();
  const review = { ...CLEAN_REVIEW, scopeSplit: true, reasons: { scopeSplit: "訂單與出貨要不要拆成兩個模組，使用者還沒決定" } };
  const r = await agentConfirm(id, review);
  assert.equal(r.isError, true);
  assert.match(r.json.message, /訂單與出貨要不要拆成兩個模組/);
  assert.equal(await gate(id), undefined);
  const g = (await env.call({ action: "get", workItemId: id })).json;
  assert.match(g.reviewEscalations["sa-confirm"].reasons, /scopeSplit＝訂單與出貨/);
  assert.deepEqual(g.reviewEscalations["sa-confirm"].declared, ["scopeSplit"]);
  const h = await env.call({ action: "confirm", workItemId: id, gateId: "sa-confirm", decision: "confirmed", by: "human", reason: "使用者說這樣切可以" });
  assert.equal(h.isError, false, h.text);
  assert.equal((await env.call({ action: "get", workItemId: id })).json.reviewEscalations, undefined);
  assert.equal((await env.store.readStatus(id)).review_escalations?.["sa-confirm"], undefined);
});

test("升級紀錄寫進 00-索引.md 的待處理關卡列", async () => {
  const { id, dir } = await atSaConfirm();
  await agentConfirm(id, { ...CLEAN_REVIEW, breaksExisting: true, reasons: { breaksExisting: "移除了原本的自動查詢，需求沒有明列" } });
  const w = await env.call({ action: "write", workItemId: id, filename: "sa-notes.md", content: "## 待確認問題\n- 無\n" });
  assert.equal(w.isError, false, w.text);
  assert.match(await readFile(path.join(dir, "00-索引.md"), "utf-8"), /AI 審查員已升級給使用者（申報 breaksExisting）：breaksExisting＝移除了原本的自動查詢/);
});

test("申報全為 false：理由可省略；有附理由也會進紀錄；核准成功", async () => {
  const { id } = await atSaConfirm();
  const r = await agentConfirm(id, { ...CLEAN_REVIEW, reasons: { scopeSplit: "需求原文已寫明切分" } });
  assert.equal(r.isError, false, r.text);
  assert.match((await gate(id)).reason, /審查通過.*breaksExisting=false.*申報理由：scopeSplit＝需求原文已寫明切分/);
});

test("AI 打回不需要申報理由（申報為 true 也可打回）", async () => {
  const { id } = await atSaConfirm();
  const r = await env.call({ action: "confirm", workItemId: id, gateId: "sa-confirm", decision: "rejected", by: "agent", reason: "提示文字與 mockup 不符", review: { ...CLEAN_REVIEW, reviewerUncertain: true } });
  assert.equal(r.isError, false, r.text);
});

test("verdict：agent 判 pass 申報為 true 沒理由被拒；附理由則被升級並記錄", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "spec-check-verdict");
  const bad = await env.call({ action: "verdict", workItemId: id, gateId: "spec-check-verdict", result: "pass", by: "agent", review: { ...CLEAN_REVIEW, reviewerUncertain: true } });
  assert.equal(bad.isError, true);
  assert.deepEqual(bad.json.missingReasons, ["reviewerUncertain"]);
  const esc = await env.call({ action: "verdict", workItemId: id, gateId: "spec-check-verdict", result: "pass", by: "agent", review: { ...CLEAN_REVIEW, reviewerUncertain: true, reasons: { reviewerUncertain: "SA 與 impact 對查詢方式寫法矛盾" } } });
  assert.equal(esc.isError, true);
  assert.match(esc.json.message, /SA 與 impact 對查詢方式寫法矛盾/);
  const g = (await env.call({ action: "get", workItemId: id })).json;
  assert.ok(g.reviewEscalations["spec-check-verdict"]);
});

test("role_prompt roleId=reviewer：回審查員說明書（不超過 1600 字、含三個申報判準）；仍要驗證工作項目", async () => {
  const { id } = await atSaConfirm();
  const r = await env.call({ action: "role_prompt", workItemId: id, roleId: "reviewer" });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.prompt, REVIEWER_PROMPT);
  assert.ok(REVIEWER_PROMPT.length <= 1600, String(REVIEWER_PROMPT.length));
  for (const k of ["reviewerUncertain", "scopeSplit", "breaksExisting", "待確認問題", "理由"]) assert.ok(REVIEWER_PROMPT.includes(k), k);
  assert.equal((await env.call({ action: "role_prompt", workItemId: "wi-20200101-999", roleId: "reviewer" })).isError, true);
});

test("reviewer 不是流程角色：未知角色仍拒絕；12 個流程角色與 get 的角色列表不含 reviewer；auto 關卡 howTo 指向說明書", async () => {
  const { id } = await atSaConfirm();
  assert.equal((await env.call({ action: "role_prompt", workItemId: id, roleId: "nobody" })).isError, true);
  assert.equal(SPEC_FIRST_ROLE_IDS.length, 12);
  assert.ok(!SPEC_FIRST_ROLE_IDS.includes("reviewer"));
  const g = (await env.call({ action: "get", workItemId: id })).json;
  assert.ok(!JSON.stringify(g.doneRoles).includes("reviewer"));
  assert.ok(g.waitingGates[0].howTo.includes('role_prompt（roleId="reviewer"）'));
});
