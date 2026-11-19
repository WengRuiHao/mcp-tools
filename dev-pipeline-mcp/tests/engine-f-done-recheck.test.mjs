// 問題 80：done 時對「已完成角色、且產出檔雜湊與紀錄不同」的角色重跑交件內容檢查，不依賴角色走 work_item write。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { setupEnv, runUntil, fulfil, VALID_SA } from "./helpers/work-item-env.mjs";

const env = await setupEnv("wi-eng-f-done-recheck-");
after(() => env.cleanup());
const done = (id, roleId) => env.call({ action: "done", workItemId: id, roleId });
const statusOf = (dir) => JSON.parse(readFileSync(path.join(dir, "status.json"), "utf-8"));
const BAD_SA = "# 需求\n沒有圖\n";

/** 推進到 sd-analyst 之前（SA、DB 設計已 done），並補好 SD 要交的檔。 */
async function readyForSd() {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "sd-analyst");
  await fulfil(dir, "sd-analyst");
  return { id, dir };
}

test("角色 done 時記下產出檔雜湊", async () => {
  const { dir } = await readyForSd();
  const hashes = statusOf(dir).deliverable_hashes;
  assert.match(hashes["sa-analyst"]["01-sa.md"], /^[0-9a-f]{64}$/);
  assert.ok(Object.keys(hashes["db-designer"]).some((f) => f.startsWith("TableSchema/")));
});

test("外部改檔（沒走 write）讓已完成角色的內容不合格：後面角色 done 被擋，訊息指出角色與檔名", async () => {
  const { id, dir } = await readyForSd();
  writeFileSync(path.join(dir, "01-sa.md"), BAD_SA);
  const r = await done(id, "sd-analyst");
  assert.equal(r.isError, true);
  assert.match(r.text, /已完成角色「sa-analyst」的產出檔（01-sa\.md）在交件後被改動/);
  assert.match(r.text, /SA 標準檢查未通過|至少要有一張圖/);
  assert.ok(r.json.problems.length > 0);
  assert.equal(statusOf(dir).work_item_progress.roles["sd-analyst"]?.done ?? false, false);
  // 修回合格內容後放行
  writeFileSync(path.join(dir, "01-sa.md"), VALID_SA);
  const ok = await done(id, "sd-analyst");
  assert.equal(ok.isError, false, ok.text);
});

test("外部改檔但內容仍合格：放行，並把新雜湊記回 status", async () => {
  const { id, dir } = await readyForSd();
  const before = statusOf(dir).deliverable_hashes["sa-analyst"]["01-sa.md"];
  writeFileSync(path.join(dir, "01-sa.md"), `${VALID_SA}\n`);
  const r = await done(id, "sd-analyst");
  assert.equal(r.isError, false, r.text);
  const after = statusOf(dir).deliverable_hashes["sa-analyst"]["01-sa.md"];
  assert.notEqual(after, before);
});

test("檔案未改動：不重複檢查（連檢查會失敗的非文字附件被移除也不影響）", async () => {
  const { id, dir } = await readyForSd();
  // 若 SA 被重檢，缺少 sa-images/a.png 會讓 SA 截圖檢查失敗；圖片不納入雜湊，所以不該重檢。
  rmSync(path.join(dir, "sa-images", "a.png"));
  const r = await done(id, "sd-analyst");
  assert.equal(r.isError, false, r.text);
});

test("write 通過重檢會更新雜湊；write 寫成不合格內容則不更新，之後別的角色 done 仍被擋", async () => {
  const { id, dir } = await readyForSd();
  const good = await env.call({ action: "write", workItemId: id, filename: "01-sa.md", content: `${VALID_SA}\n` });
  assert.equal(good.json.recheck.ok, true);
  const hashAfterGood = statusOf(dir).deliverable_hashes["sa-analyst"]["01-sa.md"];
  const bad = await env.call({ action: "write", workItemId: id, filename: "01-sa.md", content: BAD_SA });
  assert.equal(bad.json.recheck.ok, false);
  assert.equal(statusOf(dir).deliverable_hashes["sa-analyst"]["01-sa.md"], hashAfterGood);
  const r = await done(id, "sd-analyst");
  assert.equal(r.isError, true);
  assert.match(r.text, /sa-analyst.*01-sa\.md/);
});

test("沒有雜湊紀錄（舊資料）的新版面項目：內容合格放行並補紀錄；不合格被擋並說明沒有 write 紀錄", async () => {
  const { id, dir } = await readyForSd();
  const strip = () => { const st = statusOf(dir); delete st.deliverable_hashes; writeFileSync(path.join(dir, "status.json"), JSON.stringify(st, null, 2)); };
  strip();
  writeFileSync(path.join(dir, "01-sa.md"), BAD_SA);
  const blocked = await done(id, "sd-analyst");
  assert.equal(blocked.isError, true);
  assert.match(blocked.text, /沒有經過 work_item write 的紀錄/);
  writeFileSync(path.join(dir, "01-sa.md"), VALID_SA);
  const ok = await done(id, "sd-analyst");
  assert.equal(ok.isError, false, ok.text);
  assert.ok(statusOf(dir).deliverable_hashes["sa-analyst"]["01-sa.md"]);
});

test("legacy 版面且沒有雜湊紀錄：相容，只補基準線不重檢", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "sd-analyst");
  await fulfil(dir, "sd-analyst");
  const st = statusOf(dir);
  delete st.deliverable_hashes;
  st.workflow_snapshot.roles.push({ id: "flow-analyst", dependsOn: ["sa-analyst", "db-designer"], optional: false });
  writeFileSync(path.join(dir, "status.json"), JSON.stringify(st, null, 2));
  writeFileSync(path.join(dir, "01-sa.md"), BAD_SA);
  const r = await done(id, "sd-analyst");
  assert.doesNotMatch(r.text, /已完成角色「sa-analyst」/);
  assert.ok(statusOf(dir).deliverable_hashes?.["sa-analyst"]);
});

test("attach 放入圖片不改變雜湊、不觸發重檢", async () => {
  const { id, dir } = await readyForSd();
  const before = JSON.stringify(statusOf(dir).deliverable_hashes["sa-analyst"]);
  const src = path.join(env.tmp, "extra.png");
  writeFileSync(src, readFileSync(path.join(dir, "sa-images", "a.png")));
  const a = await env.call({ action: "attach", workItemId: id, srcPath: src, destDir: "sa-images", name: "extra.png" });
  assert.equal(a.isError, false, a.text);
  const r = await done(id, "sd-analyst");
  assert.equal(r.isError, false, r.text);
  assert.equal(JSON.stringify(statusOf(dir).deliverable_hashes["sa-analyst"]), before);
});
