// 步驟 D：資料表結構文件檢查。範本拆成三份（members、orders、order_items）為合格樣本。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTmpDir, removeDir } from "./helpers/support.mjs";
import { tableSchemaTemplates } from "./helpers/sasd-standard.mjs";

const { checkTableSchemas, checkTableSchemaText, parseCreateTables } = await import("../dist/workflow/table-schema-check.js");
const root = makeTmpDir("dpm-tschema-");
after(() => removeDir(root));

const SQL = `-- 會員匯出訂單
CREATE TABLE members (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS "orders" (
  id INTEGER PRIMARY KEY, /* 主鍵 */
  order_no TEXT UNIQUE,
  member_id INTEGER REFERENCES members(id),
  ordered_at TEXT,
  FOREIGN KEY (member_id) REFERENCES members(id)
);
CREATE INDEX idx_orders_member_date ON orders(member_id, ordered_at);
CREATE TABLE dbo.order_items (id INTEGER PRIMARY KEY, order_id INTEGER, product_name TEXT, quantity INTEGER CHECK (quantity > 0), subtotal INTEGER, CONSTRAINT fk FOREIGN KEY (order_id) REFERENCES orders(id));
`;

let n = 0;
/** schemas: { 表名: 內容 }；sql 預設為 SQL。 */
function item(schemas, sql = SQL) {
  const dir = path.join(root, `w${n++}`);
  fs.mkdirSync(path.join(dir, "TableSchema"), { recursive: true });
  fs.writeFileSync(path.join(dir, "02-db.sql"), sql);
  for (const [name, text] of Object.entries(schemas)) fs.writeFileSync(path.join(dir, "TableSchema", `${name}.md`), text);
  return dir;
}
const T = () => tableSchemaTemplates();
const has = (list, re) => list.some((x) => re.test(x));

test("parseCreateTables：引號、schema 前綴、註解、約束列、CHECK 內括號", () => {
  const t = parseCreateTables(SQL);
  assert.deepEqual(t.map((x) => x.name), ["members", "orders", "order_items"]);
  assert.deepEqual(t[0].columns, ["id", "name", "created_at"]);
  assert.deepEqual(t[1].columns, ["id", "order_no", "member_id", "ordered_at"]);
  assert.deepEqual(t[2].columns, ["id", "order_id", "product_name", "quantity", "subtotal"]);
});

test("範本拆成三份：全部合格", () => {
  assert.deepEqual(checkTableSchemas(item(T())), []);
});

test("沒有 02-db.sql 或沒有 CREATE TABLE：不要求結構文件", () => {
  assert.deepEqual(checkTableSchemas(path.join(root, "不存在")), []);
  assert.deepEqual(checkTableSchemas(item({}, "ALTER TABLE members ADD COLUMN x TEXT;")), []);
});

test("缺資料表結構文件", () => {
  const { orders, ...rest } = T();
  assert.ok(has(checkTableSchemas(item(rest)), /資料表 orders 缺少結構文件 TableSchema\/orders\.md/));
});

test("缺版本管控歷程", () => {
  const bad = T().orders.replace(/## 版本管控歷程[\s\S]*?(?=## 欄位清單)/, "");
  assert.ok(has(checkTableSchemas(item({ ...T(), orders: bad })), /orders\.md 缺少「## 版本管控歷程」/));
});

test("版本管控歷程內容違規", () => {
  const bad = T().orders.replace("| 1.0 | 2026/11/10 | 初版 |", "| 1.0 | 2026-11-10 | 初版 |");
  assert.ok(has(checkTableSchemas(item({ ...T(), orders: bad })), /發行日期/));
});

test("欄位清單表頭錯誤或缺章節", () => {
  const badHeader = T().members.replace("| # | 欄位 | 型別 | PK | 說明 |", "| 序 | 欄位 | 型別 | 主鍵 | 說明 |");
  assert.ok(has(checkTableSchemas(item({ ...T(), members: badHeader })), /表頭固定為：#｜欄位｜型別｜PK｜說明/));
  const none = T().members.replace("## 欄位清單", "## 欄位");
  assert.ok(has(checkTableSchemas(item({ ...T(), members: none })), /缺少「## 欄位清單」/));
});

test("欄位清單缺 SQL 內的欄位（不分大小寫比對）", () => {
  const bad = T().order_items.replace(/\| 5 \| subtotal[^\n]*\n/, "");
  const r = checkTableSchemas(item({ ...T(), order_items: bad }));
  assert.ok(has(r, /缺少 02-db\.sql 中的欄位：subtotal/));
  const upper = T().members.replace("| name |", "| NAME |");
  assert.deepEqual(checkTableSchemas(item({ ...T(), members: upper })), []);
});

test("缺各規格使用欄位對照、表頭錯誤、沒有資料列、沒有相對連結", () => {
  const none = T().orders.replace("## 各規格使用欄位對照", "## 使用");
  assert.ok(has(checkTableSchemas(item({ ...T(), orders: none })), /缺少「## 各規格使用欄位對照」/));
  const header = T().orders.replace("| 規格 | 使用欄位 |", "| 文件 | 欄位 |");
  assert.ok(has(checkTableSchemas(item({ ...T(), orders: header })), /表頭固定為：規格｜使用欄位/));
  const empty = T().orders.replace(/\| \[會員匯出訂單 Excel\][^\n]*\n/, "");
  assert.ok(has(checkTableSchemas(item({ ...T(), orders: empty })), /至少要有一列/));
  const noLink = T().orders.replace("[會員匯出訂單 Excel](../orders-export.md)", "會員匯出訂單 Excel");
  assert.ok(has(checkTableSchemas(item({ ...T(), orders: noLink })), /相對路徑連結/));
  const abs = T().orders.replace("../orders-export.md", "https://example.com/x.md");
  assert.ok(has(checkTableSchemas(item({ ...T(), orders: abs })), /相對路徑連結/));
});

test("checkTableSchemaText 可單獨使用", () => {
  assert.deepEqual(checkTableSchemaText(T().members, "TableSchema/members.md", ["id", "name", "created_at"]), []);
});
