// 問題 39：update_requirement 更新需求原文、記錄修改歷程、刷新索引，不自動退回任何角色。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setupEnv, runUntil } from "./helpers/work-item-env.mjs";

const env = await setupEnv("wi-eng-b-updreq-");
after(() => env.cleanup());
const upd = (id, extra = {}) => env.call({ action: "update_requirement", workItemId: id, requirement: "新的需求全文：加上匯出功能", reason: "使用者說要加匯出", by: "human", ...extra });

test("成功：item.md 被取代、歷程記錄時間／原話／舊需求摘要、列出已完成角色與建議、不退回任何角色", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "sa-confirm");
  const doneBefore = Object.keys((await env.store.readStatus(id)).work_item_progress.roles).sort();
  const r = await upd(id);
  assert.equal(r.isError, false, r.text);
  assert.equal(await readFile(path.join(dir, "item.md"), "utf-8"), "新的需求全文：加上匯出功能");
  const s = await env.store.readStatus(id);
  assert.equal(s.requirement_history.length, 1);
  assert.equal(s.requirement_history[0].quote, "使用者說要加匯出");
  assert.equal(s.requirement_history[0].previous_summary, "需求原文");
  assert.ok(!Number.isNaN(Date.parse(s.requirement_history[0].at)));
  assert.deepEqual(Object.keys(s.work_item_progress.roles).sort(), doneBefore);
  assert.ok(r.json.completedRoles.some((x) => x.roleId === "mockup-designer"));
  assert.match(r.json.suggestion, /alsoRewind/);
  assert.match(await readFile(path.join(dir, "00-索引.md"), "utf-8"), /工作項目索引/);
});

test("舊需求摘要只取前 200 字；多次修改歷程累加；沒有已完成角色時建議不同", async () => {
  const { id, dir } = await env.create({ title: "長需求" });
  await env.call({ action: "update_requirement", workItemId: id, requirement: "長".repeat(500), reason: "使用者說改長", by: "human" });
  const r = await upd(id);
  assert.equal(r.isError, false, r.text);
  const s = await env.store.readStatus(id);
  assert.equal(s.requirement_history.length, 2);
  assert.equal(s.requirement_history[1].previous_summary.length, 200);
  assert.deepEqual(r.json.completedRoles, []);
  assert.match(r.json.suggestion, /尚無已完成的角色/);
  assert.equal(await readFile(path.join(dir, "item.md"), "utf-8"), "新的需求全文：加上匯出功能");
});

test("拒絕：by 不是 human、reason 缺漏／太短／選項代號、requirement 缺漏、內容相同，且不改檔案與狀態", async () => {
  const { id, dir } = await env.create();
  const cases = [
    [{ by: "agent" }, /by:"human"/],
    [{ by: undefined }, /by:"human"/],
    [{ reason: undefined }, /reason/],
    [{ reason: "好" }, /reason/],
    [{ reason: "A" }, /選項代號/],
    [{ requirement: "" }, /requirement/],
    [{ requirement: "需求原文" }, /相同/],
  ];
  for (const [extra, re] of cases) {
    const r = await upd(id, extra);
    assert.equal(r.isError, true, JSON.stringify(extra));
    assert.match(r.json.message, re);
  }
  assert.equal(await readFile(path.join(dir, "item.md"), "utf-8"), "需求原文");
  assert.equal((await env.store.readStatus(id)).requirement_history, undefined);
});

test("找不到工作項目回錯誤", async () => {
  const r = await upd("wi-20200101-999");
  assert.equal(r.isError, true);
});
