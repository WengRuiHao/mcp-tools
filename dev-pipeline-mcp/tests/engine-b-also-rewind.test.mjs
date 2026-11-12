// 問題 37：confirm 打回可用 alsoRewind 一併退回該關卡之前的角色。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { setupEnv, fulfil, runUntil } from "./helpers/work-item-env.mjs";

const env = await setupEnv("wi-eng-b-alsorewind-");
after(() => env.cleanup());
const progress = async (id) => (await env.store.readStatus(id)).work_item_progress;
const reject = (id, gateId, extra = {}) => env.call({ action: "confirm", workItemId: id, gateId, decision: "rejected", by: "human", reason: "使用者說要重做", ...extra });

test("沒給 alsoRewind：行為不變，只退回該關卡的角色，前面角色保留", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "sa-confirm");
  const r = await reject(id, "sa-confirm");
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(r.json.rewoundRoles, ["sa-analyst"]);
  assert.equal(r.json.alsoRewind, undefined);
  assert.equal((await progress(id)).roles["mockup-designer"].done, true);
});

test("alsoRewind 指定前面角色：該角色與下游一併退回，相關確認清掉，打回紀錄保留", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "sa-confirm");
  const r = await reject(id, "sa-confirm", { alsoRewind: ["mockup-designer"] });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual([...r.json.rewoundRoles].sort(), ["mockup-designer", "sa-analyst"]);
  assert.deepEqual(r.json.alsoRewind, ["mockup-designer"]);
  const p = await progress(id);
  assert.equal(p.roles["mockup-designer"], undefined);
  assert.equal(p.gates["mockup-confirm"], undefined);
  assert.equal(p.roles["tech-selector"].done, true);
  assert.equal(p.gates["sa-confirm"].decision, "rejected");
  assert.deepEqual(r.json.nextRoles.map((n) => n.roleId), ["mockup-designer"]);
});

test("既有系統：alsoRewind baseline-survey 讓 impact 相關關卡與後面所有角色退回", async () => {
  const { id, dir } = await env.create({ baseline: "brownfield" });
  await fulfil(dir, "baseline-survey");
  assert.equal((await env.call({ action: "done", workItemId: id, roleId: "baseline-survey" })).isError, false);
  await runUntil(env, id, dir, "sa-confirm");
  const r = await reject(id, "sa-confirm", { alsoRewind: ["baseline-survey"] });
  assert.equal(r.isError, false, r.text);
  const p = await progress(id);
  assert.equal(p.roles["baseline-survey"], undefined);
  assert.equal(p.gates["impact-content"], undefined);
  assert.equal(p.roles["tech-selector"], undefined);
});

test("alsoRewind 驗證：不存在的角色、不是之前的角色、被略過的角色、搭配核准都被拒絕且不改狀態", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "sa-confirm");
  const before = JSON.stringify(await progress(id));
  const cases = [
    [{ alsoRewind: ["ghost"] }, /不存在於流程定義/],
    [{ alsoRewind: ["spec-verifier"] }, /不是關卡「sa-confirm」之前的角色/],
    [{ alsoRewind: ["sa-analyst"] }, /不是關卡「sa-confirm」之前的角色/],
    [{ alsoRewind: ["baseline-survey"] }, /被略過/],
  ];
  for (const [extra, re] of cases) {
    const r = await reject(id, "sa-confirm", extra);
    assert.equal(r.isError, true, JSON.stringify(extra));
    assert.match(r.json.message, re);
  }
  const ok = await env.call({ action: "confirm", workItemId: id, gateId: "sa-confirm", decision: "confirmed", by: "human", reason: "使用者說確認", alsoRewind: ["mockup-designer"] });
  assert.equal(ok.isError, true);
  assert.match(ok.json.message, /只能搭配打回/);
  assert.equal(JSON.stringify(await progress(id)), before);
});

test("AI 打回也可用 alsoRewind", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "sa-confirm");
  const r = await env.call({ action: "confirm", workItemId: id, gateId: "sa-confirm", decision: "rejected", by: "agent", reason: "前面 mockup 與 SA 不一致", alsoRewind: ["mockup-designer"] });
  assert.equal(r.isError, false, r.text);
  assert.equal((await progress(id)).roles["mockup-designer"], undefined);
});
