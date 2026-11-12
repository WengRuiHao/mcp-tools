// 無異動模式：02-db.sql 只有註解（既有系統只讀既有表），表來源為「既有資料表」。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTmpDir, removeDir } from "./helpers/support.mjs";
import { noChangeDocs, writeNoChangeItem, EXISTING_SECTION } from "./helpers/no-change-fixture.mjs";

const { checkTableSchemas } = await import("../dist/workflow/table-schema-check.js");
const { classifySql } = await import("../dist/workflow/sql-schema-parse.js");
const { parseExistingSection } = await import("../dist/workflow/existing-tables.js");
const root = makeTmpDir("dpm-nochange-");
after(() => removeDir(root));

let n = 0;
const run = (over = {}, opts = { baseline: "brownfield" }) => checkTableSchemas(writeNoChangeItem(path.join(root, `w${n++}`), over), opts);
const has = (list, re) => list.some((x) => re.test(x));
const D = () => noChangeDocs();
const OLD_SECTION = "## 既有資料表\n\n| 資料表 | 主鍵 | 外鍵 | 說明 |\n| --- | --- | --- | --- |\n| members | id | 無 | x |\n| orders | id | member_id→members.id | x |\n| order_items | id | order_id→orders.id | x |\n";

test("classifySql：空白、只有註解、有語句", () => {
  assert.equal(classifySql(" \n"), "blank");
  assert.equal(classifySql("-- a\n/* b */;\n"), "comment-only");
  assert.equal(classifySql("-- a\nCREATE INDEX i ON t(a);"), "statements");
});

test("無異動合格樣本：註解 SQL＋既有資料表章節＋分組文件＋模組與系統 ER 圖＋關聯清單", () => {
  assert.deepEqual(run(), []);
});

test("既有資料表章節：選填欄位欄；沒有欄位欄的舊表頭仍可用（只要求 PK 與 FK 欄位）", () => {
  const t = parseExistingSection(EXISTING_SECTION);
  assert.deepEqual(t[1].columns, ["id", "member_id", "order_no", "ordered_at"]);
  assert.deepEqual(run({ systemEr: D().systemEr.replace(EXISTING_SECTION, OLD_SECTION) }), []);
});

test("沒有專案 .sql 也沒有既有資料表章節：要求補章節", () => {
  const r = run({ systemEr: D().systemEr.replace(EXISTING_SECTION, "") });
  assert.ok(has(r, /只有註解（本次無資料表異動），但取不到既有資料表.*## 既有資料表/), r.join("\n"));
});

test("既有表來源可以是專案 .sql 掃描（不寫章節）", () => {
  const proj = path.join(root, "proj-sql");
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, "schema.sql"), "CREATE TABLE members (id INTEGER PRIMARY KEY, name TEXT, created_at TEXT);\nCREATE TABLE orders (id INTEGER PRIMARY KEY, order_no TEXT, member_id INTEGER REFERENCES members(id), ordered_at TEXT);\nCREATE TABLE order_items (id INTEGER PRIMARY KEY, order_id INTEGER REFERENCES orders(id), product_name TEXT, quantity INTEGER, subtotal INTEGER);");
  assert.deepEqual(run({ systemEr: D().systemEr.replace(EXISTING_SECTION, "") }, { baseline: "brownfield", projectDir: proj }), []);
});

test("SQL 完全空白：擋並說明怎麼改", () => {
  const r = run({ sql: "  \n" });
  assert.equal(r.length, 1);
  assert.match(r[0], /02-db\.sql 是空白.*只寫註解.*## 既有資料表/);
});

test("文件內的表不在 SQL ∪ 既有資料表集合內", () => {
  const ghost = D().members.replace("## 資料表：members", "## 資料表：ghost").replace("| members | 會員 |", "| ghost | 會員 |");
  assert.ok(has(run({ members: ghost }), /ghost 不在既有資料表內.*只有註解/));
});

test("無 DDL 卻標「本次新增」「本次修改」：系統圖與模組圖都擋", () => {
  const sysNew = D().systemEr.replace("INTEGER id PK\n    }\n    orders {", 'INTEGER id PK "本次新增"\n    }\n    orders {');
  assert.ok(has(run({ systemEr: sysNew }), /system-er\.md.*members 不是本次新增的表.*無資料表異動/));
  const modMod = D().orders.replace("INTEGER member_id FK", 'INTEGER member_id FK "本次修改"');
  assert.ok(has(run({ orders: modMod }), /orders\.md 的模組 ER 圖 的表 orders 不是本次修改的表.*不可標/));
});

test("既有表宣告的外鍵未出現在關聯清單（或依據不是外鍵約束）", () => {
  const r = run({ orders: D().orders.replace("| orders | member_id | members | id | 一對多 | 外鍵約束 |\n", "") });
  assert.ok(has(r, /缺少外鍵 orders\.member_id → members/), r.join("\n"));
  const logical = D().orders.replace("| orders | member_id | members | id | 一對多 | 外鍵約束 |", "| orders | member_id | members | id | 一對多 | 邏輯關聯 |");
  assert.ok(has(run({ orders: logical }), /缺少外鍵 orders\.member_id → members/));
});

test("關聯清單的外鍵約束與既有表宣告對不上", () => {
  const r = run({ orders: D().orders.replace("| order_items | order_id | orders | id | 一對多 | 外鍵約束 |", "| order_items | product_name | orders | id | 一對多 | 外鍵約束 |") });
  assert.ok(has(r, /標示為外鍵約束，但 02-db\.sql 沒有這個外鍵/), r.join("\n"));
});

test("既有表有填欄位但欄位清單漏欄位；沒填欄位只要求 PK 與 FK", () => {
  const dropped = D().orders.replace(/\| 4 \| ordered_at[^\n]*\n/, "");
  const r = run({ orders: dropped });
  assert.ok(has(r, /資料表：orders」「欄位清單」缺少 既有資料表宣告.*欄位：ordered_at/), r.join("\n"));
  const noCols = D().systemEr.replace(EXISTING_SECTION, OLD_SECTION);
  assert.deepEqual(run({ orders: dropped, systemEr: noCols }), []);
  const lostFk = D().orders.replace(/\| 3 \| member_id[^\n]*\n/, "");
  assert.ok(has(run({ orders: lostFk, systemEr: noCols }), /缺少 既有資料表宣告.*欄位：member_id/));
});

test("ER 圖多表或缺表、缺關聯線、符號不符（NOT NULL 未知一律可選）", () => {
  const extra = D().orders.replace("    order_items {", "    ghost {\n        INTEGER id PK\n    }\n    order_items {");
  assert.ok(has(run({ orders: extra }), /orders\.md 的模組 ER 圖 多了範圍外的資料表：ghost/));
  const lack = D().systemEr.replace(/    order_items \{\n[^}]*\}\n/, "").replace(/    orders \|o--o\{ order_items[^\n]*\n/, "");
  const rl = run({ systemEr: lack });
  assert.ok(has(rl, /system-er\.md 的系統 ER 圖 缺少資料表：order_items/), rl.join("\n"));
  const noLine = D().orders.replace(/    orders \|o--o\{ order_items[^\n]*\n/, "");
  assert.ok(has(run({ orders: noLine }), /缺少關聯線 orders→order_items/));
  const required = D().orders.replace("orders |o--o{ order_items", "orders ||--o{ order_items");
  assert.ok(has(run({ orders: required }), /符號與關聯清單不一致.*orders \|o--o\{ order_items/));
});

test("系統圖有多的關聯線、缺關聯線", () => {
  const stray = D().systemEr.replace("    members {", "    order_items |o--o{ members : x\n    members {");
  assert.ok(has(run({ systemEr: stray }), /沒有對應的關聯清單項目|缺少關聯線/));
  const missing = D().systemEr.replace(/    members \|o--o\{ orders[^\n]*\n/, "");
  assert.ok(has(run({ systemEr: missing }), /缺少關聯線 members→orders/));
});

test("用到既有表卻沒有任何分組文件；缺系統 ER 圖文件", () => {
  const r = run({ orders: null, members: null });
  assert.ok(has(r, /沒有任何分組文件.*TableSchema\/<主表名>\.md/), r.join("\n"));
  const dir = writeNoChangeItem(path.join(root, `w${n++}`));
  fs.rmSync(path.join(dir, "TableSchema", "system-er.md"));
  assert.ok(has(checkTableSchemas(dir, { baseline: "brownfield" }), /缺少系統 ER 圖文件|取不到既有資料表/));
});

test("既有表在多份文件重複、缺版本管控歷程仍照一般規則", () => {
  const o = D().orders;
  const dup = `${D().members}\n${o.slice(o.indexOf("## 資料表：orders"), o.indexOf("## 資料表：order_items"))}`;
  assert.ok(has(run({ members: dup }), /資料表 orders 同時出現在多份文件/));
  const bad = o.replace(/## 版本管控歷程[\s\S]*?(?=## 模組 ER 圖)/, "");
  assert.ok(has(run({ orders: bad }), /orders\.md 缺少「## 版本管控歷程」/));
});

test("greenfield 的註解 SQL 沒有既有表：文件的表視為不存在", () => {
  assert.ok(has(run({}, { baseline: "greenfield" }), /不在既有資料表內/));
});

test("一般有 DDL：SQL 有 CREATE TABLE 時，文件內的既有表不在 CREATE TABLE 內仍擋（行為不變）", () => {
  const r = run({ sql: "CREATE TABLE members (id INTEGER PRIMARY KEY, name TEXT, created_at TEXT);\n" });
  assert.ok(has(r, /orders 不在 02-db\.sql 的 CREATE TABLE 內/), r.join("\n"));
});
