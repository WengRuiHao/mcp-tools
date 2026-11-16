// 前端工程師交稿前自檢：impl-fe.md 的「## 交稿前自檢」表格檢查與說明書條目。
import test from "node:test";
import assert from "node:assert/strict";
import { checkFeSelfCheck, FE_SELF_CHECK_ITEMS } from "../dist/workflow/fe-self-check.js";
import { getSpecFirstRolePrompt } from "../dist/prompts-spec-first.js";

const HEAD = "| 項目 | 結果 | 說明 |\n| --- | --- | --- |";
const NAMES = ["文字去空白", "數值顯示", "狀態不誤清", "標籤用詞", "共用歸屬", "測試", "實機畫面"];
const full = () => NAMES.map((n) => `| ${n} | 已做 | 完成 |`);
const doc = (rows, extra = "") => `# impl\n## 交稿前自檢\n${HEAD}\n${rows.join("\n")}\n${extra}## 其他\n文字`;

test("七項都有標記且合法：通過", () => {
  assert.equal(FE_SELF_CHECK_ITEMS.length, 7);
  assert.deepEqual(checkFeSelfCheck(doc(full()), "impl-fe.md"), []);
});

test("不適用且有理由：通過", () => {
  const rows = full();
  rows[1] = "| 數值顯示 | 不適用 | 本功能沒有金額欄位 |";
  assert.deepEqual(checkFeSelfCheck(doc(rows), "impl-fe.md"), []);
});

test("缺少該節：被擋且訊息含格式範例", () => {
  const v = checkFeSelfCheck("# impl\n沒有", "impl-fe.md");
  assert.match(v[0], /缺少「## 交稿前自檢」/);
  assert.ok(v[0].includes("| 項目 | 結果 | 說明 |") && v[0].includes("| 文字去空白 | 已做 |"));
});

test("不是表格：被擋且附範例", () => {
  const v = checkFeSelfCheck("## 交稿前自檢\n- 都做了\n", "impl-fe.md");
  assert.match(v[0], /markdown 表格/);
  assert.ok(v[0].includes("| 項目 | 結果 | 說明 |"));
});

test("缺項：被擋並指出缺哪項", () => {
  const v = checkFeSelfCheck(doc(full().filter((r) => !r.includes("實機畫面"))), "impl-fe.md");
  assert.equal(v.length, 1);
  assert.match(v[0], /缺少自檢項目「實機」/);
  assert.ok(v[0].includes("| 項目 | 結果 | 說明 |"));
});

test("結果不是已做或不適用：被擋", () => {
  const rows = full();
  rows[0] = "| 文字去空白 | 好 | x |";
  const v = checkFeSelfCheck(doc(rows), "impl-fe.md");
  assert.ok(v.some((m) => m.includes("第 1 列") && m.includes("已做") && m.includes("不適用")));
});

test("不適用沒寫理由：被擋", () => {
  const rows = full();
  rows[2] = "| 狀態不誤清 | 不適用 | |";
  const v = checkFeSelfCheck(doc(rows), "impl-fe.md");
  assert.ok(v.some((m) => m.includes("第 3 列") && m.includes("理由")));
});

test("欄位不足：被擋", () => {
  const rows = full();
  rows[3] = "| 標籤用詞 |";
  assert.ok(checkFeSelfCheck(doc(rows), "impl-fe.md").some((m) => m.includes("欄位不足")));
});

test("標題在程式碼區塊內不算", () => {
  const t = "```\n## 交稿前自檢\n" + HEAD + "\n" + full().join("\n") + "\n```\n";
  assert.match(checkFeSelfCheck(t, "impl-fe.md")[0], /缺少/);
});

test("前端工程師說明書含自檢條目，且長度在上限內", () => {
  const p = getSpecFirstRolePrompt("frontend-engineer");
  for (const k of ["## 交稿前自檢", "| 項目 | 結果 | 說明 |", "trim", "Number.isFinite", "NaN", "390px", "不適用"]) assert.ok(p.includes(k), k);
  assert.ok(p.length >= 800 && p.length <= 3500, `長度 ${p.length}`);
});

test("後端工程師說明書不含前端自檢", () => {
  assert.ok(!getSpecFirstRolePrompt("backend-engineer").includes("交稿前自檢"));
});
