// 問題 7：by:"human" 的 confirm（confirmed／rejected）與 verdict（pass／fail）一律要原話；by:"agent" 的 verdict fail 也要 reason。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { setupEnv, runUntil, fulfil, CLEAN_REVIEW } from "./helpers/work-item-env.mjs";

const env = await setupEnv("wi-eng-b-humanreason-");
after(() => env.cleanup());
const confirm = (id, gateId, decision, extra = {}) => env.call({ action: "confirm", workItemId: id, gateId, decision, by: "human", ...extra });
const gateRec = async (id, g) => (await env.store.readStatus(id)).work_item_progress.gates[g];

test("human 確認 auto 關卡（sa-confirm）：沒有 reason、太短、選項代號都被擋；有原話才通過並記錄", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "sa-confirm");
  for (const [reason, re] of [[undefined, /確認.*必須附 reason/], ["", /必須附 reason/], ["好", /必須附 reason/], ["A", /選項代號/]]) {
    const r = await confirm(id, "sa-confirm", "confirmed", reason === undefined ? {} : { reason });
    assert.equal(r.isError, true, String(reason));
    assert.match(r.json.message, re);
  }
  assert.equal(await gateRec(id, "sa-confirm"), undefined);
  const ok = await confirm(id, "sa-confirm", "confirmed", { reason: "使用者說可以" });
  assert.equal(ok.isError, false, ok.text);
  assert.equal((await gateRec(id, "sa-confirm")).reason, "使用者說可以");
});

test("human 打回 auto 關卡：沒有 reason 被擋，訊息是打回措辭（和確認不同）；有原話才通過", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "sa-confirm");
  const r = await confirm(id, "sa-confirm", "rejected");
  assert.equal(r.isError, true);
  assert.match(r.json.message, /打回關卡「sa-confirm」必須附 reason：使用者要求打回的原話或理由/);
  const opt = await confirm(id, "sa-confirm", "rejected", { reason: "B" });
  assert.match(opt.json.message, /打回理由/);
  const ok = await confirm(id, "sa-confirm", "rejected", { reason: "使用者說截圖不對" });
  assert.equal(ok.isError, false, ok.text);
});

test("硬停點由使用者核准：human 仍須附原話", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "sa-confirm");
  await env.store.updateStatus(id, (s) => ({ ...s, consecutive_fail_count: 3 }));
  assert.equal((await confirm(id, "sa-confirm", "confirmed")).isError, true);
  assert.equal((await confirm(id, "sa-confirm", "confirmed", { reason: "使用者看過後核准" })).isError, false);
});

test("人工關卡（mockup-confirm）原本就要原話，行為不變", async () => {
  const { id, dir } = await env.create({ styleSource: "new-guided" });
  await runUntil(env, id, dir, "mockup-confirm");
  assert.equal((await confirm(id, "mockup-confirm", "confirmed")).isError, true);
  assert.equal((await confirm(id, "mockup-confirm", "confirmed", { reason: "使用者說確認" })).isError, false);
});

test("by:agent 的 confirm 核准不需要 reason（行為不變）", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "sa-confirm");
  const r = await env.call({ action: "confirm", workItemId: id, gateId: "sa-confirm", decision: "confirmed", by: "agent", review: CLEAN_REVIEW });
  assert.equal(r.isError, false, r.text);
});

test("verdict：human 判 pass／fail 沒有 reason 被擋（兩種措辭），有原話通過；fail 的原話寫入紀錄", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "spec-check-verdict");
  const p = await env.call({ action: "verdict", workItemId: id, gateId: "spec-check-verdict", result: "pass", by: "human" });
  assert.equal(p.isError, true);
  assert.match(p.json.message, /判定通過關卡「spec-check-verdict」必須附 reason：使用者這次判定通過的原話/);
  const f = await env.call({ action: "verdict", workItemId: id, gateId: "spec-check-verdict", result: "fail", rootCause: "sd", by: "human" });
  assert.equal(f.isError, true);
  assert.match(f.json.message, /判定不通過關卡「spec-check-verdict」必須附 reason：使用者要求判定不通過的原話或理由/);
  const opt = await env.call({ action: "verdict", workItemId: id, gateId: "spec-check-verdict", result: "pass", by: "human", reason: "1" });
  assert.match(opt.json.message, /選項代號/);
  assert.equal(await gateRec(id, "spec-check-verdict"), undefined);
  const fail = await env.call({ action: "verdict", workItemId: id, gateId: "spec-check-verdict", result: "fail", rootCause: "sd", by: "human", reason: "使用者說 SD 要重寫" });
  assert.equal(fail.isError, false, fail.text);
  assert.equal((await gateRec(id, "spec-check-verdict")).reason, "使用者說 SD 要重寫");
});

test("verdict：human 判 pass 附原話通過", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "spec-check-verdict");
  const ok = await env.call({ action: "verdict", workItemId: id, gateId: "spec-check-verdict", result: "pass", by: "human", reason: "使用者說規格沒問題" });
  assert.equal(ok.isError, false, ok.text);
});

test("verdict：agent 判 fail 必須附 reason（至少 2 字）；判 pass 不需要", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "spec-verifier");
  await fulfil(dir, "spec-verifier", { verdictText: "FAIL\nrootCause: sd\nSD 缺欄位" });
  await env.call({ action: "done", workItemId: id, roleId: "spec-verifier" });
  const base = { action: "verdict", workItemId: id, gateId: "spec-check-verdict", result: "fail", rootCause: "sd", by: "agent", review: CLEAN_REVIEW };
  for (const reason of [undefined, " ", "好"]) {
    const r = await env.call({ ...base, ...(reason === undefined ? {} : { reason }) });
    assert.equal(r.isError, true, String(reason));
    assert.match(r.json.message, /判定不通過.*必須附 reason/);
  }
  const ok = await env.call({ ...base, reason: "SD 少了錯誤碼" });
  assert.equal(ok.isError, false, ok.text);
  assert.match((await gateRec(id, "spec-check-verdict")).reason, /SD 少了錯誤碼/);
});
