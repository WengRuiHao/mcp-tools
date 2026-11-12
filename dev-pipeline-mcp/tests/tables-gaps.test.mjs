// 資料表檢查補強（問題 42／51／52／53／54）：ALTER 新增外鍵、既有表必選標記、有 DDL 時的既有表分組、無使用表時不要求文件、部分欄位既有表的 ER 欄位交叉比對。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTmpDir, removeDir } from "./helpers/support.mjs";
import { noChangeDocs, writeNoChangeItem, EXISTING_SECTION } from "./helpers/no-change-fixture.mjs";

const { checkTableSchemas } = await import("../dist/workflow/table-schema-check.js");
const { parseAlterChanges, parseCreateTables } = await import("../dist/workflow/sql-schema-parse.js");
const { parseExistingSection } = await import("../dist/workflow/existing-tables.js");
const root = makeTmpDir("dpm-tables-gaps-");
after(() => removeDir(root));

let n = 0;
const run = (over = {}, opts = { baseline: "brownfield" }) => checkTableSchemas(writeNoChangeItem(path.join(root, `w${n++}`), over), opts);
const has = (list, re) => list.some((x) => re.test(x));
const D = () => noChangeDocs();
const ALTER_SQL = "ALTER TABLE orders ADD CONSTRAINT fk_orders_member FOREIGN KEY (member_id) REFERENCES members(id);\n";
// 既有資料表一節中 orders 沒有宣告外鍵，外鍵由 ALTER 新增
const NO_ORDERS_FK = EXISTING_SECTION.replace("member_id→members.id", "無");
const sysMarked = (t) => t.replace("INTEGER id PK\n        INTEGER member_id FK", 'INTEGER id PK "本次修改"\n        INTEGER member_id FK');
const alterSystem = () => sysMarked(D().systemEr).replace(EXISTING_SECTION, NO_ORDERS_FK);

// ---------- 42 ----------
test("42 parseAlterChanges：表層級與欄位層級外鍵、多個 ADD 動作、無外鍵者不回傳", () => {
  const c = parseAlterChanges(`
    ALTER TABLE orders ADD CONSTRAINT fk1 FOREIGN KEY (member_id) REFERENCES members(id);
    ALTER TABLE public.items ADD FOREIGN KEY (order_id) REFERENCES orders;
    ALTER TABLE coupons ADD COLUMN owner_id INTEGER NOT NULL REFERENCES members(id), ADD COLUMN note TEXT;
    ALTER TABLE members ADD COLUMN phone TEXT;
    ALTER TABLE members ADD CONSTRAINT u UNIQUE (phone);
    -- ALTER TABLE ghost ADD FOREIGN KEY (a) REFERENCES b(id);
  `);
  assert.deepEqual(c.map((x) => x.table), ["orders", "items", "coupons"]);
  assert.deepEqual(c[0].foreignKeys, [{ columns: ["member_id"], parentTable: "members", parentColumns: ["id"] }]);
  assert.deepEqual(c[1].foreignKeys, [{ columns: ["order_id"], parentTable: "orders", parentColumns: [] }]);
  assert.deepEqual(c[2].columns, ["owner_id"]);
  assert.deepEqual(c[2].notNull, ["owner_id"]);
});

test("42 parseCreateTables：ADD COLUMN ... REFERENCES 也套用到同份 SQL 建立的表", () => {
  const t = parseCreateTables("CREATE TABLE a (id INT PRIMARY KEY);\nALTER TABLE a ADD COLUMN b_id INT NOT NULL REFERENCES b(id);");
  assert.deepEqual(t[0].columns, ["id", "b_id"]);
  assert.deepEqual(t[0].foreignKeys, [{ columns: ["b_id"], parentTable: "b", parentColumns: ["id"] }]);
  assert.deepEqual(t[0].notNull, ["b_id"]);
});

test("42 正向：ALTER 對既有表新增外鍵，關聯清單與系統 ER 圖都有 → 通過", () => {
  assert.deepEqual(run({ sql: ALTER_SQL, systemEr: alterSystem() }), []);
});

test("42 反向：ALTER 新增的外鍵沒列在關聯清單", () => {
  const orders = D().orders.replace("| orders | member_id | members | id | 一對多 | 外鍵約束 |\n", "");
  const r = run({ sql: ALTER_SQL, orders, systemEr: alterSystem() });
  assert.ok(has(r, /缺少外鍵 orders\.member_id → members/), r.join("\n"));
});

test("42 反向：ALTER 新增的外鍵沒畫在系統 ER 圖", () => {
  const sys = alterSystem().replace(/    members \|o--o\{ orders[^\n]*\n/, "");
  const r = run({ sql: ALTER_SQL, systemEr: sys });
  assert.ok(has(r, /system-er\.md.*缺少關聯線 members→orders/), r.join("\n"));
});

test("42 反向：被 ALTER 加外鍵的既有表沒進任何分組文件", () => {
  const r = run({ sql: ALTER_SQL, orders: null, systemEr: alterSystem() });
  assert.ok(has(r, /ALTER TABLE 對既有資料表 orders 新增了外鍵.*分組文件/), r.join("\n"));
});

test("42 反向：被 ALTER 的既有表系統圖沒標「本次修改」", () => {
  const r = run({ sql: ALTER_SQL, systemEr: D().systemEr.replace(EXISTING_SECTION, NO_ORDERS_FK) });
  assert.ok(has(r, /表 orders 要標「本次修改」/), r.join("\n"));
});

test("42 對照：ALTER 沒有外鍵（ADD COLUMN）、greenfield 都不要求結構文件", () => {
  assert.deepEqual(run({ sql: "ALTER TABLE members ADD COLUMN phone TEXT;\n", orders: null, members: null }, { baseline: "greenfield" }), []);
});

// ---------- 51 ----------
test("51 parseExistingSection：外鍵項目尾端的必選標記（NOT NULL／必選／（必選））", () => {
  const text = "## 既有資料表\n\n| 資料表 | 主鍵 | 外鍵 | 說明 |\n| --- | --- | --- | --- |\n| a | id | x_id→x.id 必選；y_id→y.id | s |\n| b | id | z_id→z.id NOT NULL | s |\n| c | id | w_id→w.id（必選） | s |\n| d | id | v_id→v.id | s |\n";
  const t = parseExistingSection(text);
  assert.deepEqual(t.map((x) => x.notNull), [["x_id"], ["z_id"], ["w_id"], []]);
  assert.deepEqual(t[0].foreignKeys, [{ columns: ["x_id"], parentTable: "x", parentColumns: ["id"] }, { columns: ["y_id"], parentTable: "y", parentColumns: ["id"] }]);
  assert.deepEqual(t[2].foreignKeys[0].parentColumns, ["id"]);
});

const REQ_SECTION = EXISTING_SECTION.replace("order_id→orders.id", "order_id→orders.id 必選");
const reqOrders = () => D().orders.replace("orders |o--o{ order_items", "orders ||--o{ order_items");
const reqSystem = () => D().systemEr.replace(EXISTING_SECTION, REQ_SECTION).replace("orders |o--o{ order_items", "orders ||--o{ order_items");

test("51 正向：標了必選，圖畫必選符號 → 通過", () => {
  assert.deepEqual(run({ orders: reqOrders(), systemEr: reqSystem() }), []);
});

test("51 反向：標了必選，圖卻畫可選符號（模組圖與系統圖都擋）", () => {
  const r = run({ systemEr: D().systemEr.replace(EXISTING_SECTION, REQ_SECTION) });
  assert.ok(has(r, /orders\.md 的模組 ER 圖.*符號與關聯清單不一致.*orders \|\|--o\{ order_items.*必選/), r.join("\n"));
  assert.ok(has(r, /system-er\.md.*符號與關聯清單不一致/), r.join("\n"));
});

test("51 反向／對照：沒標必選就畫必選符號仍擋，沒標記維持可選（舊行為）", () => {
  const r = run({ orders: reqOrders(), systemEr: D().systemEr.replace("orders |o--o{ order_items", "orders ||--o{ order_items") });
  assert.ok(has(r, /符號與關聯清單不一致/), r.join("\n"));
  assert.deepEqual(run(), []);
});

// ---------- 52 ----------
const TAGS_SQL = "CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT, created_at TEXT);\n";
const tagsDoc = () => D().members.replaceAll("members", "tags");
const tagsSystem = () => D().systemEr.replace("    members {", '    tags {\n        INTEGER id PK "本次新增"\n    }\n    members {');
const tagsItem = (over) => {
  const dir = writeNoChangeItem(path.join(root, `w${n++}`), { sql: TAGS_SQL, systemEr: tagsSystem(), ...over });
  fs.writeFileSync(path.join(dir, "TableSchema", "tags.md"), tagsDoc());
  fs.copyFileSync(path.join(dir, "TableSchema", "er", "members.png"), path.join(dir, "TableSchema", "er", "tags.png"));
  return dir;
};

test("52 正向：有 DDL（CREATE tags）時，既有表（members、orders…）仍可收進分組文件", () => {
  const r = checkTableSchemas(tagsItem(), { baseline: "brownfield" });
  assert.deepEqual(r, [], r.join("\n"));
});

test("52 反向：有 DDL 時，文件內既不是 CREATE TABLE 也不是既有表的表仍擋；既有表欄位清單缺漏仍擋", () => {
  const ghost = D().members.replace("## 資料表：members", "## 資料表：ghost").replace("| members | 會員 |", "| ghost | 會員 |");
  assert.ok(has(checkTableSchemas(tagsItem({ members: ghost }), { baseline: "brownfield" }), /ghost 不在 02-db\.sql 的 CREATE TABLE 內，也不是既有資料表/));
  const dropped = D().orders.replace(/\| 4 \| ordered_at[^\n]*\n/, "");
  assert.ok(has(checkTableSchemas(tagsItem({ orders: dropped }), { baseline: "brownfield" }), /orders」「欄位清單」缺少 既有資料表宣告.*ordered_at/));
});

// ---------- 53 ----------
const HEADER_ONLY = "## 既有資料表\n\n| 資料表 | 主鍵 | 外鍵 | 欄位 | 說明 |\n| --- | --- | --- | --- | --- |\n";
const NONE_ROW = `${HEADER_ONLY}| 無 | 無 | 無 | 無 | 本次沒有使用任何資料表 |\n`;

test("53 正向：既有資料表一節為空或寫「無」、沒有分組文件 → 通過（即使專案 .sql 掃得到表）", () => {
  const sys = (s) => D().systemEr.replace(EXISTING_SECTION, s);
  assert.deepEqual(run({ orders: null, members: null, systemEr: sys(HEADER_ONLY) }), []);
  assert.deepEqual(run({ orders: null, members: null, systemEr: sys(NONE_ROW) }), []);
  const proj = path.join(root, "proj53");
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, "s.sql"), "CREATE TABLE members (id INTEGER PRIMARY KEY);");
  assert.deepEqual(run({ orders: null, members: null, systemEr: sys(HEADER_ONLY) }, { baseline: "brownfield", projectDir: proj }), []);
});

test("53 反向／對照：列了既有表卻沒有分組文件仍擋；章節缺少也沒有 .sql 仍要求補章節", () => {
  assert.ok(has(run({ orders: null, members: null }), /沒有任何分組文件/));
  assert.ok(has(run({ orders: null, members: null, systemEr: D().systemEr.replace(EXISTING_SECTION, "") }), /取不到既有資料表/));
});

// ---------- 54 ----------
test("54 反向：模組 ER 圖的既有表（部分欄位）列了欄位清單沒有的欄位", () => {
  const orders = D().orders.replace('TEXT order_no "訂單編號"', 'TEXT order_no "訂單編號"\n        TEXT secret_code');
  const r = run({ orders });
  assert.ok(has(r, /orders\.md 的模組 ER 圖 的表 orders 是只知道部分欄位的既有表，圖上的欄位 secret_code 不在它的欄位清單內/), r.join("\n"));
});

test("54 反向：系統 ER 圖的既有表列了欄位清單沒有的欄位；列在清單內的欄位通過", () => {
  const bad = D().systemEr.replace("INTEGER id PK\n    }\n    orders {", "INTEGER id PK\n        TEXT nickname\n    }\n    orders {");
  assert.ok(has(run({ systemEr: bad }), /system-er\.md 的系統 ER 圖 的表 members .*欄位 nickname 不在它的欄位清單內/));
  const ok = D().systemEr.replace("INTEGER id PK\n    }\n    orders {", "INTEGER id PK\n        TEXT name\n    }\n    orders {");
  assert.deepEqual(run({ systemEr: ok }), []);
});

test("54 正向：圖上欄位只出現在文件欄位清單（既有資料表一節沒有「欄位」欄）也算數", () => {
  const OLD = "## 既有資料表\n\n| 資料表 | 主鍵 | 外鍵 | 說明 |\n| --- | --- | --- | --- |\n| members | id | 無 | x |\n| orders | id | member_id→members.id | x |\n| order_items | id | order_id→orders.id | x |\n";
  assert.deepEqual(run({ systemEr: D().systemEr.replace(EXISTING_SECTION, OLD) }), []);
});
