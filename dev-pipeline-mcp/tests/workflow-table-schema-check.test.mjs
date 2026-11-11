// 資料表結構文件檢查（分組格式）。範本拆成 orders（含 order_items）與 members 兩份文件為合格樣本。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTmpDir, removeDir } from "./helpers/support.mjs";
import { tableSchemaTemplates, TEMPLATE_SQL, installSchemaExtras } from "./helpers/sasd-standard.mjs";

const { checkTableSchemas, checkTableSection, parseCreateTables } = await import("../dist/workflow/table-schema-check.js");
const root = makeTmpDir("dpm-tschema-");
after(() => removeDir(root));

const SQL = TEMPLATE_SQL;
const SQL_NO_MEMBER_FK = SQL.replace("member_id INTEGER NOT NULL REFERENCES members(id),", "member_id INTEGER NOT NULL,").replace("  FOREIGN KEY (member_id) REFERENCES members(id)\n", "  CHECK (1 = 1)\n");

let n = 0;
/** schemas: { 檔名: 內容 }；sql 預設為 SQL。 */
function item(schemas, sql = SQL) {
  const dir = path.join(root, `w${n++}`);
  fs.mkdirSync(path.join(dir, "TableSchema"), { recursive: true });
  fs.writeFileSync(path.join(dir, "02-db.sql"), sql);
  installSchemaExtras(dir);
  for (const [name, text] of Object.entries(schemas)) fs.writeFileSync(path.join(dir, "TableSchema", `${name}.md`), text);
  return dir;
}
const T = () => tableSchemaTemplates();
const has = (list, re) => list.some((x) => re.test(x));
const sectionOf = (text, name) => text.slice(text.indexOf(`## 資料表：${name}`)).split("\n## ")[0];

test("parseCreateTables：引號、schema 前綴、註解、約束列、CHECK 內括號", () => {
  const t = parseCreateTables(SQL);
  assert.deepEqual(t.map((x) => x.name), ["members", "orders", "order_items"]);
  assert.deepEqual(t[0].columns, ["id", "name", "created_at"]);
  assert.deepEqual(t[1].columns, ["id", "order_no", "member_id", "ordered_at"]);
  assert.deepEqual(t[2].columns, ["id", "order_id", "product_name", "quantity", "subtotal"]);
});

test("parseCreateTables：主鍵、外鍵（欄位層級與表層級）、唯一、ALTER 外鍵", () => {
  const t = parseCreateTables(`${SQL}ALTER TABLE members ADD CONSTRAINT fk2 FOREIGN KEY (id) REFERENCES orders(id);`);
  assert.deepEqual(t[1].primaryKey, ["id"]);
  assert.equal(t[1].foreignKeys.length, 2);
  assert.deepEqual(t[1].uniques, [["order_no"]]);
  assert.deepEqual(t[2].foreignKeys, [{ columns: ["order_id"], parentTable: "orders", parentColumns: ["id"] }]);
  assert.equal(t[0].foreignKeys.length, 1);
});

test("範本兩份文件：全部合格", () => {
  assert.deepEqual(Object.keys(T()).sort(), ["members", "orders"]);
  assert.deepEqual(checkTableSchemas(item(T())), []);
});

test("沒有 02-db.sql 或沒有 CREATE TABLE：不要求結構文件", () => {
  assert.deepEqual(checkTableSchemas(path.join(root, "不存在")), []);
  assert.deepEqual(checkTableSchemas(item({}, "ALTER TABLE members ADD COLUMN x TEXT;")), []);
});

test("SQL 的表沒有出現在任何文件", () => {
  const { orders, ...rest } = T();
  assert.ok(has(checkTableSchemas(item(rest)), /資料表 orders 沒有出現在任何 TableSchema\/ 文件/));
});

test("同一張表出現在多份文件、小節重複、文件內的表不在 SQL", () => {
  const dup = `${T().members}\n${sectionOf(T().orders, "orders")}`;
  assert.ok(has(checkTableSchemas(item({ ...T(), members: dup })), /同時出現在多份文件/));
  const twice = `${T().orders}\n${sectionOf(T().orders, "orders")}`;
  assert.ok(has(checkTableSchemas(item({ ...T(), orders: twice })), /資料表 orders 小節重複出現/));
  const ghost = T().members.replace("## 資料表：members", "## 資料表：ghost").replace("| members | 會員 |", "| ghost | 會員 |");
  assert.ok(has(checkTableSchemas(item({ ...T(), members: ghost })), /ghost 不在 02-db\.sql 的 CREATE TABLE 內/));
});

test("沒有關聯的表不可硬湊同一份文件；有外鍵連通可以", () => {
  const noRow = T().orders.replace("| orders | member_id | members | id | 一對多 | 外鍵約束 |\n", "");
  const both = `${noRow.replace("| order_items | 訂單明細 |", "| order_items | 訂單明細 |\n| members | 會員 |")}\n${sectionOf(T().members, "members")}`;
  const r = checkTableSchemas(item({ orders: both }, SQL_NO_MEMBER_FK));
  assert.ok(has(r, /members 與其他表沒有任何關聯/), r.join("\n"));
  assert.equal(has(checkTableSchemas(item({ orders: both })), /沒有任何關聯/), false);
});

test("檔名必須是主表名、包含清單必須與小節一致、缺包含清單", () => {
  const swapped = T().orders.replace("| orders | 訂單主檔 |\n| order_items | 訂單明細 |", "| order_items | 訂單明細 |\n| orders | 訂單主檔 |");
  assert.ok(has(checkTableSchemas(item({ ...T(), orders: swapped })), /檔名必須是主表名/));
  const missing = T().orders.replace("| order_items | 訂單明細 |\n", "");
  assert.ok(has(checkTableSchemas(item({ ...T(), orders: missing })), /必須與文件內的「資料表：」小節.*一致/));
  const none = T().members.replace("## 本文件包含的資料表", "## 內容");
  assert.ok(has(checkTableSchemas(item({ ...T(), members: none })), /缺少「## 本文件包含的資料表」/));
});

test("缺版本管控歷程（整份一次）與內容違規", () => {
  const bad = T().orders.replace(/## 版本管控歷程[\s\S]*?(?=## 資料表：orders)/, "");
  assert.ok(has(checkTableSchemas(item({ ...T(), orders: bad })), /orders\.md 缺少「## 版本管控歷程」/));
  const bad2 = T().orders.replace("| 1.0 | 2026/11/10 | 初版 |", "| 1.0 | 2026-11-10 | 初版 |");
  assert.ok(has(checkTableSchemas(item({ ...T(), orders: bad2 })), /發行日期/));
});

test("每張表小節各自檢查欄位清單：表頭、缺章節、缺欄位（不分大小寫）", () => {
  const badHeader = T().members.replace("| # | 欄位 | 型別 | PK | 說明 |", "| 序 | 欄位 | 型別 | 主鍵 | 說明 |");
  assert.ok(has(checkTableSchemas(item({ ...T(), members: badHeader })), /members」「欄位清單」必須是表格，表頭固定為：#｜欄位｜型別｜PK｜說明/));
  const none = T().members.replace("### 欄位清單", "### 欄位");
  assert.ok(has(checkTableSchemas(item({ ...T(), members: none })), /缺少「### 欄位清單」/));
  const bad = T().orders.replace(/\| 5 \| subtotal[^\n]*\n/, "");
  const r = checkTableSchemas(item({ ...T(), orders: bad }));
  assert.ok(has(r, /資料表：order_items」「欄位清單」缺少 02-db\.sql 中的欄位：subtotal/), r.join("\n"));
  assert.deepEqual(checkTableSchemas(item({ ...T(), members: T().members.replace("| name |", "| NAME |") })), []);
});

test("各規格使用欄位對照：缺章節、表頭錯誤、沒有資料列、沒有相對連結", () => {
  const t = T().members;
  const run = (text) => checkTableSchemas(item({ ...T(), members: text }));
  assert.ok(has(run(t.replace("### 各規格使用欄位對照", "### 使用")), /缺少「### 各規格使用欄位對照」/));
  assert.ok(has(run(t.replace("| 規格 | 使用欄位 |", "| 文件 | 欄位 |")), /表頭固定為：規格｜使用欄位/));
  assert.ok(has(run(t.replace(/\| \[會員匯出訂單 Excel\][^\n]*\n/, "")), /至少要有一列/));
  assert.ok(has(run(t.replace("[會員匯出訂單 Excel](../orders-export.md)", "會員匯出訂單 Excel")), /相對路徑連結/));
  assert.ok(has(run(t.replace("../orders-export.md", "https://example.com/x.md")), /相對路徑連結/));
});

test("checkTableSection 可單獨使用", () => {
  assert.deepEqual(checkTableSection(sectionOf(T().members, "members"), "x", ["id", "name", "created_at"]), []);
});
