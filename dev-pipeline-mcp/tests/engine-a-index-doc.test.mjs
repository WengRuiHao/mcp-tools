// 問題 57／64：每個工作項目目錄自動產生 00-索引.md（流程對照表、重點檔、關卡確認紀錄），標示重點檔與內部過程檔。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { setupEnv, runUntil } from "./helpers/work-item-env.mjs";

const env = await setupEnv("wi-eng-a-index-");
after(() => env.cleanup());
const INDEX = "00-索引.md";
const exists = (f) => stat(f).then(() => true, () => false);

test("done／confirm 後產生索引：標題摘要、流程對照表狀態、重點檔與內部檔標示、關卡原話", async () => {
  const { id, dir } = await env.create({ title: "登入功能" });
  await runUntil(env, id, dir, "sa-confirm");
  const text = await readFile(path.join(dir, INDEX), "utf-8");
  assert.match(text, /^# 工作項目索引：登入功能/);
  assert.match(text, /是否完成：否/);
  for (const s of ["## 流程對照表", "## 給人看的重點檔", "## 關卡確認紀錄"]) assert.ok(text.includes(s), s);
  const row = (role) => text.split("\n").find((l) => l.startsWith("|") && l.includes(`| ${role} |`));
  assert.match(row("sa-analyst"), /\| 完成 \|/);
  assert.match(row("sa-analyst"), /\[01-sa\.md\]\(01-sa\.md\)｜給人看的重點檔/);
  assert.match(row("sa-analyst"), /\[sa-notes\.md\]\(sa-notes\.md\)｜內部過程檔/);
  assert.match(row("db-designer"), /\| 未開始 \|/);
  assert.match(row("tech-selector"), /\| 完成 \|/);
  assert.match(text, /mockup-confirm.*確認 \| human（使用者本人）.*使用者說確認/);
});

test("write 也更新索引（重點檔尚未產生會標示）；寫 00-索引.md 本身被拒絕", async () => {
  const { id, dir } = await env.create();
  const w = await env.call({ action: "write", workItemId: id, filename: "baseline.md", content: "x" });
  assert.equal(w.isError, false);
  assert.equal(await exists(path.join(dir, INDEX)), true);
  assert.match(await readFile(path.join(dir, INDEX), "utf-8"), /03-sd\.md\]\(03-sd\.md\)（尚未產生）/);
  const bad = await env.call({ action: "write", workItemId: id, filename: INDEX, content: "手寫" });
  assert.equal(bad.isError, true);
});

test("00-索引.md 屬於內部檔，不影響最終驗收產出物計數，且全流程完成後顯示完成", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "final-acceptance-none");
  const r = await env.call({ action: "confirm", workItemId: id, gateId: "final-acceptance", decision: "confirmed", by: "human", reason: "使用者說驗收通過" });
  // 索引檔不是流程產出物：產出物總數維持 19（缺的 2 項是此情境沒產生的選用檔），不會因 00-索引.md 增加
  assert.match(r.json.finalSummaryBrief, /產出物 19 項中 17 項存在/);
  const summary = await readFile(r.json.summaryFile, "utf-8");
  assert.match(summary, /### 內部過程檔[\s\S]*00-索引\.md：存在/);
  assert.doesNotMatch(summary.split("### 正式交付物")[1].split("### 內部過程檔")[0], /00-索引/);
  const idx = await readFile(path.join(dir, INDEX), "utf-8");
  assert.match(idx, /是否完成：是/);
  assert.match(idx, /最終驗收.*確認 \| human.*使用者說驗收通過/);
  const get = await env.call({ action: "get", workItemId: id });
  assert.ok(get.json.internalFiles.some((f) => f.path === INDEX && f.exists));
  assert.ok(!get.json.deliverables.some((f) => f.path === INDEX));
});

test("無法寫索引（路徑被資料夾佔用）：write 與 done 仍成功，附警告", async () => {
  const { id, dir } = await env.create();
  await rm(path.join(dir, INDEX), { force: true }); // create 已會產生索引檔，先移除再用資料夾佔用同名路徑
  await mkdir(path.join(dir, INDEX));
  const w = await env.call({ action: "write", workItemId: id, filename: "baseline.md", content: "x" });
  assert.equal(w.isError, false);
  assert.match(w.json.indexWarning, /00-索引\.md 更新失敗/);
  await runUntil(env, id, dir, "mockup-designer");
  assert.ok((await env.store.readStatus(id)).work_item_progress.roles["tech-selector"].done);
});

test("使用者原話含直線與換行：表格不會被撐壞", async () => {
  const { id, dir } = await env.create({ styleSource: "new-guided" });
  await runUntil(env, id, dir, "mockup-confirm");
  const r = await env.call({ action: "confirm", workItemId: id, gateId: "mockup-confirm", decision: "confirmed", by: "human", reason: "確認 | 沒問題\n換行" });
  assert.equal(r.isError, false);
  const line = (await readFile(path.join(dir, INDEX), "utf-8")).split("\n").find((l) => l.includes("mockup-confirm"));
  assert.ok(line.includes("確認 \\| 沒問題 換行"));
});
