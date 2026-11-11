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

test("全部合規（不需要功能標題）", () => {
  const dir = item("# 需求\n![圖](sa-images/a.png)\n## 提示\n![圖](sa-images/B.JPG)\n", { "sa-images/a.png": PNG, "sa-images/B.JPG": PNG });
  const r = checkSaImages(dir);
  assert.deepEqual([r.ok, r.imageCount, r.violations.length], [true, 2, 0]);
});

test("沒有任何圖：至少要有一張", () => {
  const r = checkSaImages(item("## 功能：匯出\n只有文字\n"));
  assert.equal(r.ok, false);
  assert.match(r.violations[0].reason, /至少要有一張圖/);
  assert.equal(r.imageCount, 0);
});

test("圖檔不存在，違規帶所在標題與行號", () => {
  const r = checkSaImages(item("## 畫面\n![x](sa-images/none.png)\n"));
  assert.match(r.violations[0].reason, /圖檔不存在/);
  assert.deepEqual([r.violations[0].line, r.violations[0].heading], [2, "畫面"]);
});

test("空檔案", () => {
  const r = checkSaImages(item("![x](sa-images/e.png)\n", { "sa-images/e.png": "" }));
  assert.match(r.violations[0].reason, /空檔案/);
});

test("副檔名錯誤", () => {
  const r = checkSaImages(item("![x](sa-images/a.gif)\n", { "sa-images/a.gif": PNG }));
  assert.match(r.violations[0].reason, /副檔名不允許/);
});

test("路徑穿越與絕對路徑", () => {
  const refs = ["sa-images/../secret.png", "../sa-images/a.png", "/etc/a.png", "C:/a.png", "sa-images\\a.png", "sa-images/%2e%2e/x.png", "other/a.png"];
  for (const ref of refs) {
    const r = checkSaImages(item(`![x](${ref})\n`, { "secret.png": PNG, "sa-images/a.png": PNG }));
    assert.equal(r.ok, false, ref);
    assert.match(r.violations[0].reason, /路徑不合法/, ref);
  }
});

test("外部網址", () => {
  for (const ref of ["https://example.com/a.png", "http://example.com/a.png", "//example.com/a.png", "data:image/png;base64,AAAA"]) {
    const r = checkSaImages(item(`![x](${ref})\n`));
    assert.match(r.violations[0].reason, /路徑不合法/, ref);
  }
});

test("所有圖片引用逐一檢查：一好兩壞回報兩項", () => {
  const r = checkSaImages(item("![x](sa-images/a.png)\n![x](sa-images/nope.png)\n![x](sa-images/e.png)\n", { "sa-images/a.png": PNG, "sa-images/e.png": "" }));
  assert.equal(r.imageCount, 3);
  assert.equal(r.violations.length, 2);
});

test("程式碼區塊內的圖片語法不算", () => {
  const r = checkSaImages(item("```\n![x](sa-images/a.png)\n```\n"));
  assert.equal(r.ok, false);
  assert.equal(r.imageCount, 0);
});

test("01-sa.md 不存在", () => {
  assert.throws(() => checkSaImages(item(undefined)), /找不到 01-sa\.md/);
});

test("CRLF 換行", () => {
  const r = checkSaImages(item("## 畫面\r\n![x](sa-images/a.png)\r\n", { "sa-images/a.png": PNG }));
  assert.deepEqual([r.ok, r.imageCount], [true, 1]);
});

test("約定說明字串含關鍵規則，且不再有功能標題與純後端", () => {
  assert.match(SA_IMAGE_CONVENTION_TEXT, /sa-images\//);
  assert.match(SA_IMAGE_CONVENTION_TEXT, /至少要有一張/);
  assert.doesNotMatch(SA_IMAGE_CONVENTION_TEXT, /純後端|功能標題/);
});