// 步驟 E：SD 新標準檢查。SD-範本.md 為合格樣本，違規樣本逐項測。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTmpDir, removeDir } from "./helpers/support.mjs";
import { SD_TEMPLATE, tableSchemaTemplates } from "./helpers/sasd-standard.mjs";

const { checkSdStructure, SD_TYPE_DECISIONS } = await import("../dist/workflow/sd-structure-check.js");
const { parseSdApis } = await import("../dist/workflow/sd-api-parse.js");
const { REUSE_DECISIONS } = await import("../dist/workflow/reuse-record-check.js");
const root = makeTmpDir("dpm-sd-");
after(() => removeDir(root));

const T = SD_TEMPLATE;
const has = (list, re) => list.some((x) => re.test(x));
/** 以 from 的第一處取代成 to；找不到就讓測試失敗，避免樣本沒真的改到。 */
function mut(from, to, text = T()) {
  assert.ok(text.includes(from), `樣本找不到：${from}`);
  return text.replace(from, to);
}
/** 建立含範本三份 TableSchema 的工作項目目錄。 */
function itemWithSchemas() {
  const dir = path.join(root, `w${fs.readdirSync(root).length}`);
  fs.mkdirSync(path.join(dir, "TableSchema"), { recursive: true });
  for (const [name, text] of Object.entries(tableSchemaTemplates())) fs.writeFileSync(path.join(dir, "TableSchema", `${name}.md`), text);
  return dir;
}

test("SD-範本.md 通過全部檢查（含 TableSchema 連結的檔案存在）", () => {
  assert.deepEqual(checkSdStructure(T()), []);
  assert.deepEqual(checkSdStructure(T(), itemWithSchemas()), []);
});

test("解析範本：兩支 API 各有 URL、METHOD、三層檔案與方法", () => {
  const apis = parseSdApis(T());
  assert.equal(apis.length, 2);
  assert.equal(apis[0].url, "/api/orders");
  assert.equal(apis[1].method, "GET");
  assert.deepEqual(apis[1].layers.Service, { file: "src/services/order-service.js", methods: ["exportOrders"] });
});

test("基本資料表：缺表、缺項目、程式代號空白", () => {
  const noTable = T().replace(/^\| 程式代號[\s\S]*?(?=## 版本管控歷程)/, "");
  assert.ok(has(checkSdStructure(noTable), /缺少程式基本資料表/));
  assert.ok(has(checkSdStructure(mut("| 程式類別 | 查＋Excel 匯出".replace("查", "查詢"), "| 類別 | 查詢＋Excel 匯出")), /缺少項目：程式類別/));
  assert.ok(has(checkSdStructure(mut("| 程式代號 | orders-export |", "| 程式代號 |  |")), /「程式代號」沒有填/));
});

test("版本管控歷程：缺章節、表頭錯", () => {
  assert.ok(has(checkSdStructure(mut("## 版本管控歷程", "## 修訂紀錄")), /版本管控歷程/));
  assert.ok(has(checkSdStructure(mut("| 版次 | 發行日期 |", "| 版本 | 發行日期 |")), /版本管控歷程/));
});

test("目錄與章節順序：缺目錄、目錄空、規格說明與 API 說明順序顛倒", () => {
  assert.ok(has(checkSdStructure(mut("## 目錄", "## 索引")), /缺少必備章節「## 目錄」/));
  const emptyToc = T().replace(/## 目錄[\s\S]*?(?=## 規格說明)/, "## 目錄\n\n");
  assert.ok(has(checkSdStructure(emptyToc), /「目錄」是空的/));
  const t = T();
  const i = t.indexOf("## 規格說明\n");
  const j = t.indexOf("## API 說明\n");
  const swapped = t.slice(0, i) + t.slice(j) + "\n" + t.slice(i, j);
  assert.ok(has(checkSdStructure(swapped), /順序不對/));
});

test("規格說明四節：缺節與順序", () => {
  assert.ok(has(checkSdStructure(mut("### 3. 共用方法清單", "### 3. 其他說明")), /缺少「### 共用方法清單」/));
  const t = T();
  const a = t.indexOf("### 3. 共用方法清單");
  const b = t.indexOf("### 4. 共用回應與錯誤碼");
  const c = t.indexOf("## API 說明");
  const swapped = t.slice(0, a) + t.slice(b, c) + t.slice(a, b) + t.slice(c);
  assert.ok(has(checkSdStructure(swapped), /順序不對/));
});

test("各表表頭固定", () => {
  assert.ok(has(checkSdStructure(mut("| Table | 功能 | 說明 | 結構文件 |", "| Table | 功能 | 說明 | 欄位 |")), /「使用資料表」必須是表格，表頭固定為/));
  assert.ok(has(checkSdStructure(mut("| 前端功能 | 觸發時機 |", "| 功能 | 觸發時機 |")), /「前端功能與API對應表」必須是表格/));
  assert.ok(has(checkSdStructure(mut("| 共用方法 | 位置 | 類型 |", "| 方法 | 位置 | 類型 |")), /「共用方法清單」必須是表格/));
  assert.ok(has(checkSdStructure(mut("| 檢核位置 | 前端提示位置 |", "| 檢核位置 | 提示位置 |")), /「共用回應與錯誤碼」必須是表格/));
  assert.ok(has(checkSdStructure(mut("| 檢核位置 | 前端提示位置 |", "| 前端提示位置 |")), /「共用回應與錯誤碼」必須是表格/));
});

test("前端功能與 API 對應表至少一列", () => {
  const empty = T().replace(/(\| 前端功能 \| 觸發時機[^\n]*\n\| ---[^\n]*\n)(\|[^\n]*\n)+/, "$1");
  assert.ok(has(checkSdStructure(empty), /「前端功能與API對應表」至少要有一列/));
});

test("使用資料表：連結缺、格式錯、錨點錯、檔案或小節不存在", () => {
  const L = "[members 資料表結構](TableSchema/members.md#members)";
  assert.ok(has(checkSdStructure(mut(L, "members 資料表結構")), /members）的結構文件要用相對路徑連結/));
  assert.ok(has(checkSdStructure(mut("(TableSchema/members.md#members)", "(TableSchema/members.md)")), /格式不對，必須是 TableSchema\/<文件>\.md#members/));
  assert.ok(has(checkSdStructure(mut("(TableSchema/members.md#members)", "(https://x.example/members.md)")), /格式不對/));
  assert.ok(has(checkSdStructure(mut("(TableSchema/members.md#members)", "(TableSchema/members.md#orders)")), /錨點 #orders 必須是 #members/));
  const dir = itemWithSchemas();
  assert.deepEqual(checkSdStructure(T(), dir), []);
  fs.rmSync(path.join(dir, "TableSchema", "orders.md"));
  const r = checkSdStructure(T(), dir);
  assert.equal(r.length, 2);
  assert.match(r[0], /orders）連到的 TableSchema\/orders\.md 不存在/);
  const dir2 = itemWithSchemas();
  const f = path.join(dir2, "TableSchema", "orders.md");
  fs.writeFileSync(f, fs.readFileSync(f, "utf-8").replace("## 資料表：order_items", "## 資料表：other"));
  assert.match(checkSdStructure(T(), dir2).join("\n"), /order_items）連到的 TableSchema\/orders\.md 沒有「## 資料表：order_items」小節/);
});

test("沒有動資料庫（工作項目沒有 TableSchema）：使用資料表可以沒有列，其他情況仍要有列", () => {
  const noRows = T().replace(/(\| Table \| 功能[^\n]*\n\| ---[^\n]*\n)(\|[^\n]*\n)+/, "$1");
  const emptyDir = path.join(root, "nodb");
  fs.mkdirSync(emptyDir, { recursive: true });
  assert.deepEqual(checkSdStructure(noRows, emptyDir), []);
  assert.ok(has(checkSdStructure(noRows), /「使用資料表」至少要有一列/));
  assert.ok(has(checkSdStructure(noRows, itemWithSchemas()), /「使用資料表」至少要有一列/));
});

test("共用方法清單：類型值、說明、位置", () => {
  assert.ok(has(checkSdStructure(mut("| 新建共用 | 兩支 API 的控制層 | 取得", "| 新增 | 兩支 API 的控制層 | 取得")), /類型「新增」不合法/));
  assert.ok(has(checkSdStructure(mut("| 重用 | 兩支 API 的控制層 | 取得".replace("重用", "新建共用"), "| 重用 | 兩支 API 的控制層 | 取得")), /類型「重用」不合法/));
  assert.ok(has(checkSdStructure(mut("| 新建專用 | 匯出 API 的服務層 | 組出 Excel 檔，只有匯出使用 |", "| 新建專用 | 匯出 API 的服務層 |  |")), /類型為「新建專用」，說明必填/));
  assert.ok(has(checkSdStructure(mut("| src/auth.js |", "| 認證模組 |")), /位置要寫檔案路徑/));
});

test("共用方法類型與 impl 重用檢查紀錄的決定值對應", () => {
  assert.deepEqual(Object.keys(SD_TYPE_DECISIONS).sort(), ["新建專用", "新建共用", "重用既有"].sort());
  for (const decisions of Object.values(SD_TYPE_DECISIONS)) for (const d of decisions) assert.ok(REUSE_DECISIONS.includes(d), d);
  assert.deepEqual(SD_TYPE_DECISIONS["新建共用"], ["新建"]);
  assert.ok(SD_TYPE_DECISIONS["重用既有"].includes("重用"));
});

test("共用回應與錯誤碼：檢核位置與前端提示位置必填，HTTP 為三位數字", () => {
  assert.ok(has(checkSdStructure(mut("| 前端即時檢核；後端再檢核 | 日期欄位下方 |\n| 400 | DATE_ORDER", "|  | 日期欄位下方 |\n| 400 | DATE_ORDER")), /「檢核位置」沒有填/));
  assert.ok(has(checkSdStructure(mut("| 僅後端 | 前往登入頁 |", "| 僅後端 |  |")), /「前端提示位置」沒有填/));
  assert.ok(has(checkSdStructure(mut("| 401 | UNAUTHORIZED", "| 四百一 | UNAUTHORIZED")), /HTTP 要是三位數字/));
});

test("API 說明：每支 API 的必備項目逐項擋", () => {
  const cases = [
    ["**URL:** /api/orders\n", "", /缺少 \*\*URL:\*\*/],
    ["**METHOD:** GET\n\n**Controller:** src/controllers/orders-controller.js ── listOrders()", "**Controller:** src/controllers/orders-controller.js ── listOrders()", /缺少 \*\*METHOD:\*\*/],
    ["**Controller:** src/controllers/orders-controller.js ── listOrders()\n\n", "", /缺少 \*\*Controller:\*\*/],
    ["**Service:** src/services/order-service.js ── listOrders()\n\n", "", /缺少 \*\*Service:\*\*（服務層/],
    ["**Repository:** src/repositories/order-repository.js ── findOrderRows()\n\n**使用的共用方法:** getMemberId、validateRange（內含", "**使用的共用方法:** getMemberId、validateRange（內含", /缺少 \*\*Repository:\*\*（查詢層/],
    ["src/services/order-service.js ── listOrders()", "src/services/order-service.js", /\*\*Service:\*\* 格式不對/],
    ["src/services/order-service.js ── listOrders()", "orders ── listOrders()", /\*\*Service:\*\* 格式不對/],
    ["src/services/order-service.js ── listOrders()", "src/services/order-service.js ── listOrders", /\*\*Service:\*\* 格式不對/],
    ["**使用的共用方法:** getMemberId、validateRange（內含 isValidDateString、nextDay、diffDays）、findOrderRows、sendError\n\n", "", /缺少 \*\*使用的共用方法:\*\*/],
    ["getMemberId、validateRange（內含", "getMemberId、noSuchHelper、validateRange（內含", /不在「共用方法清單」裡：noSuchHelper/],
  ];
  for (const [from, to, re] of cases) assert.ok(has(checkSdStructure(mut(from, to)), re), String(re));
});

test("API 說明：缺 INPUT、業務邏輯、OUTPUT、空小節、INPUT 表頭錯、沒有任何 API", () => {
  const t = T();
  const first = t.indexOf("#### INPUT");
  const second = t.indexOf("#### 業務邏輯");
  assert.ok(has(checkSdStructure(t.slice(0, first) + t.slice(second)), /缺少「#### INPUT」/));
  assert.ok(has(checkSdStructure(mut("#### 業務邏輯\n1. 先確認登入，未登入回 401。", "#### 邏輯說明\n1. 先確認登入，未登入回 401。")), /缺少「#### 業務邏輯」/));
  assert.ok(has(checkSdStructure(mut("#### OUTPUT\n\n| ElementName", "#### 回傳\n\n| ElementName")), /缺少「#### OUTPUT」/));
  assert.ok(has(checkSdStructure(t.replace(/#### 業務邏輯\n[\s\S]*?(?=#### OUTPUT)/, "#### 業務邏輯\n\n")), /「業務邏輯」小節是空的/));
  assert.ok(has(checkSdStructure(mut("| ElementName | ElementType | 必填 | 對應 DB 欄位 | 註解 |", "| Name | Type | 必填 | 對應 DB 欄位 | 註解 |")), /INPUT 表頭必須是/));
  assert.ok(has(checkSdStructure(t.slice(0, t.indexOf("### 1. 查詢訂單列表"))), /沒有任何 API/));
  assert.ok(has(checkSdStructure(t.slice(0, t.indexOf("## API 說明"))), /缺少必備章節「## API說明」/));
});

test("禁用字詞：不確定寫法逐一擋", () => {
  for (const w of ["選用", "視情況", "可能", "或許", "必要時", "暫定", "待定", "TBD"]) {
    const r = checkSdStructure(mut("匯出時發生非預期錯誤", `匯出時${w}發生非預期錯誤`));
    assert.ok(has(r, new RegExp(`不確定寫法「${w}」`)), w);
  }
  assert.ok(has(checkSdStructure(mut("前端即時檢核；後端再檢核 | 日期欄位下方 |\n| 400 | DATE_ORDER", "前端先行檢查（選用） | 日期欄位下方 |\n| 400 | DATE_ORDER")), /選用/));
});

test("禁用字詞：內部過程檔名逐一擋", () => {
  for (const f of ["02-db.sql", "spec-check.md", "sa-notes.md", "impl-fe.md", "impl-be.md", "verify.md", "test.md", "dup-report.md", ".dev-pipeline/work-items", "01-sa.md", "tech-stack.md"]) {
    assert.ok(has(checkSdStructure(mut("匯出時發生非預期錯誤", `匯出時發生非預期錯誤，詳見 ${f}`)), /內部檔名/), f);
  }
  assert.deepEqual(checkSdStructure(mut("匯出時發生非預期錯誤", "匯出時發生非預期錯誤（依 order-test-helper 的 latest 記錄）")), []);
});

test("後設句與欄位定義不可出現", () => {
  assert.ok(has(checkSdStructure(mut("## 目錄", "本文件的目的是說明訂單匯出規格。\n\n## 目錄")), /後設句/));
  assert.ok(has(checkSdStructure(mut("## 目錄", "這裡只列使用到的資料表。\n\n## 目錄")), /後設句/));
  assert.ok(has(checkSdStructure(mut("---\n\n### 2. 匯出訂單 Excel", "| # | 欄位 | 型別 | PK | 說明 |\n|:-:|---|---|:-:|---|\n| 1 | id | INTEGER | ✓ | 編號 |\n\n---\n\n### 2. 匯出訂單 Excel")), /欄位定義/));
  assert.ok(has(checkSdStructure(mut("## 目錄", "CREATE TABLE a (id INT);\n\n## 目錄")), /欄位定義/));
});

test("合格樣本的變化：英文標題前綴編號與 API 說明有無空格都可", () => {
  assert.deepEqual(checkSdStructure(mut("## API 說明", "## API說明")), []);
  assert.deepEqual(checkSdStructure(mut("## 規格說明", "## 一、規格說明")), []);
});
