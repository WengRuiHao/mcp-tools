// 關聯清單檢查：外鍵約束對照 SQL、邏輯關聯只驗格式與存在、關係種類與必選判定。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTmpDir, removeDir } from "./helpers/support.mjs";
import { tableSchemaTemplates } from "./helpers/sasd-standard.mjs";

const { checkTableSchemas, listLogicalRelations } = await import("../dist/workflow/table-schema-check.js");
const { parseCreateTables } = await import("../dist/workflow/sql-schema-parse.js");
const { kindOfForeignKey, isRequired, parseRelations } = await import("../dist/workflow/relation-list-check.js");
const root = makeTmpDir("dpm-rel-");
after(() => removeDir(root));

const SQL = `CREATE TABLE members (id INTEGER PRIMARY KEY, name TEXT, created_at TEXT);
CREATE TABLE orders (id INTEGER PRIMARY KEY, order_no TEXT UNIQUE, member_id INTEGER NOT NULL REFERENCES members(id), ordered_at TEXT);
CREATE TABLE order_items (id INTEGER PRIMARY KEY, order_id INTEGER, product_name TEXT, quantity INTEGER, subtotal INTEGER, FOREIGN KEY (order_id) REFERENCES orders(id));
`;
let n = 0;
function item(schemas, sql = SQL) {
  const dir = path.join(root, `w${n++}`);
  fs.mkdirSync(path.join(dir, "TableSchema"), { recursive: true });
  fs.writeFileSync(path.join(dir, "02-db.sql"), sql);
  for (const [name, text] of Object.entries(schemas)) fs.writeFileSync(path.join(dir, "TableSchema", `${name}.md`), text);
  return dir;
}
const T = () => tableSchemaTemplates();
const has = (list, re) => list.some((x) => re.test(x));
const ROW_ORDERS = "| orders | member_id | members | id | 一對多 | 外鍵約束 |";
const ROW_ITEMS = "| order_items | order_id | orders | id | 一對多 | 外鍵約束 |";
const withOrders = (fn) => ({ ...T(), orders: fn(T().orders) });

test("範本通過；單表文件的關聯清單可以沒有資料列", () => {
  assert.deepEqual(checkTableSchemas(item(T())), []);
});

test("缺關聯清單章節或表頭錯誤", () => {
  assert.ok(has(checkTableSchemas(item({ ...T(), members: T().members.replace("## 關聯清單", "## 關係") })), /members\.md 缺少「## 關聯清單」表格/));
  assert.ok(has(checkTableSchemas(item(withOrders((t) => t.replace("| 子表 | 子表欄位 | 父表 | 父表欄位 | 關係 | 依據 |", "| 子表 | 欄位 | 父表 | 父表欄位 | 關係 | 依據 |")))), /缺少「## 關聯清單」表格.*子表｜子表欄位｜父表｜父表欄位｜關係｜依據/));
});

test("SQL 內的外鍵沒有列在關聯清單：逐一指出（欄位層級與表層級寫法）", () => {
  const r = checkTableSchemas(item(withOrders((t) => t.replace(`${ROW_ORDERS}\n`, "").replace(`${ROW_ITEMS}\n`, ""))));
  assert.ok(has(r, /缺少外鍵 orders\.member_id → members/));
  assert.ok(has(r, /缺少外鍵 order_items\.order_id → orders/));
});

test("依據為外鍵約束但 SQL 沒有：擋；改標邏輯關聯可以", () => {
  const extra = "| order_items | product_name | members | name | 一對多 | 外鍵約束 |";
  assert.ok(has(checkTableSchemas(item(withOrders((t) => `${t}${extra}\n`))), /標示為外鍵約束，但 02-db\.sql 沒有這個外鍵/));
  const logical = extra.replace("外鍵約束", "邏輯關聯");
  assert.deepEqual(checkTableSchemas(item(withOrders((t) => `${t}${logical}\n`))), []);
});

test("關係種類：外鍵欄位 UNIQUE 或主鍵判一對一，否則一對多；與 SQL 不符就擋", () => {
  const sqlOne = SQL.replace("member_id INTEGER NOT NULL REFERENCES", "member_id INTEGER NOT NULL UNIQUE REFERENCES");
  assert.ok(has(checkTableSchemas(item(T(), sqlOne)), /orders\.member_id → members\.id.*關係應為「一對一」/));
  assert.deepEqual(checkTableSchemas(item(withOrders((t) => t.replace(ROW_ORDERS, ROW_ORDERS.replace("一對多", "一對一"))), sqlOne)), []);
  assert.ok(has(checkTableSchemas(item(withOrders((t) => t.replace(ROW_ITEMS, ROW_ITEMS.replace("一對多", "一對一"))))), /order_items\.order_id → orders\.id.*關係應為「一對多」/));
  const sqlPk = parseCreateTables("CREATE TABLE a (id INT PRIMARY KEY); CREATE TABLE b (id INT PRIMARY KEY REFERENCES a(id), x INT);");
  assert.equal(kindOfForeignKey(sqlPk[1], sqlPk[1].foreignKeys[0]), "一對一");
  const sqlUq = parseCreateTables("CREATE TABLE a (id INT PRIMARY KEY); CREATE TABLE b (id INT PRIMARY KEY, a_id INT, UNIQUE (a_id), FOREIGN KEY (a_id) REFERENCES a(id));");
  assert.equal(kindOfForeignKey(sqlUq[1], sqlUq[1].foreignKeys[0]), "一對一");
});

test("必選判定：外鍵欄位 NOT NULL 為必選，否則可選", () => {
  const t = parseCreateTables(SQL);
  assert.equal(isRequired(t[1], ["member_id"]), true);
  assert.equal(isRequired(t[2], ["order_id"]), false);
});

test("關係與依據的值必須合法", () => {
  assert.ok(has(checkTableSchemas(item(withOrders((t) => t.replace(ROW_ORDERS, ROW_ORDERS.replace("一對多", "多對多"))))), /關係「多對多」不合法/));
  assert.ok(has(checkTableSchemas(item(withOrders((t) => t.replace(ROW_ORDERS, ROW_ORDERS.replace("外鍵約束", "外鍵"))))), /依據「外鍵」不合法/));
});

test("邏輯關聯：只檢查格式與表、欄位存在", () => {
  const add = (row) => checkTableSchemas(item(withOrders((t) => `${t}${row}\n`)));
  assert.ok(has(add("| order_items | no_such | orders | id | 一對多 | 邏輯關聯 |"), /子表欄位 no_such 不存在於 order_items/));
  assert.ok(has(add("| order_items | product_name | orders | nope | 一對多 | 邏輯關聯 |"), /父表欄位 nope 不存在於 orders/));
  assert.ok(has(add("| order_items | product_name | ghost | id | 一對多 | 邏輯關聯 |"), /父表 ghost 不存在/));
  assert.ok(has(add("| members | name | orders | id | 一對多 | 邏輯關聯 |"), /子表 members 不在本文件內/));
});

test("邏輯關聯可讓文件內的表連通，且會列在邏輯關聯清單", () => {
  const sqlNoFk = SQL.replace(" REFERENCES members(id)", "");
  const both = `${T().orders.replace(`${ROW_ORDERS}\n`, "").replace("| order_items | 訂單明細 |", "| order_items | 訂單明細 |\n| members | 會員 |")}\n## 資料表：members\n\n${T().members.slice(T().members.indexOf("### 欄位清單"))}`;
  assert.ok(has(checkTableSchemas(item({ orders: both }, sqlNoFk)), /members 與其他表沒有任何關聯/));
  const linked = both.replace(ROW_ITEMS, `${ROW_ITEMS}\n| orders | member_id | members | id | 一對多 | 邏輯關聯 |`);
  const dir = item({ orders: linked }, sqlNoFk);
  const r = checkTableSchemas(dir);
  assert.equal(has(r, /沒有任何關聯/), false, r.join("\n"));
  assert.deepEqual(listLogicalRelations(dir), ["orders.member_id → members.id（一對多）"]);
  assert.deepEqual(listLogicalRelations(path.join(root, "nope")), []);
});

test("parseRelations：多欄位用頓號分隔", () => {
  const r = parseRelations("## 關聯清單\n\n| 子表 | 子表欄位 | 父表 | 父表欄位 | 關係 | 依據 |\n| --- | --- | --- | --- | --- | --- |\n| a | x、y | b | p、q | 一對多 | 外鍵約束 |\n");
  assert.deepEqual(r[0].childCols, ["x", "y"]);
  assert.deepEqual(r[0].parentCols, ["p", "q"]);
});
