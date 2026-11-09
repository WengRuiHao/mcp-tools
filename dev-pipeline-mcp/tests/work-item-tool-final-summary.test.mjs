// work_item confirm：final-acceptance confirmed 後產生 final-summary.md；rejected 不產生；寫檔失敗不影響確認；get 回傳路徑。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setupEnv, runUntil } from "./helpers/work-item-env.mjs";

const env = await setupEnv("wi-final-summary-");
after(() => env.cleanup());
const accept = (id) => env.call({ action: "confirm", workItemId: id, gateId: "final-acceptance", decision: "confirmed", by: "human", reason: "使用者說驗收通過" });
const exists = (f) => stat(f).then(() => true, () => false);

test("confirmed：寫出 final-summary.md，回傳 summaryFile 與簡短摘要，內容無原始 JSON", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "final-acceptance-none");
  assert.equal(await exists(path.join(dir, "final-summary.md")), false);
  assert.equal((await env.call({ action: "get", workItemId: id })).json.summaryFile, undefined);
  const r = await accept(id);
  assert.equal(r.isError, false);
  assert.equal(r.json.summaryFile, path.join(dir, "final-summary.md"));
  assert.match(r.json.finalSummaryBrief, /道關卡/);
  assert.equal(r.json.warning, undefined);
  const text = await readFile(r.json.summaryFile, "utf-8");
  for (const s of ["一、基本資料", "二、關卡時間線", "三、硬停點與退回紀錄", "四、產出物清單", "使用者說驗收通過", "測試需求", "sa-images 張數：1 張", "evidence 張數：1 張", "flow.png：存在"]) assert.ok(text.includes(s), s);
  assert.match(text, /最終驗收（final-acceptance）：確認｜使用者本人/);
  assert.match(text, /SA 內容檢查（sa-content-check）：通過｜程式檢查/);
  assert.doesNotMatch(text, /[{}]|"decision"|�|undefined/);
  assert.equal((await env.call({ action: "get", workItemId: id })).json.summaryFile, r.json.summaryFile);
});

test("有 dup-report.md 時多一節摘要", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "final-acceptance-none");
  await writeFile(path.join(dir, "dup-report.md"), "- 未豁免的重複區塊：0 筆\n- 已豁免的重複區塊：1 筆\n");
  const r = await accept(id);
  const text = await readFile(r.json.summaryFile, "utf-8");
  assert.match(text, /已豁免的重複區塊：1 筆/);
});

test("rejected：不產生報告", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "final-acceptance-none");
  const rej = await env.call({ action: "confirm", workItemId: id, gateId: "final-acceptance", decision: "rejected", by: "human", reason: "使用者說不通過" });
  assert.equal(rej.isError, false);
  assert.equal(rej.json.summaryFile, undefined);
  assert.equal(await exists(path.join(dir, "final-summary.md")), false);
});

test("非最終驗收關卡的 confirm 不產生報告", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "sa-analyst");
  assert.equal(await exists(path.join(dir, "final-summary.md")), false);
});

test("寫檔失敗不影響確認：回傳 warning、關卡仍記為 confirmed", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "final-acceptance-none");
  await mkdir(path.join(dir, "final-summary.md"));
  const r = await accept(id);
  assert.equal(r.isError, false);
  assert.equal(r.json.summaryFile, undefined);
  assert.match(r.json.warning, /final-summary\.md 寫入失敗/);
  assert.equal((await env.store.readStatus(id)).work_item_progress.gates["final-acceptance"].decision, "confirmed");
  assert.equal((await env.call({ action: "get", workItemId: id })).json.complete, true);
});
