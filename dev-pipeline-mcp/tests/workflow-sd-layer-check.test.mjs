// 步驟 F：SD 三層落地檢查。用暫存專案目錄放 SD-範本.md 宣告的檔案，合格與違規（檔案不存在、方法找不到、缺層、對不上）逐項測。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTmpDir, removeDir } from "./helpers/support.mjs";
import { SD_TEMPLATE } from "./helpers/sasd-standard.mjs";

const { checkSdLayers, checkSdLayersInProject, checkImplLayerList } = await import("../dist/workflow/sd-layer-check.js");
const { checkSdStructure } = await import("../dist/workflow/sd-structure-check.js");
const root = makeTmpDir("dpm-layer-");
after(() => removeDir(root));

const SD = SD_TEMPLATE();
const CONTROLLER = "src/controllers/orders-controller.js";
const SERVICE = "src/services/order-service.js";
const REPO = "src/repositories/order-repository.js";
const FILES = {
  [CONTROLLER]: "export function listOrders() {}\nexport function exportOrders() {}\n",
  [SERVICE]: "export function listOrders() {}\nexport function exportOrders() {}\n",
  [REPO]: "export function findOrderRows() {}\n",
};
const IMPL = [
  "## API 落地清單", "| API | Controller | Service | Repository |", "| --- | --- | --- | --- |",
  `| GET /api/orders | ${CONTROLLER} ── listOrders() | ${SERVICE} ── listOrders() | ${REPO} ── findOrderRows() |`,
  `| GET /api/orders/export | ${CONTROLLER} ── exportOrders() | ${SERVICE} ── exportOrders() | ${REPO} ── findOrderRows() |`, "",
].join("\n");
const has = (list, re) => list.some((x) => re.test(x));
let n = 0;
/** 建立專案目錄；overrides 的值為 null 代表不建立該檔。 */
function project(overrides = {}) {
  const dir = path.join(root, `p${n++}`);
  for (const [rel, text] of Object.entries({ ...FILES, ...overrides })) {
    if (text === null) continue;
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test("合格：impl 落地清單與 SD 一致，專案檔案齊全且含宣告的方法", () => {
  assert.deepEqual(checkSdLayers(SD, IMPL, project()), []);
});

test("專案檔案不存在：指出哪一支 API 的哪一層", () => {
  const r = checkSdLayersInProject(SD, project({ [SERVICE]: null }));
  assert.equal(r.length, 2);
  assert.match(r[0], /API「1\. 查詢訂單列表」的 Service（src\/services\/order-service\.js）檔案不存在於專案目錄/);
  assert.match(r[1], /API「2\. 匯出訂單 Excel」的 Service/);
});

test("專案檔案存在但找不到宣告的方法", () => {
  const r = checkSdLayersInProject(SD, project({ [SERVICE]: "export function listOrders() {}\n" }));
  assert.equal(r.length, 1);
  assert.match(r[0], /API「2\. 匯出訂單 Excel」的 Service.*找不到宣告的方法：exportOrders/);
  // 只是子字串（listOrdersAll）不算有該方法
  const sub = checkSdLayersInProject(SD, project({ [REPO]: "export function findOrderRowsAll() {}\n" }));
  assert.ok(has(sub, /Repository.*找不到宣告的方法：findOrderRows/));
});

test("SD 宣告的路徑超出專案目錄", () => {
  const sd = SD.replace(SERVICE, "../outside/order-service.js");
  assert.ok(has(checkSdLayersInProject(sd, project()), /路徑超出專案目錄/));
});

test("缺層：SD 少宣告一層由 SD 結構檢查擋，分層檢查不當掉；impl 少列一層對不上", () => {
  const sdNoRepo = SD.replace(/\*\*Repository:\*\* src\/repositories\/order-repository\.js ── findOrderRows\(\)\n\n/, "");
  assert.ok(has(checkSdStructure(sdNoRepo), /缺少 \*\*Repository:\*\*（查詢層/));
  assert.doesNotThrow(() => checkSdLayers(sdNoRepo, IMPL, project()));
  const implNoRepo = IMPL.replace(`| ${REPO} ── findOrderRows() |\n`, "|  |\n");
  const r = checkImplLayerList(implNoRepo, SD);
  assert.ok(has(r, /API「1\. 查詢訂單列表」的 Repository 落地檔案與 SD 不同/));
});

test("impl 落地清單：缺章節、表頭錯、缺 API、檔案不同、方法不同", () => {
  assert.ok(has(checkImplLayerList("## 改動檔案\n- a.js\n", SD), /缺少「## API 落地清單」/));
  assert.ok(has(checkImplLayerList(IMPL.replace("| API | Controller", "| 路徑 | Controller"), SD), /表頭固定為：API｜Controller｜Service｜Repository/));
  const noExport = IMPL.split("\n").filter((l) => !l.includes("/api/orders/export")).join("\n");
  const r1 = checkImplLayerList(noExport, SD);
  assert.equal(r1.length, 1);
  assert.match(r1[0], /沒有列出 API「2\. 匯出訂單 Excel」/);
  assert.ok(has(checkImplLayerList(IMPL.replace(`| ${SERVICE} ── listOrders() |`, "| src/services/other.js ── listOrders() |"), SD), /API「1\. 查詢訂單列表」的 Service 落地檔案與 SD 不同/));
  assert.ok(has(checkImplLayerList(IMPL.replace(`${SERVICE} ── listOrders()`, `${SERVICE} ── listAll()`), SD), /Service 沒有列出 SD 宣告的方法：listOrders/));
});

test("impl 清單的 /api/orders 不會被當成 /api/orders/export", () => {
  const onlyList = IMPL.split("\n").filter((l) => !l.includes("/api/orders/export")).join("\n");
  assert.ok(has(checkImplLayerList(onlyList, SD), /沒有列出 API「2\. 匯出訂單 Excel」/));
  assert.ok(!has(checkImplLayerList(onlyList, SD), /沒有列出 API「1\./));
});

test("取不到專案目錄：只比對 impl 說明與 SD（檔案層級），不檢查實際檔案", () => {
  assert.deepEqual(checkSdLayers(SD, IMPL, null), []);
  assert.ok(has(checkSdLayers(SD, "沒有清單", null), /缺少「## API 落地清單」/));
  // 有專案目錄時，檔案不存在才會被抓到
  assert.ok(has(checkSdLayers(SD, IMPL, project({ [CONTROLLER]: null })), /Controller.*檔案不存在/));
});

test("SD 沒有任何 API：不檢查", () => {
  assert.deepEqual(checkSdLayers("# 沒有 API 說明\n", "", project()), []);
});
