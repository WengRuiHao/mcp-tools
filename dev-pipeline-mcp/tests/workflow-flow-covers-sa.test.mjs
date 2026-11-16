// 第三批第 3 項：流程圖對 SA 功能的覆蓋檢查（警告級）。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkFlowCoversSa, extractSaFeatures, findFeaturesMissingInFlow, normalizeForMatch } from "../dist/workflow/flow-covers-sa-check.js";

const SA_OPS = `# X 系統分析書

## 操作說明

| 步驟 | 操作 | 系統反應 |
| --- | --- | --- |
| 1 | 進入「我的訂單」頁面 | 顯示「訂單列表」 |
| 2 | 按下「匯出 Excel」 | 按鈕變「匯出中…」 |
`;
const FLOW_ALL = `flowchart TD\n  A["進入我的訂單頁面"] --> B["按下 匯出 Excel"]\n`;

function withDir(sa, flow, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "flowsa-"));
  try {
    if (sa !== null) writeFileSync(path.join(dir, "01-sa.md"), sa);
    if (flow !== null) writeFileSync(path.join(dir, "flow.mmd"), flow);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("全覆蓋：沒有警告（忽略空白與標點）", () => {
  assert.deepEqual(findFeaturesMissingInFlow(SA_OPS, FLOW_ALL), []);
  assert.deepEqual(withDir(SA_OPS, FLOW_ALL, checkFlowCoversSa), []);
});

test("缺功能：列出流程圖找不到的功能名稱，只看操作欄、不看系統反應欄", () => {
  const flow = `flowchart TD\n  A["進入我的訂單頁面"] --> B["結束"]\n`;
  const w = withDir(SA_OPS, flow, checkFlowCoversSa);
  assert.equal(w.length, 1);
  assert.ok(w[0].includes("「匯出 Excel」") && !w[0].includes("訂單列表") && !w[0].includes("我的訂單」"));
});

test("不同寫法：「功能」章節以三級標題、清單、表格第一欄列出", () => {
  const heads = "## 功能\n\n### 匯出報表\n說明\n\n### 寄送通知\n說明\n";
  const list = "## 功能清單\n\n- 匯出報表\n- 1. 寄送通知\n";
  const table = "## 功能說明\n\n| 功能 | 說明 |\n| --- | --- |\n| 匯出報表 | x |\n| 寄送通知 | y |\n";
  for (const sa of [heads, list, table]) {
    assert.deepEqual(extractSaFeatures(sa), ["匯出報表", "寄送通知"], sa);
    assert.deepEqual(findFeaturesMissingInFlow(sa, "flowchart TD\nA[匯出報表]-->B[結束]"), ["寄送通知"]);
    assert.deepEqual(findFeaturesMissingInFlow(sa, "flowchart TD\nA[匯出 報表!]-->B[(寄送，通知)]"), []);
  }
});

test("功能章節優先於操作說明；子字串比對允許流程節點文字較長", () => {
  const sa = `## 功能\n\n### 匯出\n\n${SA_OPS}`;
  assert.deepEqual(extractSaFeatures(sa), ["匯出"]);
});

test("解析不出功能時不報：無功能章節、無操作表格、無「」名稱、太短名稱", () => {
  assert.deepEqual(findFeaturesMissingInFlow("# SA\n\n## 功能目的\n\n文字\n", "flowchart TD\nA-->B"), []);
  assert.deepEqual(findFeaturesMissingInFlow("## 操作說明\n\n沒有表格\n", "flowchart TD\nA-->B"), []);
  assert.deepEqual(findFeaturesMissingInFlow("## 操作說明\n\n| 步驟 | 操作 | 系統反應 |\n| --- | --- | --- |\n| 1 | 按下按鈕 | 完成 |\n", "flowchart TD\nA-->B"), []);
  assert.deepEqual(findFeaturesMissingInFlow("## 功能\n\n- 甲\n", "flowchart TD\nA-->B"), []);
});

test("缺檔或讀取失敗不報", () => {
  assert.deepEqual(withDir(SA_OPS, null, checkFlowCoversSa), []);
  assert.deepEqual(withDir(null, FLOW_ALL, checkFlowCoversSa), []);
  assert.deepEqual(checkFlowCoversSa(path.join(tmpdir(), "no-such-dir-flowsa")), []);
});

test("legacy 工作項目（flow.mmd 由流程分析師產出）同樣只靠目錄檔案，結果相同", () => {
  const flow = `flowchart TD\n  A["進入我的訂單頁面"]\n`;
  assert.equal(withDir(SA_OPS, flow, checkFlowCoversSa).length, 1);
});

test("normalizeForMatch 去掉空白、標點、markdown 記號並轉小寫", () => {
  assert.equal(normalizeForMatch("匯出 Excel…\n(**ok**)"), "匯出excelok");
});

test("S9 真實樣本（存在才跑）：不誤報", { skip: !existsSync("C:/Tool/s9-demo/.dev-pipeline/work-items/wi-20261113-001_會員匯出訂單_Excel/flow.mmd") }, () => {
  const dir = "C:/Tool/s9-demo/.dev-pipeline/work-items/wi-20261113-001_會員匯出訂單_Excel";
  assert.ok(readFileSync(path.join(dir, "01-sa.md"), "utf-8").length > 0);
  assert.deepEqual(checkFlowCoversSa(dir), []);
});
test("「功能目的」章節的清單不會被當成功能章節", () => {
  assert.deepEqual(extractSaFeatures("## 功能目的\n\n- 讓會員對帳\n- 保存資料\n"), []);
});
