// S6：SA 截圖檢查（checkSaImages）。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTmpDir, removeDir } from "./helpers/support.mjs";

const { checkSaImages, SA_IMAGE_CONVENTION_TEXT } = await import("../dist/workflow/sa-image-check.js");
const root = makeTmpDir("dpm-saimg-");
after(() => removeDir(root));

let n = 0;
/** 建立工作項目；files: { 相對路徑: 內容 }，sa 為 01-sa.md 內容（undefined 則不建）。 */
function item(sa, files = {}) {
  const dir = path.join(root, `w${n++}`);
  fs.mkdirSync(path.join(dir, "sa-images"), { recursive: true });
  if (sa !== undefined) fs.writeFileSync(path.join(dir, "01-sa.md"), sa);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}
const PNG = "x";

test("全部合規", () => {
  const dir = item("## 功能：匯出\n![圖](sa-images/a.png)\n### 功能：查詢\n![圖](sa-images/B.JPG)\n", { "sa-images/a.png": PNG, "sa-images/B.JPG": PNG });
  const r = checkSaImages(dir);
  assert.deepEqual([r.ok, r.functionCount, r.violations.length], [true, 2, 0]);
});

test("缺圖引用", () => {
  const r = checkSaImages(item("## 功能：匯出\n只有文字\n"));
  assert.equal(r.ok, false);
  assert.match(r.violations[0].reason, /缺圖引用/);
  assert.deepEqual([r.violations[0].heading, r.violations[0].line], ["功能：匯出", 1]);
});

test("圖檔不存在", () => {
  const r = checkSaImages(item("## 功能：A\n![x](sa-images/none.png)\n"));
  assert.match(r.violations[0].reason, /圖檔不存在/);
  assert.equal(r.violations[0].line, 2);
});

test("空檔案", () => {
  const r = checkSaImages(item("## 功能：A\n![x](sa-images/e.png)\n", { "sa-images/e.png": "" }));
  assert.match(r.violations[0].reason, /空檔案/);
});

test("副檔名錯誤", () => {
  const r = checkSaImages(item("## 功能：A\n![x](sa-images/a.gif)\n", { "sa-images/a.gif": PNG }));
  assert.match(r.violations[0].reason, /副檔名不允許/);
});

test("路徑穿越與絕對路徑", () => {
  const refs = ["sa-images/../secret.png", "../sa-images/a.png", "/etc/a.png", "C:/a.png", "sa-images\\a.png", "sa-images/%2e%2e/x.png", "other/a.png"];
  for (const ref of refs) {
    const r = checkSaImages(item(`## 功能：A\n![x](${ref})\n`, { "secret.png": PNG, "sa-images/a.png": PNG }));
    assert.equal(r.ok, false, ref);
    assert.match(r.violations[0].reason, /路徑不合法/, ref);
  }
});

test("外部網址", () => {
  for (const ref of ["https://example.com/a.png", "http://example.com/a.png", "//example.com/a.png", "data:image/png;base64,AAAA"]) {
    const r = checkSaImages(item(`## 功能：A\n![x](${ref})\n`));
    assert.match(r.violations[0].reason, /路徑不合法/, ref);
  }
});

test("純後端免附圖", () => {
  const r = checkSaImages(item("## 功能：排程（純後端）\n文字\n"));
  assert.deepEqual([r.ok, r.functionCount], [true, 1]);
});

test("多個功能標題各自檢查", () => {
  const dir = item("## 功能：A\n![x](sa-images/a.png)\n## 功能：B\n無圖\n## 功能：C\n![x](sa-images/zz.png)\n", { "sa-images/a.png": PNG });
  const r = checkSaImages(dir);
  assert.equal(r.functionCount, 3);
  assert.deepEqual(r.violations.map((v) => v.heading), ["功能：B", "功能：C"]);
});

test("巢狀標題範圍判定", () => {
  // 子標題（更深）的圖算在功能底下；同級標題之後的圖不算；非功能標題不計數
  const sa = "## 功能：A\n#### 細節\n![x](sa-images/a.png)\n## 功能：B\n### 功能：B-1\n![x](sa-images/a.png)\n## 其他\n![x](sa-images/a.png)\n## 功能：D\n# 總覽\n![x](sa-images/a.png)\n#### 功能：深層\n";
  const r = checkSaImages(item(sa, { "sa-images/a.png": PNG }));
  // A、B、B-1、D 共 4 個（#### 不是功能標題層級）
  assert.equal(r.functionCount, 4);
  // B 本身沒有圖但 B-1 範圍有圖 → B 缺圖；D 被 # 總覽 截斷 → 缺圖
  assert.deepEqual(r.violations.map((v) => v.heading), ["功能：B", "功能：D"]);
});

test("沒有功能標題", () => {
  const r = checkSaImages(item("## 概述\n#### 功能：太深\n"));
  assert.equal(r.ok, false);
  assert.equal(r.functionCount, 0);
  assert.match(r.violations[0].reason, /找不到任何功能標題（需以「功能」開頭）/);
});

test("01-sa.md 不存在", () => {
  assert.throws(() => checkSaImages(item(undefined)), /找不到 01-sa\.md/);
});

test("CRLF 換行與程式碼區塊略過", () => {
  const sa = "## 功能：A\r\n![x](sa-images/a.png)\r\n```\r\n## 功能：假\r\n```\r\n";
  const r = checkSaImages(item(sa, { "sa-images/a.png": PNG }));
  assert.deepEqual([r.ok, r.functionCount], [true, 1]);
});

test("約定說明字串含關鍵規則", () => {
  assert.match(SA_IMAGE_CONVENTION_TEXT, /（純後端）/);
  assert.match(SA_IMAGE_CONVENTION_TEXT, /sa-images\//);
});
