// S10 C1～C2（原 C3 已由 sd-structure-check 取代）：重用防線的程式檢查。
import test from "node:test";
import assert from "node:assert/strict";
import { checkImpactReuseList, checkReuseRecord, extractSection } from "../dist/workflow/reuse-record-check.js";

const HEAD = "| 搜尋關鍵字 | 找到的候選 | 決定 | 理由 |\n| --- | --- | --- | --- |";
const rec = (...rows) => `# impl\n## 重用檢查紀錄\n${HEAD}\n${rows.join("\n")}\n## 其他\n文字`;

test("C1 合法：重用、擴充既有、新建（有理由）、無新增（有理由）", () => {
  const t = rec("| exportExcel | src/ExcelUtil.java:ExcelUtil.write | 重用 | |", "| 日期格式 | DateUtil.fmt | 擴充既有 | 加時區參數 |", "| 對帳 | 無 | 新建 | 專案內找不到 |", "| 匯出 | 無 | 無新增 | 只改設定 |");
  assert.deepEqual(checkReuseRecord(t, "impl-be.md"), []);
});

test("C1 缺節、只有「無」、沒有表格、沒有資料列", () => {
  assert.match(checkReuseRecord("# x\n沒有", "impl-fe.md")[0], /缺少「## 重用檢查紀錄」/);
  assert.match(checkReuseRecord("## 重用檢查紀錄\n無\n", "impl-fe.md")[0], /只寫「無」/);
  assert.match(checkReuseRecord("## 重用檢查紀錄\n- 有搜尋\n", "impl-fe.md")[0], /markdown 表格/);
  assert.match(checkReuseRecord(rec(), "impl-fe.md")[0], /沒有任何資料列/);
});

test("C1 逐項違規：欄位不足、關鍵字空白、決定不合法、新建與無新增缺理由", () => {
  const v = checkReuseRecord(rec("| a | b | 重用 |", "| | b | 重用 | c |", "| a | b | 自己寫 | c |", "| a | b | 新建 | |", "| a | b | 無新增 | |"), "impl-be.md");
  assert.equal(v.length, 5);
  assert.ok(v[0].includes("第 1 列") && v[0].includes("欄位不足"));
  assert.ok(v[1].includes("搜尋關鍵字空白"));
  assert.ok(v[2].includes("不合法"));
  assert.ok(v[3].includes("理由必填") && v[4].includes("理由必填"));
});

test("C1 標題在程式碼區塊內不算；下一個同級標題截斷", () => {
  assert.ok(checkReuseRecord("```\n## 重用檢查紀錄\n```\n", "impl-fe.md")[0].includes("缺少"));
  assert.equal(extractSection(rec("| a | b | 重用 | |"), "重用檢查紀錄").includes("其他"), false);
});

test("C2 可重用清單：缺節、空、只有無、無位置、合法", () => {
  assert.match(checkImpactReuseList("# i\n")[0], /缺少/);
  assert.match(checkImpactReuseList("## 可重用清單\n\n## 下一節\nx")[0], /空的/);
  assert.match(checkImpactReuseList("## 可重用清單\n無")[0], /不能只寫「無」/);
  assert.match(checkImpactReuseList("## 可重用清單\n- 匯出工具，很好用\n")[0], /沒有檔案位置/);
  assert.match(checkImpactReuseList("## 可重用清單\n只有一段文字沒有條列")[0], /條列或表格/);
  const ok = "## 可重用清單\n- ExcelUtil（src/main/ExcelUtil.java）：匯出\n- 已搜尋：日期轉換，未找到\n";
  assert.deepEqual(checkImpactReuseList(ok), []);
  assert.deepEqual(checkImpactReuseList("## 可重用清單\n| 名稱 | 位置 |\n| --- | --- |\n| 工具 | src/a/Util.ts |\n"), []);
});
