// SD「## 流程圖」章節（問題 66）：只放 flow.png 引用加文字說明；legacy（舊版面）沒有此章節也接受；flow.png 要存在、有效、不比 flow.mmd 舊。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTmpDir, removeDir } from "./helpers/support.mjs";
import { SD_TEMPLATE, installFlowImage, tableSchemaTemplates } from "./helpers/sasd-standard.mjs";

const { checkSdStructure } = await import("../dist/workflow/sd-structure-check.js");
const root = makeTmpDir("dpm-sd-flow-");
after(() => removeDir(root));
const has = (list, re) => list.some((x) => re.test(x));
const T = () => SD_TEMPLATE();
const FLOW_SECTION = /## 流程圖[\s\S]*?(?=## API 說明)/;
const withoutFlow = () => T().replace(FLOW_SECTION, "").replace("二、流程圖\n\n三、API 說明", "二、API 說明");

let n = 0;
function dirWithFlow() {
  const dir = path.join(root, `w${n++}`);
  fs.mkdirSync(path.join(dir, "TableSchema"), { recursive: true });
  for (const [name, text] of Object.entries(tableSchemaTemplates())) fs.writeFileSync(path.join(dir, "TableSchema", `${name}.md`), text);
  installFlowImage(dir);
  return dir;
}

test("範本含「## 流程圖」且 flow.png 存在、有效時通過", () => {
  assert.deepEqual(checkSdStructure(T(), dirWithFlow()), []);
  assert.deepEqual(checkSdStructure(T()), [], "沒給目錄只檢查文字");
});

test("缺「## 流程圖」章節被擋；legacy（舊版面）可以沒有", () => {
  assert.ok(has(checkSdStructure(withoutFlow()), /缺少必備章節「## 流程圖」/));
  assert.deepEqual(checkSdStructure(withoutFlow(), dirWithFlow(), null, { legacy: true }), []);
});

test("章節要引用 flow.png 並有文字說明", () => {
  const noImage = T().replace("![匯出訂單流程圖](flow.png)", "");
  assert.ok(has(checkSdStructure(noImage), /「流程圖」要用圖片引用轉出的流程圖/));
  const noProse = T().replace(/!\[匯出訂單流程圖\]\(flow\.png\)\n\n[^\n]+\n/, "![匯出訂單流程圖](flow.png)\n");
  assert.ok(has(checkSdStructure(noProse), /圖片之外要有一段文字說明/));
});

test("flow.png 不存在、不是 PNG 或比 flow.mmd 舊都擋", () => {
  const missing = path.join(root, `w${n++}`);
  fs.mkdirSync(missing, { recursive: true });
  assert.ok(has(checkSdStructure(T(), missing), /flow\.png 不存在或不是有效的 PNG/));
  const bad = dirWithFlow();
  fs.writeFileSync(path.join(bad, "flow.png"), "not a png");
  assert.ok(has(checkSdStructure(T(), bad), /flow\.png 不存在或不是有效的 PNG/));
  const stale = dirWithFlow();
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(stale, "flow.png"), old, old);
  fs.utimesSync(path.join(stale, "flow.mmd"), new Date(), new Date());
  assert.ok(has(checkSdStructure(T(), stale), /flow\.png 比來源 flow\.mmd 舊.*重新轉圖/));
});
