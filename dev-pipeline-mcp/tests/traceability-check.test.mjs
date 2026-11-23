// 批次 2M-a：追溯矩陣（高風險需求）。SA 基本資料表的「需求編號」→ SD 每支 API 的「對應需求」→ 測試報告的「對應需求」。
// 需求沒有對應 SD：擋住；需求沒有對應測試：只警告（測試報告可標「不需測試」並寫理由）。
import test from "node:test";
import assert from "node:assert/strict";
import { checkSaRequirementIds, parseSaRequirementIds, checkSdTraceability, testTraceabilityWarnings, traceabilityMatrix } from "../dist/workflow/traceability-check.js";

const sa = (idCell) => ["# 登入：需求說明", "", "| 項目 | 內容 |", "| --- | --- |", "| 功能名稱 | 登入 |", ...(idCell === undefined ? [] : [`| 需求編號 | ${idCell} |`]), "| 文件版次 | 0.1 |", "", "## 功能目的", "登入。", ""].join("\n");
const api = (title, req) => [`### ${title}`, "", "**URL:** /api/x", "", "**METHOD:** POST", ...(req === undefined ? [] : ["", `**對應需求：** ${req}`]), ""].join("\n");
const sd = (...apis) => ["# SD", "", "## 規格說明", "", "## API 說明", "", ...apis, "## 上線與回滾", "x", ""].join("\n");
const tests = (...blocks) => ["## 白箱", "", ...blocks, "## 黑箱", ""].join("\n");
const tcase = (name, req) => [`## 測試：${name}`, ...(req === undefined ? [] : [`**對應需求：** ${req}`]), "![圖](evidence/a.png)", ""].join("\n");

test("SA：需求編號列可寫多個，逗號、頓號、空白分隔，去重", () => {
  assert.deepEqual(parseSaRequirementIds(sa("R1, R2、R3 R1")).ids, ["R1", "R2", "R3"]);
  assert.deepEqual(checkSaRequirementIds(sa("R1")), []);
});

test("SA：沒有需求編號列、內容空白、格式不對都不合格", () => {
  assert.ok(checkSaRequirementIds(sa(undefined)).some((p) => /需求編號/.test(p)));
  assert.ok(checkSaRequirementIds(sa("")).some((p) => /需求編號/.test(p)));
  const bad = checkSaRequirementIds(sa("R1, 登入, r2"));
  assert.ok(bad.some((p) => p.includes("登入")) && bad.some((p) => p.includes("r2")), JSON.stringify(bad));
});

test("SD：每支 API 都要有「對應需求」，且每個需求至少被一支 API 對應", () => {
  assert.deepEqual(checkSdTraceability(sd(api("登入", "R1"), api("登出", "R2")), ["R1", "R2"]), []);
  const missingLabel = checkSdTraceability(sd(api("登入", "R1"), api("登出", undefined)), ["R1"]);
  assert.ok(missingLabel.some((p) => p.includes("登出") && p.includes("對應需求")), JSON.stringify(missingLabel));
  const uncovered = checkSdTraceability(sd(api("登入", "R1")), ["R1", "R2"]);
  assert.ok(uncovered.some((p) => p.includes("R2") && /沒有.*API/.test(p)), JSON.stringify(uncovered));
});

test("SD：對應了 SA 沒有的需求編號也不合格", () => {
  const r = checkSdTraceability(sd(api("登入", "R1, R9")), ["R1"]);
  assert.ok(r.some((p) => p.includes("R9")), JSON.stringify(r));
});

test("SD：SA 沒有需求編號時略過（由 SA 檢查回報），不重複報錯", () => {
  assert.deepEqual(checkSdTraceability(sd(api("登入", undefined)), []), []);
});

test("SD：「對應需求」寫法容許粗體冒號在內外、全形半形冒號", () => {
  assert.deepEqual(checkSdTraceability(sd("### 登入\n\n**對應需求:** R1\n"), ["R1"]), []);
  assert.deepEqual(checkSdTraceability(sd("### 登入\n\n**對應需求**：R1\n"), ["R1"]), []);
});

test("測試：沒有對應需求的測試項目、對應了不存在的編號、需求沒有任何測試，都只是警告", () => {
  const ok = testTraceabilityWarnings(tests(tcase("登入成功", "R1"), tcase("登出", "R2")), ["R1", "R2"]);
  assert.deepEqual(ok, []);
  const w = testTraceabilityWarnings(tests(tcase("登入成功", "R1"), tcase("亂測", undefined), tcase("另一個", "R7")), ["R1", "R2"]);
  assert.ok(w.some((x) => x.includes("亂測")), JSON.stringify(w));
  assert.ok(w.some((x) => x.includes("R7")));
  assert.ok(w.some((x) => x.includes("R2") && /沒有.*測試/.test(x)));
});

test("測試：標「不需測試」並寫理由的需求不警告；沒寫理由仍警告", () => {
  const withReason = tests(tcase("登入成功", "R1"), "**不需測試：** R2 純文字說明，沒有可測行為", "");
  assert.deepEqual(testTraceabilityWarnings(withReason, ["R1", "R2"]), []);
  const noReason = tests(tcase("登入成功", "R1"), "**不需測試：** R2", "");
  assert.ok(testTraceabilityWarnings(noReason, ["R1", "R2"]).some((x) => x.includes("R2")));
});

test("SA 沒有需求編號時，測試追溯略過", () => {
  assert.deepEqual(testTraceabilityWarnings(tests(tcase("登入", undefined)), []), []);
});

test("追溯矩陣：需求 → SD API → 測試的對照表", () => {
  const m = traceabilityMatrix(["R1", "R2"], sd(api("登入", "R1, R2")), tests(tcase("登入成功", "R1")));
  assert.deepEqual(m, [
    { id: "R1", apis: ["登入"], tests: ["登入成功"] },
    { id: "R2", apis: ["登入"], tests: [] },
  ]);
});

async function tmpWith(files) {
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(os.tmpdir(), "trace-"));
  for (const [f, c] of Object.entries(files)) await writeFile(path.join(dir, f), c);
  return dir;
}

test("接線：高風險的 SA 交件才檢查需求編號；一般需求不檢查", async () => {
  const { checkDeliverables } = await import("../dist/work-item-actions/deliverables.js");
  const { getBuiltinWorkflow } = await import("../dist/workflow/stage-order.js");
  const def = getBuiltinWorkflow("spec-first");
  const dir = await tmpWith({ "01-sa.md": sa(undefined) });
  const hi = await checkDeliverables(dir, "sa-analyst", def, { highRisk: true });
  assert.ok(hi.some((p) => p.includes("SA 需求編號檢查未通過")), JSON.stringify(hi));
  const lo = await checkDeliverables(dir, "sa-analyst", def, {});
  assert.ok(!lo.some((p) => p.includes("需求編號")), "一般需求不該檢查需求編號");
  const ok = await tmpWith({ "01-sa.md": sa("R1") });
  assert.ok(!(await checkDeliverables(ok, "sa-analyst", def, { highRisk: true })).some((p) => p.includes("需求編號")));
});

test("接線：高風險的 SD 交件檢查追溯（擋住）；一般需求不檢查", async () => {
  const { checkDeliverables } = await import("../dist/work-item-actions/deliverables.js");
  const { getBuiltinWorkflow } = await import("../dist/workflow/stage-order.js");
  const def = getBuiltinWorkflow("spec-first");
  const dir = await tmpWith({ "01-sa.md": sa("R1, R2"), "03-sd.md": sd(api("登入", "R1")) });
  const hi = await checkDeliverables(dir, "sd-analyst", def, { highRisk: true });
  assert.ok(hi.some((p) => p.includes("SD 追溯檢查未通過") && p.includes("R2")), JSON.stringify(hi));
  const lo = await checkDeliverables(dir, "sd-analyst", def, {});
  assert.ok(!lo.some((p) => p.includes("追溯")), "一般需求不該有追溯檢查");
});

test("接線：高風險的測試工程師交件附追溯警告；一般需求與其他角色不附", async () => {
  const { testTraceabilityWarningsFor } = await import("../dist/work-item-actions/traceability-warnings.js");
  const dir = await tmpWith({ "01-sa.md": sa("R1, R2"), "test.md": tests(tcase("登入成功", "R1")) });
  const w = await testTraceabilityWarningsFor(dir, "tester", true);
  assert.ok(w.some((x) => x.includes("追溯矩陣") && x.includes("R2")), JSON.stringify(w));
  assert.deepEqual(await testTraceabilityWarningsFor(dir, "tester", false), []);
  assert.deepEqual(await testTraceabilityWarningsFor(dir, "verifier", true), []);
});
