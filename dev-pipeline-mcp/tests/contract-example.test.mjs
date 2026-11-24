// 批次 2M-h：介面契約範例（模組地圖「### 契約範例」）。地圖寫入只警告；高風險 SD 呼叫的介面沒有範例就擋住。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseModuleMap, parseContractExamples, contractExampleProblems, checkCalledContracts, parseCrossModuleCalls } from "../dist/module-map.js";
import { sdModuleMapProblems } from "../dist/work-item-actions/module-map-checks.js";

const MAP = [
  "## 模組：庫存", "- 負責人：乙", "### 對外介面",
  "- 扣庫存｜同步呼叫｜v1｜扣減｜使用者：訂單", "- 補庫存｜事件｜v1｜回補｜使用者：訂單",
  "### 契約範例", "- 扣庫存｜輸入：{sku:A,qty:1}｜預期輸出：{ok:true}", "",
  "## 模組：訂單", "- 負責人：甲", "- 依賴模組：庫存", "",
].join("\n");

test("解析：每個模組底下「### 契約範例」，每行 介面｜輸入｜預期輸出；不影響模組與介面解析", () => {
  const ex = parseContractExamples(MAP);
  assert.deepEqual(ex, [{ module: "庫存", iface: "扣庫存", input: "{sku:A,qty:1}", output: "{ok:true}" }]);
  const mods = parseModuleMap(MAP);
  assert.deepEqual(mods[0].interfaces.map((i) => i.name), ["扣庫存", "補庫存"]);
  assert.deepEqual(parseContractExamples("## 模組：A\n- 負責人：x\n"), []);
});

test("地圖寫入警告：介面沒有範例、範例指向不存在的介面、缺輸入或預期輸出", () => {
  const mods = parseModuleMap(MAP);
  const p = contractExampleProblems(mods, parseContractExamples(MAP)).join("\n");
  assert.match(p, /補庫存.*沒有契約範例/);
  assert.ok(!/扣庫存.*沒有契約範例/.test(p));
  const bad = ["## 模組：A", "- 負責人：x", "### 對外介面", "- f｜同步呼叫｜v1｜s｜使用者：A", "### 契約範例", "- g｜輸入：1｜預期輸出：2", "- f｜輸入：1", ""].join("\n");
  const q = contractExampleProblems(parseModuleMap(bad), parseContractExamples(bad)).join("\n");
  assert.match(q, /g.*不在.*對外介面清單/);
  assert.match(q, /f.*預期輸出/);
});

test("SD 呼叫的對方介面沒有契約範例就列問題；自己模組不算", () => {
  const ex = parseContractExamples(MAP);
  const calls = parseCrossModuleCalls("## 跨模組呼叫\n- 庫存.扣庫存 v1：扣\n- 庫存.補庫存 v1：補\n");
  const r = checkCalledContracts(calls, ex, ["訂單"]);
  assert.equal(r.length, 1);
  assert.match(r[0], /庫存\.補庫存.*契約範例/);
  assert.deepEqual(checkCalledContracts(calls, ex, ["庫存"]), []);
});

async function proj(map) {
  const p = await mkdtemp(path.join(os.tmpdir(), "ce-proj-"));
  await mkdir(path.join(p, ".pipeline"), { recursive: true });
  await writeFile(path.join(p, ".pipeline", "flow.json"), JSON.stringify({ schemaVersion: 1, multiModule: true }));
  await (await import("../dist/project-docs-store.js")).writeProjectDoc(p, "module-map.md", map);
  return p;
}

test("接線：只有 highRisk 才擋；非高風險不檢查契約範例", async () => {
  const p = await proj(MAP);
  const wi = await mkdtemp(path.join(os.tmpdir(), "ce-wi-"));
  await writeFile(path.join(wi, "03-sd.md"), "## 跨模組呼叫\n- 庫存.補庫存 v1：補\n");
  const hi = await sdModuleMapProblems(wi, p, ["訂單"], true);
  assert.ok(hi.some((x) => x.includes("契約範例") && x.includes("補庫存")), JSON.stringify(hi));
  const lo = await sdModuleMapProblems(wi, p, ["訂單"], false);
  assert.ok(!lo.some((x) => x.includes("契約範例")), JSON.stringify(lo));
  assert.ok(!(await sdModuleMapProblems(wi, p, ["訂單"])).some((x) => x.includes("契約範例")));
});
