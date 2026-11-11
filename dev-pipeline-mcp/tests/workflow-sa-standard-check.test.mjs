// 步驟 B：SA 新標準檢查。SA-範本.md（搭配其圖片）必須通過所有 SA 檢查；每種違規各一個樣本。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTmpDir, removeDir } from "./helpers/support.mjs";
import { SA_TEMPLATE, STANDARD_DIR } from "./helpers/sasd-standard.mjs";

const { checkSaStandard } = await import("../dist/workflow/sa-standard-check.js");
const { checkSaImages } = await import("../dist/workflow/sa-image-check.js");
const { checkSaNoCode } = await import("../dist/workflow/sa-no-code-check.js");
const root = makeTmpDir("dpm-sastd-");
after(() => removeDir(root));

let n = 0;
/** 建立工作項目：01-sa.md 為 sa，sa-images/ 為範本的所有圖。 */
function item(sa) {
  const dir = path.join(root, `w${n++}`);
  fs.mkdirSync(path.join(dir, "sa-images"), { recursive: true });
  for (const f of fs.readdirSync(path.join(STANDARD_DIR, "sa-images"))) fs.copyFileSync(path.join(STANDARD_DIR, "sa-images", f), path.join(dir, "sa-images", f));
  fs.writeFileSync(path.join(dir, "01-sa.md"), sa);
  return dir;
}
/** 三項 SA 檢查的所有違規說明。 */
function all(sa) {
  const dir = item(sa);
  const img = checkSaImages(dir).violations.map((v) => v.reason);
  const code = checkSaNoCode(dir).violations.map((v) => v.reason);
  return { std: checkSaStandard(sa), img, code, flat: [...checkSaStandard(sa), ...img, ...code] };
}
const T = () => SA_TEMPLATE();
const has = (list, re) => list.some((x) => re.test(x));

test("SA-範本.md（搭配 sa-images/ 的圖）通過所有 SA 檢查", () => {
  const r = all(T());
  assert.deepEqual(r.flat, []);
});

test("範本的狀態圖都在 sa-images/ 內", () => {
  const imgs = fs.readdirSync(path.join(STANDARD_DIR, "sa-images")).sort();
  assert.deepEqual(imgs, ["orders-page.png", "state-empty.png", "state-failed.png", "state-order.png", "state-range.png", "state-required.png", "state-toomany.png"]);
  assert.ok(!fs.existsSync(path.join(STANDARD_DIR, "states")));
  assert.ok(!T().includes("states/"));
});

test("缺必備章節（功能目的、畫面、操作說明）", () => {
  for (const name of ["功能目的", "畫面", "操作說明"]) {
    const sa = T().replace(new RegExp(`^## ${name}$`, "m"), `## 其他${name}說`);
    assert.ok(has(all(sa).std, new RegExp(`缺少必備章節「## ${name}」`)) || name === "畫面", name);
  }
  const noGoal = T().replace("## 功能目的", "## 背景");
  assert.ok(has(checkSaStandard(noGoal), /缺少必備章節「## 功能目的」/));
});

test("章節順序錯誤", () => {
  const sa = T().replace("## 操作說明", "## 操作X").replace("## 功能目的", "## 操作說明").replace("## 操作X", "## 功能目的");
  assert.ok(has(checkSaStandard(sa), /章節順序不對/));
});

test("空洞章節", () => {
  const sa = T().replace(/## 操作說明\n[\s\S]*?\n## 日期區間規則/, "## 操作說明\n\n## 日期區間規則");
  assert.ok(has(checkSaStandard(sa), /「操作說明」章節是空的/));
});

test("編號前綴的章節標題仍算（一、功能目的／2. 畫面／（三）操作說明）", () => {
  const sa = T().replace("## 功能目的", "## 一、功能目的").replace("## 畫面", "## 2. 畫面").replace("## 操作說明", "## （三）操作說明");
  assert.deepEqual(all(sa).flat, []);
});

test("缺基本資料表或項目", () => {
  const noTable = T().replace(/\| 項目 \| 內容 \|[\s\S]*?\n\n(?=## 版本)/, "");
  assert.ok(has(checkSaStandard(noTable), /缺少基本資料表/));
  const noName = T().replace("| 功能名稱 | 會員匯出訂單 Excel |\n", "");
  assert.ok(has(checkSaStandard(noName), /基本資料表缺少項目：功能名稱/));
});

test("缺版本管控歷程", () => {
  const sa = T().replace(/## 版本管控歷程[\s\S]*?(?=## 功能目的)/, "");
  assert.ok(has(checkSaStandard(sa), /缺少「## 版本管控歷程」/));
});

test("版本管控歷程內容違規（空洞詞）", () => {
  const sa = T().replace(/\| 0\.2 \| 2026\/11\/10 \| 補充：[^|]*\|/, "| 0.2 | 2026/11/10 | 修正 |");
  assert.ok(has(checkSaStandard(sa), /修訂說明空白或只有/));
});

test("沒有任何規則表格", () => {
  const head = T().split("## 日期區間規則")[0];
  const noRules = head + "## 提示\n**錯誤**\n\n![x](sa-images/state-order.png)\n";
  assert.ok(has(checkSaStandard(noRules), /沒有任何規則表格/));
});

test("禁用詞逐一擋下", () => {
  for (const w of ["已確認的決定", "依據附錄", "純後端", "共用畫面元件", "mockup", "API", "SQL", "前端工程師", "後端工程師", "交給前端", "通知前端"]) {
    const sa = T().replace("## 操作說明\n", `## 操作說明\n這一步需要${w}處理。\n`);
    assert.ok(has(checkSaStandard(sa), new RegExp(`禁用詞「${w}」`)), w);
  }
});

test("禁用詞：英文詞不誤傷其他英文字（RAPID、Mockups 不在詞界內才算）", () => {
  const sa = T().replace("## 操作說明\n", "## 操作說明\nRAPID 與 SQLite 不算。\n");
  assert.ok(!has(checkSaStandard(sa), /禁用詞/));
  const hit = T().replace("## 操作說明\n", "## 操作說明\n呼叫 api 取得資料。\n");
  assert.ok(has(checkSaStandard(hit), /禁用詞「API」/));
});

test("內部檔名逐一擋下", () => {
  for (const w of ["01-sa", "02-db", "03-sd", "spec-check", "sa-notes", ".dev-pipeline"]) {
    const sa = T().replace("## 操作說明\n", `## 操作說明\n詳見 ${w}.md。\n`);
    assert.ok(has(checkSaStandard(sa), new RegExp(`內部檔名「${w.replace(".", "\\.")}」`)), w);
  }
});

test("sa-images/ 的圖片路徑不算內部檔名", () => {
  assert.ok(!has(checkSaStandard(T()), /內部檔名/));
});

test("後設句", () => {
  for (const s of ["本節說明這裡為什麼要這樣寫。", "這裡只列主要規則。", "此處只列幾項。"]) {
    const sa = T().replace("## 操作說明\n", `## 操作說明\n${s}\n`);
    assert.ok(has(checkSaStandard(sa), /後設句/), s);
  }
});

test("提示章節：狀態標籤後面缺圖", () => {
  const sa = T().replace("**起日晚於迄日**\n\n![起日晚於迄日](sa-images/state-order.png)\n", "**起日晚於迄日**\n\n起日不可晚於迄日。\n");
  const r = checkSaStandard(sa);
  assert.ok(has(r, /提示狀態「起日晚於迄日」後面沒有畫面截圖/));
  assert.equal(r.filter((x) => /沒有畫面截圖/.test(x)).length, 1);
});

test("提示章節：標籤結尾寫（無畫面）才免附圖（範本即為此寫法）", () => {
  assert.ok(T().includes("**尚未登入或登入已失效（無畫面）**："));
  assert.deepEqual(checkSaStandard(T()), []);
  const half = T().replace("（無畫面）", "(無畫面)");
  assert.deepEqual(checkSaStandard(half), []);
});

test("提示章節：用冒號接說明文字規避附圖必須被擋", () => {
  for (const evade of ["**尚未登入或登入已失效**：前往登入頁，登入後回到「我的訂單」頁面。", "**尚未登入或登入已失效**: 前往登入頁。", "**尚未登入或登入已失效**（無畫面）前往登入頁。", "**尚未登入或登入已失效（無畫面）說明**：前往登入頁。"]) {
    const sa = T().replace(/\*\*尚未登入或登入已失效（無畫面）\*\*：.*/, evade);
    const r = checkSaStandard(sa);
    assert.ok(has(r, /提示狀態「尚未登入或登入已失效.*」後面沒有畫面截圖/), evade);
    assert.ok(has(r, /（無畫面）/), "訊息要說明豁免寫法");
  }
});

test("提示章節：沒有任何標籤", () => {
  const sa = T().replace(/## 按下「匯出 Excel」之後的提示[\s\S]*$/, "## 按下「匯出 Excel」之後的提示\n沒有特別的提示。\n");
  assert.ok(has(checkSaStandard(sa), /沒有用粗體標籤列出任何提示狀態/));
});

test("提示的圖片無效（不存在、空檔、路徑穿越、外部網址、副檔名）由圖片檢查擋下", () => {
  const bad = {
    不存在: "sa-images/none.png",
    路徑穿越: "sa-images/../secret.png",
    外部網址: "https://example.com/a.png",
    副檔名: "sa-images/state-order.gif",
  };
  for (const [name, ref] of Object.entries(bad)) {
    const sa = T().replace("sa-images/state-order.png", ref);
    const r = all(sa);
    assert.ok(r.img.length > 0, name);
  }
  const dir = item(T());
  fs.writeFileSync(path.join(dir, "sa-images", "state-order.png"), "");
  assert.ok(has(checkSaImages(dir).violations.map((v) => v.reason), /空檔案/));
});

test("畫面沒有任何圖：圖片檢查擋下（不再要求「功能：」標題）", () => {
  const dir = item("# 標題\n沒有圖\n");
  const r = checkSaImages(dir);
  assert.equal(r.ok, false);
  assert.match(r.violations[0].reason, /至少要有一張圖/);
  assert.equal(checkSaImages(item(T())).ok, true);
});

test("程式碼與 SQL 仍被擋，「## 依據附錄」不再有例外", () => {
  const sa = T().replace("## 操作說明\n", "## 依據附錄\n```java\nint x;\n```\nSELECT a FROM t\n## 操作說明\n");
  const r = all(sa);
  assert.ok(r.code.length >= 2);
  assert.ok(!r.code.some((x) => x.includes("依據附錄")));
});
