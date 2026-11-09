// work_item done：交件檢查（產出檔、SA 截圖、flow.png、PASS／FAIL 報告）與推進順序。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setupEnv, fulfil, runUntil } from "./helpers/work-item-env.mjs";

const env = await setupEnv("wi-done-");
after(() => env.cleanup());
const done = (id, roleId) => env.call({ action: "done", workItemId: id, roleId });

test("done：缺產出檔不標記完成、補齊後成功並回傳下一步", async () => {
  const { id, dir } = await env.create();
  const bad = await done(id, "mockup-designer");
  assert.equal(bad.isError, true);
  assert.match(bad.json.message, /sa-mockup\//);
  assert.deepEqual((await env.call({ action: "get", workItemId: id })).json.doneRoles, []);
  await fulfil(dir, "mockup-designer");
  const ok = await done(id, "mockup-designer");
  assert.equal(ok.isError, false);
  assert.equal(ok.json.waitingGates[0].gateId, "mockup-confirm");
  assert.equal((await done(id, "mockup-designer")).isError, true);
});

test("done：還沒輪到、被略過、不存在的角色都拒絕", async () => {
  const { id } = await env.create({ scope: "backend", hasDb: false });
  const early = await done(id, "sd-analyst");
  assert.equal(early.isError, true);
  assert.match(early.json.message, /還不能交件/);
  assert.equal((await done(id, "frontend-engineer")).isError, true);
  assert.equal((await done(id, "ghost")).isError, true);
});

test("done sa-analyst：01-sa.md 不存在轉成失敗訊息；缺圖逐項回報；通過後程式自動通過 sa-content-check", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "sa-analyst");
  const none = await done(id, "sa-analyst");
  assert.equal(none.isError, true);
  assert.match(none.json.message, /01-sa\.md/);
  await writeFile(path.join(dir, "01-sa.md"), "## 功能：登入\n沒有圖\n## 功能：匯出\n沒有圖\n");
  const viol = await done(id, "sa-analyst");
  assert.equal(viol.isError, true);
  assert.equal(viol.json.problems.filter((p) => p.includes("缺圖引用")).length, 2);
  await fulfil(dir, "sa-analyst");
  const ok = await done(id, "sa-analyst");
  assert.equal(ok.isError, false);
  assert.ok(!ok.json.waitingGates.some((g) => g.gateId === "sa-content-check"));
  assert.ok(ok.json.waitingGates.some((g) => g.gateId === "sa-confirm"));
});

test("done flow-analyst：必須有 flow.mmd 與非空 flow.png", async () => {
  const { id, dir } = await env.create({ hasDb: false });
  await runUntil(env, id, dir, "db-designer");
  await fulfil(dir, "flow-analyst");
  await rm(path.join(dir, "flow.png"));
  const noPng = await done(id, "flow-analyst");
  assert.equal(noPng.isError, true);
  assert.match(noPng.json.message, /flow\.png/);
  await writeFile(path.join(dir, "flow.png"), "");
  assert.equal((await done(id, "flow-analyst")).isError, true);
  await writeFile(path.join(dir, "flow.png"), "x");
  assert.equal((await done(id, "flow-analyst")).isError, false);
});

test("done spec-verifier：第一行必須 PASS／FAIL，FAIL 要有合法 rootCause", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "spec-verifier");
  const cases = [
    ["看起來沒問題", /PASS 或 FAIL/],
    ["FAIL\n沒寫原因", /rootCause 行/],
    ["FAIL\nrootCause: zz", /不合法/],
    ["FAIL\nrootCause: fe", /不合法/],
  ];
  for (const [text, re] of cases) {
    await writeFile(path.join(dir, "spec-check.md"), text);
    const r = await done(id, "spec-verifier");
    assert.equal(r.isError, true, text);
    assert.match(r.json.message, re);
  }
  await writeFile(path.join(dir, "spec-check.md"), "FAIL\nrootCause: sd\n原因");
  assert.equal((await done(id, "spec-verifier")).isError, false);
});

test("done verifier：rootCause 可用 fe／be；PASS 直接過", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "verifier");
  await fulfil(dir, "verifier", { verdictText: "FAIL\nrootCause: fe" });
  assert.equal((await done(id, "verifier")).isError, false);
  await mkdir(dir, { recursive: true });
});
