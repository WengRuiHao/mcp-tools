// 批次 2M-f：模組地圖「名詞表」（資料實體標準名稱與別名），擁有權檢查以標準名稱為準。
import test from "node:test";
import assert from "node:assert/strict";
import { parseModuleMap, parseGlossary, glossaryProblems, moduleMapProblems, checkTableOwnership } from "../dist/module-map.js";

const MAP = [
  "## 模組：會員", "- 負責人：甲", "- 擁有資料表：members", "",
  "## 模組：訂單", "- 負責人：乙", "- 擁有資料表：orders", "",
  "## 名詞表", "- members：customer、user、客戶", "- orders：訂單單據", "",
].join("\n");

test("解析：標準名稱與別名；名詞表不算模組；沒有名詞表回空", () => {
  assert.deepEqual(parseModuleMap(MAP).map((m) => m.name), ["會員", "訂單"]);
  const g = parseGlossary(MAP);
  assert.deepEqual(g, [{ name: "members", aliases: ["customer", "user", "客戶"] }, { name: "orders", aliases: ["訂單單據"] }]);
  assert.deepEqual(parseGlossary("## 模組：A\n- 負責人：x\n"), []);
});

test("名詞表結構：別名重複登記在兩個標準名稱、別名與另一標準名稱相同", () => {
  assert.deepEqual(glossaryProblems(parseGlossary(MAP)), []);
  const bad = parseGlossary(["## 名詞表", "- members：user", "- accounts：user、orders", "- orders：x", ""].join("\n"));
  const p = glossaryProblems(bad).join("\n");
  assert.match(p, /user.*members.*accounts/);
  assert.match(p, /別名「orders」.*另一個標準名稱/);
});

test("擁有權：兩個模組用標準名稱與別名擁有同一實體，地圖檢查回警告", () => {
  const map = ["## 模組：甲", "- 負責人：x", "- 擁有資料表：members", "", "## 模組：乙", "- 負責人：y", "- 擁有資料表：customer", "", "## 名詞表", "- members：customer", ""].join("\n");
  const mods = parseModuleMap(map);
  assert.match(moduleMapProblems(mods, parseGlossary(map)).join("\n"), /members.*甲.*乙|customer.*甲.*乙/);
  assert.ok(!moduleMapProblems(mods).some((p) => p.includes("同時被")), "沒給名詞表時維持舊行為，別名不認得");
});

test("SD 資料表擁有權檢查：用別名也認得出屬於哪個模組", () => {
  const mods = parseModuleMap(MAP);
  const g = parseGlossary(MAP);
  assert.deepEqual(checkTableOwnership(mods, ["customer"], ["會員"], g), []);
  const r = checkTableOwnership(mods, ["customer", "user"], ["訂單"], g);
  assert.equal(r.length, 2);
  assert.match(r[0], /customer.*會員/);
  assert.equal(checkTableOwnership(mods, ["customer"], ["訂單"]).length, 0, "沒給名詞表時別名不認得（維持舊行為）");
});
