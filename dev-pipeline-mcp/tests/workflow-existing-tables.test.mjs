// 既有系統（brownfield）既有資料表來源：專案 .sql 掃描與「既有資料表」一節；以及外鍵可指向既有表。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTmpDir, removeDir } from "./helpers/support.mjs";
import { tableSchemaTemplates } from "./helpers/sasd-standard.mjs";

const { scanProjectTables, parseExistingSection, mergeExisting } = await import("../dist/workflow/existing-tables.js");
const { checkTableSchemas } = await import("../dist/workflow/table-schema-check.js");
const root = makeTmpDir("dpm-exist-");
after(() => removeDir(root));
const w = (p, text) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};

test("scanProjectTables：掃描 .sql 的 CREATE TABLE，略過 node_modules 與 .dev-pipeline", () => {
  const proj = path.join(root, "p1");
  w(path.join(proj, "db", "schema.sql"), "CREATE TABLE members (id INT PRIMARY KEY, name TEXT);\nCREATE TABLE pets (id INT PRIMARY KEY, owner_id INT REFERENCES members(id));");
  w(path.join(proj, "node_modules", "x", "a.sql"), "CREATE TABLE junk (id INT);");
  w(path.join(proj, ".dev-pipeline", "wi", "02-db.sql"), "CREATE TABLE internal (id INT);");
  const t = scanProjectTables(proj);
  assert.deepEqual(t.map((x) => x.name).sort(), ["members", "pets"]);
  assert.deepEqual(t.find((x) => x.name === "pets").foreignKeys[0].parentTable, "members");
  assert.deepEqual(scanProjectTables(null), []);
  assert.deepEqual(scanProjectTables(path.join(root, "不存在")), []);
});

test("parseExistingSection：主鍵、外鍵（含複合與無）；沒有這一節回 null", () => {
  const text = "## 既有資料表\n\n| 資料表 | 主鍵 | 外鍵 | 說明 |\n| --- | --- | --- | --- |\n| members | id | 無 | db_schema 查得 |\n| pets | id | owner_id→members.id；a、b→x.p、q | db_schema 查得 |\n";
  const t = parseExistingSection(text);
  assert.deepEqual(t.map((x) => x.name), ["members", "pets"]);
  assert.deepEqual(t[1].foreignKeys, [{ columns: ["owner_id"], parentTable: "members", parentColumns: ["id"] }, { columns: ["a", "b"], parentTable: "x", parentColumns: ["p", "q"] }]);
  assert.deepEqual(t[0].foreignKeys, []);
  assert.equal(parseExistingSection("## 其他\n"), null);
  assert.deepEqual(parseExistingSection("## 既有資料表\n\n| 資料表 | 主鍵 | 外鍵 | 說明 |\n| --- | --- | --- | --- |\n"), []);
});

test("mergeExisting：一節覆蓋掃描、排除這次新建的表", () => {
  const scanned = [{ name: "a", columns: ["id"], primaryKey: ["id"], foreignKeys: [], uniques: [], notNull: [] }, { name: "b", columns: ["id"], primaryKey: ["id"], foreignKeys: [], uniques: [], notNull: [] }];
  const section = [{ name: "a", columns: ["k"], primaryKey: ["k"], foreignKeys: [], uniques: [], notNull: [] }];
  const r = mergeExisting(scanned, section, ["b"]);
  assert.deepEqual(r.map((x) => [x.name, x.primaryKey[0]]), [["a", "k"]]);
});

const SQL = "CREATE TABLE orders_master (id INTEGER PRIMARY KEY, member_id INTEGER NOT NULL REFERENCES members(id));\nCREATE TABLE orders_detail (id INTEGER PRIMARY KEY, order_id INTEGER, product_name TEXT, quantity INTEGER, subtotal INTEGER, FOREIGN KEY (order_id) REFERENCES orders_master(id));\n";
function item(sql, opts) {
  const dir = path.join(root, `w${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(path.join(dir, "TableSchema"), { recursive: true });
  w(path.join(dir, "02-db.sql"), sql);
  const orders_master = tableSchemaTemplates().orders_master;
  w(path.join(dir, "TableSchema", "orders_master.md"), orders_master);
  return { dir, ...opts };
}
const has = (list, re) => list.some((x) => re.test(x));

test("外鍵指向既有表：greenfield 擋（父表不存在）；brownfield 有既有表來源就通過", () => {
  const { dir } = item(SQL);
  assert.ok(has(checkTableSchemas(dir, { baseline: "greenfield" }), /父表 members 不存在/));
  const proj = path.join(root, "p2");
  w(path.join(proj, "schema.sql"), "CREATE TABLE members (id INT PRIMARY KEY, name TEXT);");
  const r = checkTableSchemas(dir, { baseline: "brownfield", projectDir: proj });
  assert.equal(has(r, /父表/), false, r.join("\n"));
  assert.ok(has(checkTableSchemas(dir, { baseline: "brownfield", projectDir: path.join(root, "空") }), /父表 members 不存在/));
});

test("外鍵指向既有表：沒有腳本時，用 system-er.md 的既有資料表一節", () => {
  const { dir } = item(SQL);
  w(path.join(dir, "TableSchema", "system-er.md"), "## 既有資料表\n\n| 資料表 | 主鍵 | 外鍵 | 說明 |\n| --- | --- | --- | --- |\n| members | id | 無 | db_schema 查得 |\n");
  assert.equal(has(checkTableSchemas(dir, { baseline: "brownfield" }), /父表/), false);
});
