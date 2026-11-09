// work_item done：S8 流程圖／測試證據檢查、S10 重用防線檢查接進交件檢查。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setupEnv, fulfil, runUntil } from "./helpers/work-item-env.mjs";

const env = await setupEnv("wi-checks-");
after(() => env.cleanup());
const done = (id, roleId) => env.call({ action: "done", workItemId: id, roleId });

test("done flow-analyst：flow.mmd 格式不合（無圖類型、script、括號）逐項回報，修正後通過", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "flow-analyst");
  await fulfil(dir, "flow-analyst");
  await writeFile(path.join(dir, "flow.mmd"), "A[<script>x</script>-->B\n");
  const bad = await done(id, "flow-analyst");
  assert.equal(bad.isError, true);
  assert.ok(bad.json.problems.some((p) => p.includes("圖類型")));
  assert.ok(bad.json.problems.some((p) => p.includes("<script")));
  assert.ok(bad.json.problems.some((p) => p.includes("括號")));
  await writeFile(path.join(dir, "flow.mmd"), "flowchart TD\nA[開始]-->B[結束]\n");
  assert.equal((await done(id, "flow-analyst")).isError, false);
});

test("done tester：缺白箱／黑箱、項目缺圖、圖不存在逐項回報，修正後通過並自動通過 test-evidence", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "tester");
  await writeFile(path.join(dir, "test.md"), "## 黑箱\n## 白箱\n## 測試：登入\n沒有圖\n## 測試：登出\n![a](evidence/none.png)\n");
  const bad = await done(id, "tester");
  assert.equal(bad.isError, true);
  assert.ok(bad.json.problems.some((p) => p.includes("之前")));
  assert.ok(bad.json.problems.some((p) => p.includes("缺證據圖")));
  assert.ok(bad.json.problems.some((p) => p.includes("圖檔不存在")));
  await fulfil(dir, "tester");
  const ok = await done(id, "tester");
  assert.equal(ok.isError, false);
  assert.equal((await env.store.readStatus(id)).work_item_progress.gates["test-evidence"].decision, "passed");
});
