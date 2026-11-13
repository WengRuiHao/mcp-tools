// work_item A1／A2：content／evidence 關卡由程式檢查自動通過；人工確認必須附使用者原話。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setupEnv, fulfil, runUntil } from "./helpers/work-item-env.mjs";

const env = await setupEnv("wi-progate-");
after(() => env.cleanup());
const gateRec = async (id, gateId) => (await env.store.readStatus(id)).work_item_progress?.gates[gateId];
const confirm = (id, gateId, extra = {}) => env.call({ action: "confirm", workItemId: id, gateId, decision: "confirmed", ...extra });
const setFlow = (gates) => mkdir(path.join(env.projectDir, ".pipeline"), { recursive: true }).then(() => writeFile(path.join(env.projectDir, ".pipeline", "flow.json"), JSON.stringify({ schemaVersion: 1, gates })));

test("A1：既有系統 baseline-survey done 後 impact-content 由程式自動通過，且 confirm 回「由程式檢查」", async () => {
  const { id, dir } = await env.create({ baseline: "brownfield" });
  await fulfil(dir, "baseline-survey");
  const r = await env.call({ action: "done", workItemId: id, roleId: "baseline-survey" });
  assert.equal(r.isError, false);
  assert.ok(!r.json.waitingGates.some((g) => g.gateId === "impact-content"));
  const rec = await gateRec(id, "impact-content");
  assert.equal(rec.decision, "passed");
  assert.equal(rec.by, "agent");
  assert.match(rec.reason, /程式檢查/);
  const c = await confirm(id, "impact-content", { by: "human", reason: "使用者說確認" });
  assert.equal(c.isError, true);
  assert.match(c.json.message, /由程式檢查，不需確認/);
});

test("A1：前後端 done 後 implementation-content、tester done 後 test-evidence 自動通過，只剩 final-acceptance 等人", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "tester");
  assert.equal((await gateRec(id, "implementation-content")).by, "agent");
  await fulfil(dir, "tester");
  const r = await env.call({ action: "done", workItemId: id, roleId: "tester" });
  assert.equal(r.isError, false);
  assert.equal((await gateRec(id, "test-evidence")).decision, "passed");
  assert.deepEqual(r.json.waitingGates.map((g) => [g.gateId, g.waitingFor]), [["final-acceptance", "user"]]);
  assert.equal((await confirm(id, "test-evidence", { by: "agent" })).isError, true);
});

test("A1：flow.json 把 test-evidence 覆寫成 manual 時不自動通過，要人確認（且須附原話）", async () => {
  await setFlow({ "test-evidence": { confirmMode: "manual" } });
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "tester");
  await fulfil(dir, "tester");
  const r = await env.call({ action: "done", workItemId: id, roleId: "tester" });
  assert.equal(await gateRec(id, "test-evidence"), undefined);
  assert.equal(r.json.waitingGates.find((g) => g.gateId === "test-evidence").waitingFor, "user");
  assert.equal((await confirm(id, "test-evidence", { by: "human" })).isError, true);
  assert.equal((await confirm(id, "test-evidence", { by: "human", reason: "好" })).isError, true);
  const ok = await confirm(id, "test-evidence", { by: "human", reason: "使用者：證據看過了" });
  assert.equal(ok.isError, false);
  assert.equal((await gateRec(id, "test-evidence")).reason, "使用者：證據看過了");
  await setFlow({});
});

test("A2：manual 關卡（mockup-confirm、final-acceptance）human 必附 ≥2 字原話；空白不算字數", async () => {
  const { id, dir } = await env.create({ styleSource: "new-guided" });
  await runUntil(env, id, dir, "mockup-confirm");
  for (const reason of [undefined, "", "   ", "好", " 好 ", "o "]) {
    const r = await confirm(id, "mockup-confirm", { by: "human", ...(reason !== undefined ? { reason } : {}) });
    assert.equal(r.isError, true, String(reason));
    assert.match(r.json.message, /原話/);
  }
  assert.equal(await gateRec(id, "mockup-confirm"), undefined);
  assert.equal((await confirm(id, "mockup-confirm", { by: "human", reason: "使用者說可以" })).isError, false);
  await runUntil(env, id, dir, "final-acceptance-none");
  assert.equal((await confirm(id, "final-acceptance", { by: "human", reason: "x" })).isError, true);
  assert.equal((await confirm(id, "final-acceptance", { by: "human", reason: "使用者驗收通過" })).isError, false);
});

test("A2：2 個字元的原話（確認、同意）通過，前後空白不算字數", async () => {
  const { id, dir } = await env.create({ styleSource: "new-guided" });
  await runUntil(env, id, dir, "mockup-confirm");
  assert.equal((await confirm(id, "mockup-confirm", { by: "human", reason: " 確 認 " })).isError, false);
  await runUntil(env, id, dir, "final-acceptance-none");
  assert.equal((await confirm(id, "final-acceptance", { by: "human", reason: "同意" })).isError, false);
});

test("A2：AI 審查（auto）路徑不要求 reason；被專案設成 manual 的 verdict 關卡 human 需附原話", async () => {
  await setFlow({ "spec-check-verdict": { confirmMode: "manual" } });
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "spec-check-verdict");
  const bad = await env.call({ action: "verdict", workItemId: id, gateId: "spec-check-verdict", result: "pass", by: "human" });
  assert.equal(bad.isError, true);
  assert.match(bad.json.message, /原話/);
  const ok = await env.call({ action: "verdict", workItemId: id, gateId: "spec-check-verdict", result: "pass", by: "human", reason: "使用者認可規格" });
  assert.equal(ok.isError, false);
  await setFlow({});
  const { id: id2, dir: dir2 } = await env.create();
  await runUntil(env, id2, dir2, "sa-confirm");
  const agentOk = await confirm(id2, "sa-confirm", { by: "agent", review: { breaksExisting: false, reviewerUncertain: false, scopeSplit: false } });
  assert.equal(agentOk.isError, false);
});
