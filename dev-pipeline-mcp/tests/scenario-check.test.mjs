// 批次 2M-e：模組地圖的「跨模組情境」解析與結構檢查（只在寫入地圖時警告）。
import test from "node:test";
import assert from "node:assert/strict";
import { parseModuleMap, parseScenarios, scenarioProblems } from "../dist/module-map.js";

const MODS = ["## 模組：訂單", "- 負責人：甲", "", "## 模組：庫存", "- 負責人：乙", "", "## 模組：付款", "- 負責人：丙", ""].join("\n");
const SC = [
  "## 跨模組情境：下單",
  "- 經過模組：訂單 → 庫存 → 付款",
  "- 協調者：訂單",
  "- 失敗處理：庫存 重試 3次 間隔5秒；付款 補償 釋放庫存",
  "- 一致性：最終一致",
  "",
].join("\n");

test("解析：情境名稱、經過模組（依序）、協調者、失敗處理、一致性；情境區塊不算模組", () => {
  const text = MODS + SC;
  assert.deepEqual(parseModuleMap(text).map((m) => m.name), ["訂單", "庫存", "付款"]);
  const s = parseScenarios(text);
  assert.equal(s.length, 1);
  assert.equal(s[0].name, "下單");
  assert.deepEqual(s[0].modules, ["訂單", "庫存", "付款"]);
  assert.equal(s[0].coordinator, "訂單");
  assert.match(s[0].failure, /重試/);
  assert.equal(s[0].consistency, "最終一致");
});

test("沒有情境節：回空陣列、沒有問題", () => {
  assert.deepEqual(parseScenarios(MODS), []);
  assert.deepEqual(scenarioProblems(parseModuleMap(MODS), []), []);
});

test("結構檢查：合格不回問題", () => {
  assert.deepEqual(scenarioProblems(parseModuleMap(MODS), parseScenarios(MODS + SC)), []);
});

test("結構檢查：模組不存在、協調者不在經過模組、少於兩個模組、缺失敗處理或一致性、情境重名", () => {
  const bad = [
    "## 跨模組情境：壞一", "- 經過模組：訂單 → 報表", "- 協調者：庫存", "",
    "## 跨模組情境：壞二", "- 經過模組：訂單", "- 協調者：訂單", "- 失敗處理：x", "- 一致性：y", "",
    "## 跨模組情境：壞一", "- 經過模組：訂單、庫存", "- 協調者：訂單", "- 失敗處理：x", "- 一致性：y", "",
  ].join("\n");
  const p = scenarioProblems(parseModuleMap(MODS), parseScenarios(MODS + bad)).join("\n");
  assert.match(p, /壞一.*報表.*不在模組地圖/);
  assert.match(p, /壞一.*協調者.*庫存.*不在經過模組/);
  assert.match(p, /壞一.*失敗處理/);
  assert.match(p, /壞一.*一致性/);
  assert.match(p, /壞二.*至少兩個模組/);
  assert.match(p, /壞一.*重複/);
});
