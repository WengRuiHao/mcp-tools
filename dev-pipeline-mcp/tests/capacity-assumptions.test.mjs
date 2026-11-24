// 批次 2M-k：容量假設清單（專案層文件 capacity-assumptions.md）與逾期提醒，只警告不擋。
import test from "node:test";
import assert from "node:assert/strict";
import { parseCapacityAssumptions, capacityDocProblems, overdueCapacityAssumptions } from "../dist/capacity-assumptions.js";
import { PROJECT_DOC_NAMES } from "../dist/project-docs-store.js";

const DOC = ["# 容量假設", "- 每日訂單 10 萬筆｜到期日：2026-06-30", "- 尖峰 QPS 500｜到期日：2027-01-31", "- 沒寫日期的假設", "- 日期壞掉｜到期日：明年", ""].join("\n");

test("白名單含 capacity-assumptions.md", () => {
  assert.ok(PROJECT_DOC_NAMES.includes("capacity-assumptions.md"));
});

test("解析：假設內容與到期日；日期格式不對或沒寫者 date 為 undefined", () => {
  const a = parseCapacityAssumptions(DOC);
  assert.deepEqual(a.map((x) => x.text), ["每日訂單 10 萬筆", "尖峰 QPS 500", "沒寫日期的假設", "日期壞掉"]);
  assert.deepEqual(a.map((x) => x.date), ["2026-06-30", "2027-01-31", undefined, undefined]);
});

test("寫入警告：缺到期日或格式不對", () => {
  const p = capacityDocProblems(parseCapacityAssumptions(DOC)).join("\n");
  assert.match(p, /沒寫日期的假設.*到期日/);
  assert.match(p, /日期壞掉.*YYYY-MM-DD/);
  assert.deepEqual(capacityDocProblems(parseCapacityAssumptions("- 假設｜到期日：2027-01-01\n")), []);
});

test("逾期：到期日早於今天才算（當天不算）；沒有日期的不算逾期", () => {
  const a = parseCapacityAssumptions(DOC);
  assert.deepEqual(overdueCapacityAssumptions(a, "2026-11-24").map((x) => x.text), ["每日訂單 10 萬筆"]);
  assert.deepEqual(overdueCapacityAssumptions(a, "2026-06-30"), []);
  assert.deepEqual(overdueCapacityAssumptions(a, "2027-02-01").map((x) => x.text), ["每日訂單 10 萬筆", "尖峰 QPS 500"]);
});
