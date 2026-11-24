// 批次 2M-a：高風險需求的「回滾演練證據」檢查（test.md 的「## 回滾演練」節）。缺證據擋住交件。
import test from "node:test";
import assert from "node:assert/strict";
import { checkDrillEvidenceText } from "../dist/workflow/drill-evidence-check.js";

const GOOD = [
  "## 回滾演練", "",
  "- 演練日期：2026-11-20",
  "- 演練結果：通過",
  "- 演練耗時：12 分鐘",
  "![演練畫面](evidence/drill.png)", "",
].join("\n");
const withBody = (body) => `## 白箱\n\n## 回滾演練\n\n${body}\n\n## 黑箱\n`;
const ok = () => null;

test("日期、結果、耗時、證據圖都有就合格", () => {
  assert.deepEqual(checkDrillEvidenceText(GOOD, { validateImage: ok }), []);
});

test("缺整節：指出要加「## 回滾演練」", () => {
  const r = checkDrillEvidenceText("## 白箱\n\n## 黑箱\n", { validateImage: ok });
  assert.equal(r.length, 1);
  assert.match(r[0], /缺少.*回滾演練/);
});

test("缺項目逐項指出；寫法容許粗體與全半形冒號", () => {
  const r = checkDrillEvidenceText(withBody("**演練日期：** 2026-11-20\n![x](evidence/a.png)"), { validateImage: ok });
  assert.ok(r.some((x) => x.includes("演練結果")) && r.some((x) => x.includes("演練耗時")), JSON.stringify(r));
  assert.deepEqual(checkDrillEvidenceText(withBody("演練日期: 2026-11-20\n- **演練結果**：通過\n演練耗時：3 秒\n![x](evidence/a.png)"), { validateImage: ok }), []);
});

test("日期格式要 YYYY-MM-DD；耗時要有數字", () => {
  const bad = checkDrillEvidenceText(withBody("- 演練日期：昨天\n- 演練結果：通過\n- 演練耗時：很快\n![x](evidence/a.png)"), { validateImage: ok });
  assert.ok(bad.some((x) => /日期.*YYYY-MM-DD/.test(x)) && bad.some((x) => /耗時.*數字/.test(x)), JSON.stringify(bad));
});

test("演練結果必須是通過；失敗不能交件", () => {
  const r = checkDrillEvidenceText(withBody("- 演練日期：2026-11-20\n- 演練結果：失敗\n- 演練耗時：5 分鐘\n![x](evidence/a.png)"), { validateImage: ok });
  assert.ok(r.some((x) => /演練結果.*通過/.test(x)), JSON.stringify(r));
});

test("沒有證據圖、或圖片路徑不合法，都不合格", () => {
  const noImg = checkDrillEvidenceText(withBody("- 演練日期：2026-11-20\n- 演練結果：通過\n- 演練耗時：5 分鐘"), { validateImage: ok });
  assert.ok(noImg.some((x) => x.includes("證據圖")), JSON.stringify(noImg));
  const badImg = checkDrillEvidenceText(GOOD, { validateImage: () => "檔案不存在" });
  assert.ok(badImg.some((x) => x.includes("檔案不存在")));
});

test("接線：高風險的測試交件檢查演練證據；一般需求不檢查", async () => {
  const { mkdtemp, writeFile, mkdir } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { checkDeliverables } = await import("../dist/work-item-actions/deliverables.js");
  const { getBuiltinWorkflow } = await import("../dist/workflow/stage-order.js");
  const def = getBuiltinWorkflow("spec-first");
  const dir = await mkdtemp(path.join(os.tmpdir(), "drill-"));
  await mkdir(path.join(dir, "evidence"));
  await writeFile(path.join(dir, "evidence", "a.png"), Buffer.from([137, 80, 78, 71, 1, 2, 3]));
  const test1 = (extra) => ["## 白箱", "", "## 測試：登入", "![圖](evidence/a.png)", "", extra, "## 黑箱", ""].join("\n");
  await writeFile(path.join(dir, "test.md"), test1(""));
  const hi = await checkDeliverables(dir, "tester", def, { highRisk: true });
  assert.ok(hi.some((p) => p.includes("回滾演練證據檢查未通過")), JSON.stringify(hi));
  const lo = await checkDeliverables(dir, "tester", def, {});
  assert.ok(!lo.some((p) => p.includes("演練")), "一般需求不該檢查演練");
  await writeFile(path.join(dir, "test.md"), test1(GOOD.replace("evidence/drill.png", "evidence/a.png")));
  const ok2 = await checkDeliverables(dir, "tester", def, { highRisk: true });
  assert.ok(!ok2.some((p) => p.includes("演練")), JSON.stringify(ok2));
});
