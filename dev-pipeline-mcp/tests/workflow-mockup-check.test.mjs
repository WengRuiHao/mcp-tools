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
const GOOD = `<!doctype html><html><body data-demo-states="normal,loading,success,failed,empty"><h2>本次變更說明</h2><button id="b">送出</button><script>document.getElementById("b").addEventListener("click",function(){});</script></body></html>`;
const has = (list, re) => list.some((x) => re.test(x));

test("範例 mockup-狀態切換範例.html 是合格樣本", () => {
  assert.deepEqual(checkMockupDir(item({ "orders.html": MOCKUP_TEMPLATE() })), []);
  assert.match(MOCKUP_TEMPLATE(), /data-demo-states=/);
});

test("精簡合格樣本；on 事件屬性也算事件處理", () => {
  assert.deepEqual(checkMockupDir(item({ "a.html": GOOD })), []);
  const inline = `<html><body data-demo-states="normal,loading,success,failed,empty"><h2>本次變更說明</h2><button onclick="x()">k</button><script>function x(){}</script></body></html>`;
  assert.deepEqual(checkMockupDir(item({ "a.html": inline })), []);
});

test("sa-mockup/ 沒有 html", () => {
  assert.match(checkMockupDir(item({ "style.css": "body{}" }))[0], /至少要有一個 html/);
});

test("資料夾不存在由一般交件檢查回報，這裡不重複", () => {
  assert.deepEqual(checkMockupDir(path.join(root, "不存在")), []);
});

test("靜態頁面（沒有 script）", () => {
  const r = checkMockupDir(item({ "a.html": `<html><body data-demo-states="normal,loading,success,failed,empty"><h2>本次變更說明</h2><p>靜態</p></body></html>` }));
  assert.ok(has(r, /沒有 <script>/));
});

test("有 script 但沒有事件處理", () => {
  const r = checkMockupDir(item({ "a.html": `<html><body data-demo-states="normal,loading,success,failed,empty"><h2>本次變更說明</h2><script>const x = 1;</script></body></html>` }));
  assert.ok(has(r, /沒有事件處理/));
});

test("外部 script 檔（相對路徑）內的事件處理算數", () => {
  const dir = item({ "a.html": `<html><body data-demo-states="normal,loading,success,failed,empty"><h2>本次變更說明</h2><script src="app.js"></script></body></html>`, "app.js": `document.addEventListener("click", () => {});` });
  assert.deepEqual(checkMockupDir(dir), []);
  const missing = item({ "a.html": `<html><body data-demo-states="normal,loading,success,failed,empty"><h2>本次變更說明</h2><script src="none.js"></script></body></html>` });
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

test("data-demo-states 必須涵蓋五種狀態：中英文名稱皆可，缺哪個說明哪個", () => {
  const withStates = (v) => GOOD.replace("normal,loading,success,failed,empty", v);
  for (const ok of ["正常,載入中,成功,失敗,沒有資料", "Normal, LOADING, Success, Error, No-Data", "normal,loading,success,fail,empty,extra-state", "normal，loading，success，failure，無資料"]) {
    assert.deepEqual(checkMockupHtml(withStates(ok), "a.html"), [], ok);
  }
  const r = checkMockupHtml(withStates("normal,failed"), "a.html");
  assert.equal(r.length, 1);
  assert.match(r[0], /缺少必備狀態：載入中、成功、沒有資料/);
  assert.match(checkMockupHtml(withStates("normal,loading,success,failed"), "a.html")[0], /缺少必備狀態：沒有資料/);
  assert.match(checkMockupHtml(withStates("loading,success,failed,empty"), "a.html")[0], /缺少必備狀態：正常/);
  assert.match(checkMockupHtml(withStates(""), "a.html")[0], /缺少必備狀態：正常、載入中、成功、失敗、沒有資料/);
  assert.match(checkMockupHtml(GOOD.replace('"normal,loading,success,failed,empty"', "'normal'"), "a.html")[0], /缺少必備狀態：載入中/);
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
  assert.equal(r.length, 3); // 缺 script、缺 data-demo-states、缺本次變更說明
});

const withCss = (css) => GOOD.replace("<body", `<style>\n${css}\n</style><body`);

test("缺「本次變更說明」區塊會退回；標題需為 h1～h6，寫「無既有行為變更」即可", () => {
  const noBlock = GOOD.replace("<h2>本次變更說明</h2>", "");
  assert.ok(has(checkMockupHtml(noBlock, "a.html"), /缺少「本次變更說明」區塊/));
  assert.ok(has(checkMockupHtml(GOOD.replace("<h2>本次變更說明</h2>", "<p>本次變更說明</p>"), "a.html"), /缺少「本次變更說明」/));
  assert.deepEqual(checkMockupHtml(GOOD.replace("<h2>本次變更說明</h2>", "<h3 class=\"x\"><span>本次變更說明</span>（無既有行為變更）</h3>"), "a.html"), []);
});

test("標示疊在元件上：偽元素 content 含新增／變更／修改，訊息含行號與改法", () => {
  const r = checkMockupHtml(withCss('.f::after{\n  content:"新增";\n  position:absolute}'), "a.html");
  assert.equal(r.length, 1);
  assert.match(r[0], /第 \d+ 行 CSS/);
  assert.match(r[0], /偽元素/);
  assert.match(r[0], /獨立的「本次變更說明」區塊/);
  assert.ok(has(checkMockupHtml(withCss(".x:before{content:'已修改'}"), "a.html"), /偽元素/));
});

test("標示疊在元件上：標示用 class 搭配 absolute／fixed 加負偏移，或虛線框", () => {
  assert.ok(has(checkMockupHtml(withCss(".badge-new{position:absolute;top:-8px;right:-8px}"), "a.html"), /絕對定位加負偏移/));
  assert.ok(has(checkMockupHtml(withCss(".is-changed{position:fixed;left:-4px}"), "a.html"), /絕對定位加負偏移/));
  assert.ok(has(checkMockupHtml(withCss(".changed{outline:2px dashed red}"), "a.html"), /虛線框/));
  assert.ok(has(checkMockupHtml(withCss(".new-field{border:1px dashed #f00}"), "a.html"), /虛線框/));
});

test("低誤判：一般偽元素、一般 label／表單 class、非負偏移、說明區塊虛線框都放行；行號對得上原檔", () => {
  for (const css of [
    '.req::after{content:"*";color:red}',
    ".label{position:absolute;top:-6px}",
    ".tooltip{position:absolute;top:-6px}",
    ".badge{position:absolute;top:4px;right:4px}",
    ".change-notes{border:1px dashed #94a3b8}",
    "/* .new{position:absolute;top:-1px} */",
  ]) assert.deepEqual(checkMockupHtml(withCss(css), "a.html"), [], css);
  const html = `<!doctype html>\n<!-- 兩行\n註解 -->\n${withCss(".new{position:absolute;top:-2px}")}`;
  const hit = checkMockupHtml(html, "a.html").find((x) => /絕對定位/.test(x));
  const line = Number(/第 (\d+) 行/.exec(hit)[1]);
  assert.equal(html.split("\n")[line - 1].trim(), ".new{position:absolute;top:-2px}");
});
