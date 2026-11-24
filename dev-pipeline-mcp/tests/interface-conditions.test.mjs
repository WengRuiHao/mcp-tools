// 批次 2M-j：介面清單的執行條件欄位（逾時、冪等、速率限制），缺欄位只在地圖寫入時警告。
import test from "node:test";
import assert from "node:assert/strict";
import { interfaceConditionProblems, parseModuleMap } from "../dist/module-map.js";

const MAP = (line) => ["## 模組：庫存", "- 負責人：乙", "### 對外介面", line, "", "## 模組：訂單", "- 負責人：甲", ""].join("\n");

test("三欄齊全：沒有警告；解析介面名稱與版本不受影響", () => {
  const t = MAP("- 扣庫存｜同步呼叫｜v1｜扣減｜逾時：3秒｜冪等：是｜速率限制：100/秒｜使用者：訂單");
  assert.deepEqual(interfaceConditionProblems(t), []);
  const i = parseModuleMap(t)[0].interfaces[0];
  assert.equal(i.name, "扣庫存");
  assert.equal(i.version, 1);
  assert.deepEqual(i.users, ["訂單"]);
});

test("缺欄位：列出缺哪幾個；限流是速率限制的別名；事件不要求逾時與速率限制", () => {
  const p = interfaceConditionProblems(MAP("- 扣庫存｜同步呼叫｜v1｜扣減｜使用者：訂單")).join("\n");
  assert.match(p, /庫存\.扣庫存.*逾時.*冪等.*速率限制/);
  const missingOf = (t) => /缺少執行條件：([^（]*)/.exec(interfaceConditionProblems(t).join("\n"))?.[1];
  assert.equal(missingOf(MAP("- 扣庫存｜同步呼叫｜v1｜扣減｜逾時：3秒｜限流：10/秒｜使用者：訂單")), "冪等");
  assert.equal(missingOf(MAP("- 補庫存｜事件｜v1｜回補｜使用者：訂單")), "冪等");
});

test("沒有介面或沒有對外介面節：沒有警告", () => {
  assert.deepEqual(interfaceConditionProblems("## 模組：A\n- 負責人：x\n"), []);
});
