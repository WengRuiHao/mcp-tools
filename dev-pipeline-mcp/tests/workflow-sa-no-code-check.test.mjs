// S14：SA 不寫程式檢查（checkSaNoCode）。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTmpDir, removeDir } from "./helpers/support.mjs";

const { checkSaNoCode } = await import("../dist/workflow/sa-no-code-check.js");
const root = makeTmpDir("dpm-sanocode-");
after(() => removeDir(root));

let n = 0;
function item(sa) {
  const dir = path.join(root, `w${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  if (sa !== undefined) fs.writeFileSync(path.join(dir, "01-sa.md"), sa);
  return dir;
}
const check = (sa) => checkSaNoCode(item(sa));

test("純業務語言通過", () => {
  const r = check("## 功能：匯出\n使用者按下匯出，系統產生 Excel。\n金額 = 單價 × 數量\n沿用現有的共用日期選擇元件。\n");
  assert.deepEqual([r.ok, r.violations.length], [true, 0]);
});

test("程式碼區塊被擋（``` 與 ~~~，含語言標記）", () => {
  for (const [open, close] of [["```java", "```"], ["```", "```"], ["~~~js", "~~~"]]) {
    const r = check(`## 功能：a\n${open}\nint x = 1;\n${close}\n`);
    assert.equal(r.ok, false, open);
    assert.equal(r.violations[0].line, 2);
  }
});

test("mermaid 區塊放行（含大小寫與附加屬性）", () => {
  assert.equal(check("## 功能：a\n```mermaid\nflowchart TD\nA-->B\n```\n").ok, true);
  assert.equal(check("```Mermaid title\nA-->B\n```\n").ok, true);
});

test("mermaid 與一般區塊混用：只擋一般區塊", () => {
  const r = check("```mermaid\nA-->B\n```\n文字\n```sql\nx\n```\n");
  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0].line, 5);
});

test("各種 SQL 被擋（不分大小寫、行內）", () => {
  const cases = [
    "SELECT * FROM orders",
    "select id, name from users where id = 1",
    "請執行 SELECT COUNT(*) FROM t 取得筆數",
    "INSERT INTO t (a) VALUES (1)",
    "insert  into t values (1)",
    "UPDATE orders SET status = 1",
    "update t set a=2",
    "DELETE FROM t WHERE id = 1",
    "CREATE TABLE t (id INT)",
    "alter table t add c int",
    "DROP TABLE t",
    "TRUNCATE TABLE t",
  ];
  for (const c of cases) {
    const r = check(`## 功能：a\n${c}\n`);
    assert.equal(r.ok, false, c);
    assert.equal(r.violations[0].line, 2, c);
  }
});

test("一般中文與含 select／update／delete 字樣的普通句子不誤判", () => {
  const ok = [
    "使用者在下拉選單 select 一個項目後送出",
    "Users select an item from the list.",
    "請選擇要更新的資料，按下 update 按鈕後顯示成功訊息",
    "刪除前需確認 delete 按鈕的提示",
    "insert 與 into 兩個字分開出現：insert a note into 備註欄",
    "從清單選擇資料表格式",
    "drop 下拉後可選擇 table 檢視",
  ];
  for (const c of ok) assert.equal(check(`## 功能：a\n${c}\n`).ok, true, c);
});

test("「## 依據附錄」不再有例外：檔案路徑照放行（不是程式碼），程式碼區塊與 SQL 一律被擋", () => {
  assert.equal(check("## 功能：a\n白話規則\n## 依據附錄\n- src/main/java/OrderService.java:120-135\n").ok, true);
  const bad = check("## 依據附錄\n```java\nx\n```\nSELECT a FROM t\n");
  assert.deepEqual(bad.violations.map((v) => v.line), [2, 5]);
  assert.ok(!bad.violations.some((v) => v.reason.includes("依據附錄")));
});
test("CRLF 行號正確", () => {
  const r = check("## 功能：a\r\n文字\r\n```\r\nx\r\n```\r\nDELETE FROM t\r\n");
  assert.deepEqual(r.violations.map((v) => v.line), [3, 6]);
});

test("01-sa.md 不存在不拋例外，回違規說明", () => {
  const r = check(undefined);
  assert.equal(r.ok, false);
  assert.equal(r.violations.length, 1);
  assert.ok(r.violations[0].reason.includes("01-sa.md"));
});

test("snippet 截短到 60 字元以內", () => {
  const r = check(`SELECT * FROM t ${"x".repeat(200)}\n`);
  assert.ok(r.violations[0].snippet.length <= 60);
  assert.ok(r.violations[0].snippet.startsWith("SELECT * FROM t"));
  const short = check("DROP TABLE t\n");
  assert.equal(short.violations[0].snippet, "DROP TABLE t");
});

test("未結束的程式碼區塊仍被擋", () => {
  assert.equal(check("```\n沒有結尾\n").ok, false);
});
