// 批次 2M-a：高風險需求的 SD「上線與回滾」節檢查（純文字檢查，回傳違規清單，空陣列＝合格）。
import test from "node:test";
import assert from "node:assert/strict";
import { checkSdRollout, ROLLOUT_ITEMS } from "../dist/workflow/sd-rollout-check.js";

const GOOD = [
  "## API 說明", "", "（略）", "",
  "## 上線與回滾", "",
  "- 上線步驟：先執行 DB migration 再部署程式，不需停機。",
  "- DB 變更回滾：t 資料表新增欄位 status，回滾時執行 ALTER TABLE t DROP COLUMN status。",
  "- 功能開關：以設定 feature.login.enabled 控制，預設可關閉。",
  "- 回滾判斷：上線後觀察錯誤率與 P95 延遲，錯誤率超過 1% 或 P95 超過 500 毫秒就回滾。",
  "- 相容性：新舊版本同時運行時，API 欄位只新增不刪除，向下相容。",
  "",
].join("\n");
const sdWith = (body) => `## API 說明\n\n（略）\n\n## 上線與回滾\n\n${body}\n`;

test("五個項目都寫了就合格", () => {
  assert.deepEqual(checkSdRollout(GOOD, { needsDbRollback: true }), []);
  assert.deepEqual(ROLLOUT_ITEMS.map((i) => i.name), ["上線步驟", "DB 變更回滾", "功能開關", "回滾判斷", "相容性"]);
});

test("缺少整節：指出要加「## 上線與回滾」", () => {
  const r = checkSdRollout("## API 說明\n\n（略）\n", { needsDbRollback: true });
  assert.equal(r.length, 1);
  assert.match(r[0], /缺少.*上線與回滾/);
});

test("缺少某項目：逐項指出", () => {
  const body = GOOD.split("\n").filter((l) => !l.startsWith("- 功能開關") && !l.startsWith("- 相容性")).join("\n");
  const r = checkSdRollout(body, { needsDbRollback: true });
  assert.equal(r.length, 2);
  assert.ok(r.some((x) => x.includes("功能開關")) && r.some((x) => x.includes("相容性")));
});

test("沒有資料表異動時，不要求「DB 變更回滾」", () => {
  const body = GOOD.split("\n").filter((l) => !l.startsWith("- DB 變更回滾")).join("\n");
  assert.deepEqual(checkSdRollout(body, { needsDbRollback: false }), []);
  assert.equal(checkSdRollout(body, { needsDbRollback: true }).length, 1);
});

test("項目只有名稱沒有內容：視為沒寫", () => {
  const body = GOOD.split("\n").map((l) => (l.startsWith("- 上線步驟") ? "- 上線步驟：" : l)).join("\n");
  const r = checkSdRollout(body, { needsDbRollback: true });
  assert.ok(r.some((x) => x.includes("上線步驟")), JSON.stringify(r));
});

test("寫法：粗體標籤、全形半形冒號、不同項目符號都接受", () => {
  const body = [
    "**上線步驟：** 先 DB 後程式，不停機。",
    "* DB 變更回滾: 還原欄位。",
    "- **功能開關**：可關閉。",
    "回滾判斷：錯誤率超過 2% 就回滾。",
    "相容性：向下相容。",
  ].join("\n");
  assert.deepEqual(checkSdRollout(sdWith(body), { needsDbRollback: true }), []);
});

test("回滾判斷要有門檻數字", () => {
  const body = GOOD.replace(/- 回滾判斷：.*/, "- 回滾判斷：上線後觀察錯誤率，太高就回滾。");
  const r = checkSdRollout(body, { needsDbRollback: true });
  assert.equal(r.length, 1);
  assert.match(r[0], /回滾判斷.*(門檻|數字)/);
});

test("不可逆：DB 變更回滾寫「不可逆」要同時寫理由", () => {
  const noReason = GOOD.replace(/- DB 變更回滾：.*/, "- DB 變更回滾：不可逆");
  assert.ok(checkSdRollout(noReason, { needsDbRollback: true }).some((x) => /不可逆.*理由/.test(x)));
  const withReason = GOOD.replace(/- DB 變更回滾：.*/, "- DB 變更回滾：不可逆，因為刪除舊欄位後資料無法還原，上線前已完整備份。");
  assert.deepEqual(checkSdRollout(withReason, { needsDbRollback: true }), []);
});

test("只看「上線與回滾」這一節，別節出現的同名字樣不算", () => {
  const text = "## 規格說明\n\n- 上線步驟：寫在別節\n- 回滾判斷：1%\n\n## 上線與回滾\n\n沒寫項目\n";
  assert.ok(checkSdRollout(text, { needsDbRollback: false }).length >= 4);
});

test("接線：高風險的 SD 交件才檢查上線與回滾；一般需求完全不檢查", async () => {
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { checkDeliverables } = await import("../dist/work-item-actions/deliverables.js");
  const { getBuiltinWorkflow } = await import("../dist/workflow/stage-order.js");
  const def = getBuiltinWorkflow("spec-first");
  const dir = await mkdtemp(path.join(os.tmpdir(), "rollout-"));
  await writeFile(path.join(dir, "03-sd.md"), "## API 說明\n\n（略）\n");
  const hi = await checkDeliverables(dir, "sd-analyst", def, { highRisk: true });
  assert.ok(hi.some((p) => p.includes("SD 上線與回滾檢查未通過")), JSON.stringify(hi));
  const lo = await checkDeliverables(dir, "sd-analyst", def, {});
  assert.ok(!lo.some((p) => p.includes("上線與回滾")), "一般需求不該有上線與回滾檢查");
  await writeFile(path.join(dir, "03-sd.md"), GOOD);
  const ok = await checkDeliverables(dir, "sd-analyst", def, { highRisk: true });
  assert.ok(!ok.some((p) => p.includes("上線與回滾")), JSON.stringify(ok));
});

test("不可逆偵測：DB 變更回滾寫了不可逆才算；沒寫或寫還原方式不算", async () => {
  const { hasIrreversibleDbChange } = await import("../dist/workflow/sd-rollout-check.js");
  assert.equal(hasIrreversibleDbChange(GOOD), false);
  assert.equal(hasIrreversibleDbChange(GOOD.replace(/- DB 變更回滾：.*/, "- DB 變更回滾：不可逆，刪除欄位後無法還原，上線前完整備份。")), true);
  assert.equal(hasIrreversibleDbChange("## API 說明\n\n沒有上線與回滾節\n"), false);
  assert.equal(hasIrreversibleDbChange("## 規格說明\n\n- DB 變更回滾：不可逆\n\n## 上線與回滾\n\n- 上線步驟：x\n"), false);
});

test("不可逆確認：高風險且 SD 含不可逆時，AI 不可代確認 sd-confirm；本人確認、一般需求、其他關卡不受影響", async () => {
  const { requireHumanForIrreversible } = await import("../dist/work-item-actions/irreversible-guard.js");
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(os.tmpdir(), "irrev-"));
  await writeFile(path.join(dir, "03-sd.md"), GOOD.replace(/- DB 變更回滾：.*/, "- DB 變更回滾：不可逆，刪除欄位後無法還原，上線前完整備份。"));
  const hi = { high_risk: true };
  await assert.rejects(requireHumanForIrreversible(dir, hi, "sd-confirm", "agent", "confirmed"), /不可逆.*本人/);
  await requireHumanForIrreversible(dir, hi, "sd-confirm", "human", "confirmed");
  await requireHumanForIrreversible(dir, hi, "sd-confirm", "agent", "rejected");
  await requireHumanForIrreversible(dir, hi, "sa-confirm", "agent", "confirmed");
  await requireHumanForIrreversible(dir, {}, "sd-confirm", "agent", "confirmed");
  await writeFile(path.join(dir, "03-sd.md"), GOOD);
  await requireHumanForIrreversible(dir, hi, "sd-confirm", "agent", "confirmed");
});
