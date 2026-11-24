// 批次 2M-c：模組地圖的對外介面清單、SD「跨模組呼叫」引用檢查、系統模組依賴方向。
import test from "node:test";
import assert from "node:assert/strict";
import { parseModuleMap, moduleMapProblems, parseCrossModuleCalls, checkCrossModuleCalls } from "../dist/module-map.js";

const MAP = [
  "# 模組地圖", "",
  "## 模組：會員", "- 負責人：小王", "- 類型：系統模組", "- 擁有資料表：members", "",
  "### 對外介面",
  "- 查詢會員｜同步呼叫｜v2｜輸入 會員編號，輸出 會員資料｜使用者：訂單、結帳",
  "- 會員註冊事件｜事件｜v1｜使用者：訂單", "",
  "## 模組：訂單", "- 負責人：小李", "- 擁有資料表：orders", "- 依賴模組：會員", "",
  "### 對外介面",
  "- 建立訂單｜同步呼叫｜v1｜輸入 購物車，輸出 訂單編號｜使用者：結帳", "",
  "## 模組：結帳", "- 負責人：小張", "- 依賴模組：訂單、會員", "",
].join("\n");
const sd = (...lines) => ["# SD", "", "## API 說明", "", "## 跨模組呼叫", "", ...lines, "", "## 上線與回滾", "x", ""].join("\n");

test("解析：對外介面清單（名稱、類型、版本、摘要、使用者模組）", () => {
  const m = parseModuleMap(MAP);
  assert.deepEqual(m[0].interfaces, [
    { name: "查詢會員", type: "同步呼叫", version: 2, summary: "輸入 會員編號，輸出 會員資料", users: ["訂單", "結帳"] },
    { name: "會員註冊事件", type: "事件", version: 1, summary: "", users: ["訂單"] },
  ]);
  assert.equal(m[0].tables.length, 1, "介面清單的行不會被當成模組欄位");
  assert.deepEqual(m[2].interfaces, []);
});

test("地圖結構檢查：介面類型錯、沒版本、重名、使用者不存在；系統模組不得依賴一般模組", () => {
  assert.deepEqual(moduleMapProblems(parseModuleMap(MAP)), []);
  const bad = parseModuleMap([
    "## 模組：甲", "- 負責人：x", "- 類型：系統模組", "- 依賴模組：乙", "",
    "### 對外介面", "- 介面一｜同步｜v1｜使用者：乙", "- 介面二｜事件｜使用者：乙", "- 介面一｜事件｜v1｜使用者：不存在", "",
    "## 模組：乙", "- 負責人：x", "",
  ].join("\n"));
  const p = moduleMapProblems(bad).join("\n");
  assert.match(p, /介面一.*類型/);
  assert.match(p, /介面二.*版本/);
  assert.match(p, /介面一.*重複/);
  assert.match(p, /不存在.*不在模組地圖|使用者.*不存在/);
  assert.match(p, /系統模組「甲」.*依賴.*乙.*一般模組/);
});

test("解析 SD 跨模組呼叫：模組.介面 與選填版本", () => {
  const c = parseCrossModuleCalls(sd("- 會員.查詢會員 v2：下單前確認會員", "- **訂單.建立訂單**：結帳建立訂單", "沒有格式的行"));
  assert.deepEqual(c.map((x) => [x.module, x.iface, x.version]), [["會員", "查詢會員", 2], ["訂單", "建立訂單", undefined]]);
  assert.deepEqual(parseCrossModuleCalls("# SD\n\n## API 說明\n"), []);
});

test("跨模組呼叫檢查：合格", () => {
  const m = parseModuleMap(MAP);
  assert.deepEqual(checkCrossModuleCalls(m, parseCrossModuleCalls(sd("- 會員.查詢會員 v2：x", "- 訂單.建立訂單：y")), ["結帳"]), []);
});

test("跨模組呼叫檢查：模組或介面不存在、版本不符、沒宣告依賴、沒登記為使用者都擋", () => {
  const m = parseModuleMap(MAP);
  const run = (line, declared) => checkCrossModuleCalls(m, parseCrossModuleCalls(sd(line)), declared).join("\n");
  assert.match(run("- 報表.匯出：x", ["結帳"]), /報表.*不在模組地圖/);
  assert.match(run("- 會員.刪除會員：x", ["結帳"]), /刪除會員.*不在.*對外介面/);
  assert.match(run("- 會員.查詢會員 v1：x", ["結帳"]), /查詢會員.*版本.*v2/);
  assert.match(run("- 訂單.建立訂單：x", ["會員"]), /會員.*沒有宣告依賴.*訂單/);
  assert.match(run("- 會員.會員註冊事件：x", ["結帳"]), /結帳.*不在.*使用者/);
});

test("跨模組呼叫檢查：呼叫自己的模組不算跨模組；沒宣告模組略過", () => {
  const m = parseModuleMap(MAP);
  assert.deepEqual(checkCrossModuleCalls(m, parseCrossModuleCalls(sd("- 訂單.建立訂單：自己用")), ["訂單"]), []);
  assert.deepEqual(checkCrossModuleCalls(m, parseCrossModuleCalls(sd("- 報表.匯出：x")), []), []);
});

test("接線：SD 交件檢查跨模組呼叫（multiModule、有地圖、宣告模組才查）", async () => {
  const { sdModuleMapProblems } = await import("../dist/work-item-actions/module-map-checks.js");
  const { mkdtemp, writeFile, mkdir } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const proj = await mkdtemp(path.join(os.tmpdir(), "ic-proj-"));
  await mkdir(path.join(proj, ".pipeline"), { recursive: true });
  await writeFile(path.join(proj, ".pipeline", "flow.json"), JSON.stringify({ schemaVersion: 1, multiModule: true }));
  await (await import("../dist/project-docs-store.js")).writeProjectDoc(proj, "module-map.md", MAP);
  const wi = await mkdtemp(path.join(os.tmpdir(), "ic-wi-"));
  await writeFile(path.join(wi, "03-sd.md"), sd("- 會員.刪除會員：x"));
  const bad = await sdModuleMapProblems(wi, proj, ["結帳"]);
  assert.ok(bad.some((p) => p.includes("模組地圖檢查未通過") && p.includes("刪除會員")), JSON.stringify(bad));
  await writeFile(path.join(wi, "03-sd.md"), sd("- 會員.查詢會員 v2：x"));
  assert.deepEqual(await sdModuleMapProblems(wi, proj, ["結帳"]), []);
  await writeFile(path.join(wi, "03-sd.md"), "# SD\n");
  assert.deepEqual(await sdModuleMapProblems(wi, proj, ["結帳"]), []);
});
