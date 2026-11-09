// work_item done：S8 流程圖／測試證據檢查、S10 重用防線檢查接進交件檢查。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setupEnv, fulfil, runUntil, REUSE_RECORD_OK } from "./helpers/work-item-env.mjs";

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

test("done frontend-engineer／backend-engineer：缺重用檢查紀錄或決定不合法不通過；通過後 implementation-content 自動通過", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "frontend-engineer");
  await writeFile(path.join(dir, "impl-fe.md"), "FE\n");
  const none = await done(id, "frontend-engineer");
  assert.equal(none.isError, true);
  assert.ok(none.json.problems.some((p) => p.includes("缺少「## 重用檢查紀錄」")));
  await writeFile(path.join(dir, "impl-fe.md"), "## 重用檢查紀錄\n| 搜尋關鍵字 | 找到的候選 | 決定 | 理由 |\n| --- | --- | --- | --- |\n| a | b | 自己寫 | c |\n| | b | 新建 | |\n");
  const bad = await done(id, "frontend-engineer");
  assert.equal(bad.isError, true);
  assert.ok(bad.json.problems.some((p) => p.includes("不合法")));
  assert.ok(bad.json.problems.some((p) => p.includes("搜尋關鍵字空白")));
  assert.ok(bad.json.problems.some((p) => p.includes("理由必填")));
  await fulfil(dir, "frontend-engineer");
  assert.equal((await done(id, "frontend-engineer")).isError, false);
  await writeFile(path.join(dir, "impl-be.md"), `BE\n${REUSE_RECORD_OK.replace("| exportExcel | ExcelUtil.write | 重用 | |", "| 匯出 | 無 | 無新增 | 只改設定 |")}`);
  assert.equal((await done(id, "backend-engineer")).isError, false);
  assert.equal((await env.store.readStatus(id)).work_item_progress.gates["implementation-content"].by, "agent");
});

test("done baseline-survey：impact.md 缺可重用清單或只寫無不通過；sd-analyst 缺重用與共用設計不通過", async () => {
  const { id, dir } = await env.create({ baseline: "brownfield" });
  await fulfil(dir, "baseline-survey");
  await writeFile(path.join(dir, "impact.md"), "影響\n## 可重用清單\n無\n");
  const bad = await done(id, "baseline-survey");
  assert.equal(bad.isError, true);
  assert.ok(bad.json.problems.some((p) => p.includes("不能只寫「無」")));
  await writeFile(path.join(dir, "impact.md"), "影響\n## 可重用清單\n- 共用工具，沒寫位置\n");
  assert.ok((await done(id, "baseline-survey")).json.problems.some((p) => p.includes("沒有檔案位置")));
  await fulfil(dir, "baseline-survey");
  assert.equal((await done(id, "baseline-survey")).isError, false);
  const { id: id2, dir: dir2 } = await env.create({ baseline: "greenfield" });
  await runUntil(env, id2, dir2, "sd-analyst");
  await writeFile(path.join(dir2, "03-sd.md"), "SD\n");
  const sd = await done(id2, "sd-analyst");
  assert.equal(sd.isError, true);
  assert.ok(sd.json.problems.some((p) => p.includes("缺少「## 重用與共用設計」")));
});
