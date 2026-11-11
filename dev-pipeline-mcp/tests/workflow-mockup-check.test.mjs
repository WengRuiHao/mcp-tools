// 步驟 C：mockup 可操作性檢查。範例 mockup-狀態切換範例.html 為合格樣本；靜態頁、外網資源、缺標記等各做違規樣本。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTmpDir, removeDir } from "./helpers/support.mjs";
import { MOCKUP_TEMPLATE } from "./helpers/sasd-standard.mjs";

const { checkMockupDir, checkMockupHtml, MOCKUP_MAX_BYTES } = await import("../dist/workflow/mockup-check.js");
const root = makeTmpDir("dpm-mockup-");
after(() => removeDir(root));

let n = 0;
/** files: { 相對於 sa-mockup 的路徑: 內容 }；回傳工作項目目錄。 */
function item(files) {
  const dir = path.join(root, `w${n++}`);
  fs.mkdirSync(path.join(dir, "sa-mockup"), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, "sa-mockup", rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}
const GOOD = `<!doctype html><html><body data-demo-states="normal,loading,success,failed,empty"><button id="b">送出</button><script>document.getElementById("b").addEventListener("click",function(){});</script></body></html>`;
const has = (list, re) => list.some((x) => re.test(x));

test("範例 mockup-狀態切換範例.html 是合格樣本", () => {
  assert.deepEqual(checkMockupDir(item({ "orders.html": MOCKUP_TEMPLATE() })), []);
  assert.match(MOCKUP_TEMPLATE(), /data-demo-states=/);
});

test("精簡合格樣本；on 事件屬性也算事件處理", () => {
  assert.deepEqual(checkMockupDir(item({ "a.html": GOOD })), []);
  const inline = `<html><body data-demo-states="a"><button onclick="x()">k</button><script>function x(){}</script></body></html>`;
  assert.deepEqual(checkMockupDir(item({ "a.html": inline })), []);
});

test("sa-mockup/ 沒有 html", () => {
  assert.match(checkMockupDir(item({ "style.css": "body{}" }))[0], /至少要有一個 html/);
});

test("資料夾不存在由一般交件檢查回報，這裡不重複", () => {
  assert.deepEqual(checkMockupDir(path.join(root, "不存在")), []);
});

test("靜態頁面（沒有 script）", () => {
  const r = checkMockupDir(item({ "a.html": `<html><body data-demo-states="a"><p>靜態</p></body></html>` }));
  assert.ok(has(r, /沒有 <script>/));
});

test("有 script 但沒有事件處理", () => {
  const r = checkMockupDir(item({ "a.html": `<html><body data-demo-states="a"><script>const x = 1;</script></body></html>` }));
  assert.ok(has(r, /沒有事件處理/));
});

test("外部 script 檔（相對路徑）內的事件處理算數", () => {
  const dir = item({ "a.html": `<html><body data-demo-states="a"><script src="app.js"></script></body></html>`, "app.js": `document.addEventListener("click", () => {});` });
  assert.deepEqual(checkMockupDir(dir), []);
  const missing = item({ "a.html": `<html><body data-demo-states="a"><script src="none.js"></script></body></html>` });
  assert.ok(has(checkMockupDir(missing), /沒有事件處理/));
});

test("外部網路資源：src、href、@import、url()、協定相對網址都擋", () => {
  const bad = {
    "src": `<script src="https://cdn.example.com/a.js"></script>`,
    "href": `<link rel="stylesheet" href="http://example.com/a.css">`,
    "a href": `<a href="https://example.com">連結</a>`,
    "@import": `<style>@import url("https://fonts.example.com/x.css");</style>`,
    "url()": `<style>body{background:url(https://example.com/a.png)}</style>`,
    "協定相對": `<img src="//example.com/a.png">`,
  };
  for (const [name, frag] of Object.entries(bad)) {
    const html = GOOD.replace("</body>", `${frag}</body>`);
    assert.ok(has(checkMockupDir(item({ "a.html": html })), /外部網路資源/), name);
  }
});

test("允許 data: 與相對路徑，註解內的網址不算，svg xmlns 不算", () => {
  const ok = GOOD.replace("</body>", `<img src="data:image/png;base64,AAAA"><a href="other.html">下一頁</a><link rel="stylesheet" href="style.css"><svg xmlns="http://www.w3.org/2000/svg"></svg><!-- https://example.com/x.png --><style>a{background:url(data:image/png;base64,AA)}</style></body>`);
  assert.deepEqual(checkMockupDir(item({ "a.html": ok })), []);
});

test("缺 data-demo-states 標記", () => {
  const r = checkMockupDir(item({ "a.html": GOOD.replace(' data-demo-states="normal,loading,success,failed,empty"', "") }));
  assert.ok(has(r, /缺少 data-demo-states/));
});

test("檔案太大", () => {
  const big = GOOD.replace("</body>", `<!-- -->${"x".repeat(MOCKUP_MAX_BYTES)}</body>`);
  assert.ok(has(checkMockupHtml(big, "a.html"), /超過大小上限/));
});

test("多個 html：逐檔檢查並帶檔名；子資料夾也檢查", () => {
  const r = checkMockupDir(item({ "good.html": GOOD, "sub/bad.html": "<html></html>" }));
  assert.ok(r.every((x) => x.startsWith("sa-mockup/sub/bad.html")));
  assert.equal(r.length, 2);
});
