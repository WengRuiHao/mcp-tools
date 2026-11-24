// 批次 2M-i：地圖寫入時比對前後版本，介面升版、內容變動版本沒升、介面被移除，都列出受影響的使用者。
import test from "node:test";
import assert from "node:assert/strict";
import { interfaceChangeNotices } from "../dist/module-map.js";

const mk = (ver, summary = "扣減", ex = "{ok:true}", extra = "") => [
  "## 模組：庫存", "- 負責人：乙", "### 對外介面",
  `- 扣庫存｜同步呼叫｜v${ver}｜${summary}｜使用者：訂單、出貨`, extra,
  "### 契約範例", `- 扣庫存｜輸入：{sku:A}｜預期輸出：${ex}`, "",
  "## 模組：訂單", "- 負責人：甲", "",
].join("\n");

test("升版：列出使用者，提醒新舊並行", () => {
  const n = interfaceChangeNotices(mk(1), mk(2)).join("\n");
  assert.match(n, /庫存\.扣庫存.*v1.*v2/);
  assert.match(n, /訂單、出貨/);
  assert.match(n, /並行/);
});

test("沒變、新增介面：沒有通知", () => {
  assert.deepEqual(interfaceChangeNotices(mk(1), mk(1)), []);
  assert.deepEqual(interfaceChangeNotices("", mk(1)), []);
  assert.deepEqual(interfaceChangeNotices(mk(1), mk(1, "扣減", "{ok:true}", "- 新介面｜事件｜v1｜x｜使用者：訂單")), []);
});

test("摘要或契約範例變了但版本沒升：提醒不相容變更要升版並列出使用者", () => {
  assert.match(interfaceChangeNotices(mk(1), mk(1, "改成扣減並鎖定")).join("\n"), /扣庫存.*版本沒升.*訂單、出貨/);
  assert.match(interfaceChangeNotices(mk(1), mk(1, "扣減", "{ok:false}")).join("\n"), /扣庫存.*契約範例.*版本沒升/);
});

test("介面被移除而仍有使用者：列出；版本倒退：提醒", () => {
  const removed = mk(1).replace(/- 扣庫存｜同步呼叫.*\n/, "").replace(/### 契約範例\n- 扣庫存.*\n/, "");
  assert.match(interfaceChangeNotices(mk(1), removed).join("\n"), /扣庫存.*移除.*訂單、出貨/);
  assert.match(interfaceChangeNotices(mk(3), mk(2)).join("\n"), /扣庫存.*倒退.*v3.*v2/);
});
