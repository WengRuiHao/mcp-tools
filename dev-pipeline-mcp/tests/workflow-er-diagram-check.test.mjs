// ER 圖檢查：Mermaid erDiagram 解析、圖與表／關聯清單的一致性、模組與系統 ER 圖文件、brownfield 標註與既有資料表。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTmpDir, removeDir } from "./helpers/support.mjs";
import { tableSchemaTemplates, TEMPLATE_SQL, installSchemaExtras, systemErTemplate } from "./helpers/sasd-standard.mjs";

const { parseErDiagram } = await import("../dist/workflow/er-parse.js");
const { checkErDiagram, lineText } = await import("../dist/workflow/er-diagram-check.js");
const { checkTableSchemas } = await import("../dist/workflow/table-schema-check.js");
const { parseCreateTables } = await import("../dist/workflow/sql-schema-parse.js");
const root = makeTmpDir("dpm-er-");
after(() => removeDir(root));
const has = (list, re) => list.some((x) => re.test(x));
const T = () => tableSchemaTemplates();
const tables = parseCreateTables(TEMPLATE_SQL);

let n = 0;
function item(opts = {}) {
  const dir = path.join(root, `w${n++}`);
  fs.mkdirSync(path.join(dir, "TableSchema"), { recursive: true });
  fs.writeFileSync(path.join(dir, "02-db.sql"), opts.sql ?? TEMPLATE_SQL);
  for (const [k, v] of Object.entries({ ...T(), ...(opts.docs ?? {}) }).filter(([, x]) => x !== undefined)) fs.writeFileSync(path.join(dir, "TableSchema", `${k}.md`), v);
  installSchemaExtras(dir);
  if (opts.system) fs.writeFileSync(path.join(dir, "TableSchema", "system-er.md"), opts.system);
  return dir;
}

test("parseErDiagram：實體、屬性（PK, FK 與註解）、關聯線、未知行", () => {
  const d = parseErDiagram('erDiagram\n  a ||--o{ b : "x"\n  b {\n    INT id PK, FK "本次新增"\n    TEXT name\n  }\n  c\n  ???\n');
  assert.deepEqual([...d.entities.keys()], ["a", "b", "c"]);
  assert.deepEqual(d.entities.get("b")[0].keys, ["PK", "FK"]);
  assert.equal(d.entities.get("b")[0].comment, "本次新增");
  assert.equal(d.lines[0].leftSym, "||");
  assert.equal(d.lines[0].rightSym, "o{");
  assert.equal(d.unknown.length, 1);
});

test("範本（含系統 ER 圖與 PNG）全部合格", () => {
  assert.deepEqual(checkTableSchemas(item()), []);
});

const scope = (names, rels = []) => ({ tables: tables.filter((t) => names.includes(t.name)), relations: rels });
const REL = { parent: "orders_master", child: "orders_detail", kind: "一對多", required: true };

test("checkErDiagram：表集合必須相等（缺表、多表）", () => {
  const src = "erDiagram\n  orders_master {\n    INTEGER id PK\n    INTEGER member_id FK\n  }\n  ghost {\n    INT id PK\n  }\n";
  const r = checkErDiagram(src, "圖A", scope(["orders_master", "orders_detail"]));
  assert.ok(has(r, /圖A 缺少資料表：orders_detail/));
  assert.ok(has(r, /圖A 多了範圍外的資料表：ghost/));
});

test("checkErDiagram：PK／FK 必須列出並標註；憑空欄位與錯標被擋；其他欄位可不列", () => {
  const ok = "erDiagram\n  orders_detail {\n    INTEGER id PK\n    INTEGER order_id FK\n  }\n";
  assert.deepEqual(checkErDiagram(ok, "圖", scope(["orders_detail"])), []);
  assert.ok(has(checkErDiagram("erDiagram\n  orders_detail {\n    INTEGER id PK\n  }\n", "圖", scope(["orders_detail"])), /表 orders_detail 缺少外鍵欄位 order_id/));
  assert.ok(has(checkErDiagram("erDiagram\n  orders_detail {\n    INTEGER id\n    INTEGER order_id FK\n  }\n", "圖", scope(["orders_detail"])), /欄位 id 是主鍵，要標註 PK/));
  assert.ok(has(checkErDiagram("erDiagram\n  orders_detail {\n    INTEGER id PK\n    INTEGER order_id FK\n    TEXT nope\n  }\n", "圖", scope(["orders_detail"])), /列了 SQL 沒有的欄位 nope/));
  assert.ok(has(checkErDiagram("erDiagram\n  orders_detail {\n    INTEGER id PK\n    INTEGER order_id FK\n    TEXT product_name PK\n  }\n", "圖", scope(["orders_detail"])), /product_name 標註了 PK，但 SQL 裡它不是主鍵/));
});

test("checkErDiagram：關聯線要與關聯一一對應（缺線、多線、方向、符號）", () => {
  const ents = "  orders_master {\n    INTEGER id PK\n    INTEGER member_id FK\n  }\n  orders_detail {\n    INTEGER id PK\n    INTEGER order_id FK\n  }\n";
  const sc = scope(["orders_master", "orders_detail"], [REL]);
  assert.equal(lineText(REL), "orders_master ||--o{ orders_detail");
  assert.deepEqual(checkErDiagram(`erDiagram\n  orders_master ||--o{ orders_detail : "x"\n${ents}`, "圖", sc), []);
  assert.ok(has(checkErDiagram(`erDiagram\n${ents}`, "圖", sc), /缺少關聯線 orders_master→orders_detail.*orders_master \|\|--o\{ orders_detail/));
  assert.ok(has(checkErDiagram(`erDiagram\n  orders_detail }o--|| orders_master : "x"\n${ents}`, "圖", sc), /方向相反/));
  assert.ok(has(checkErDiagram(`erDiagram\n  orders_master |o--o| orders_detail : "x"\n${ents}`, "圖", sc), /第 2 行的關聯線 orders_master \|o--o\| orders_detail 符號與關聯清單不一致.*必選、一對多/));
  assert.ok(has(checkErDiagram(`erDiagram\n  orders_master ||--o{ orders_detail : "x"\n  orders_detail ||--o{ orders_master : "y"\n${ents}`, "圖", sc), /沒有對應的關聯清單項目/));
});

test("符號對應：必選 ||、可選 |o；一對多 o{、一對一 o|", () => {
  assert.equal(lineText({ parent: "a", child: "b", kind: "一對多", required: false }), "a |o--o{ b");
  assert.equal(lineText({ parent: "a", child: "b", kind: "一對一", required: true }), "a ||--o| b");
  assert.equal(lineText({ parent: "a", child: "b", kind: "一對一", required: false }), "a |o--o| b");
});

test("圖內容先過 mermaid-check（未知圖類型、空內容）", () => {
  assert.ok(has(checkErDiagram("hello", "圖", scope([])), /圖內容不合格/));
  assert.ok(has(checkErDiagram("", "圖", scope([])), /圖內容不合格.*ER 圖 是空的/));
});

const modify = (dir, file, fn) => {
  const f = path.join(dir, "TableSchema", file);
  fs.writeFileSync(f, fn(fs.readFileSync(f, "utf-8")));
};

test("模組 ER 圖：缺章節、缺圖片、PNG 壞檔、圖與關聯不符，訊息指出文件與圖", () => {
  let dir = item();
  modify(dir, "orders_master.md", (t) => t.replace("## 模組 ER 圖", "## 圖"));
  assert.ok(has(checkTableSchemas(dir), /TableSchema\/orders_master\.md 缺少「## 模組 ER 圖」一節/));
  dir = item();
  modify(dir, "orders_master.md", (t) => t.replace("![訂單模組 ER 圖](er/orders_master.png)", ""));
  assert.ok(has(checkTableSchemas(dir), /orders_master\.md「模組 ER 圖」要用圖片引用轉出的 PNG：!\[說明\]\(er\/orders_master\.png\)/));
  dir = item();
  fs.writeFileSync(path.join(dir, "TableSchema", "er", "orders_master.png"), "not a png");
  assert.ok(has(checkTableSchemas(dir), /er\/orders_master\.png 不存在或不是有效的 PNG/));
  dir = item();
  modify(dir, "orders_master.md", (t) => t.replace('orders_master ||--o{ orders_detail : "一張訂單有多筆明細"', ""));
  assert.ok(has(checkTableSchemas(dir), /orders_master\.md 的模組 ER 圖 缺少關聯線 orders_master→orders_detail/));
  dir = item();
  modify(dir, "orders_master.md", (t) => t.replace("INTEGER order_id FK", "INTEGER order_id"));
  assert.ok(has(checkTableSchemas(dir), /orders_master\.md 的模組 ER 圖 的表 orders_detail 的欄位 order_id 是外鍵，要標註 FK/));
});

test("系統 ER 圖：缺文件、缺圖、表集合與關聯線不符", () => {
  let dir = item();
  fs.rmSync(path.join(dir, "TableSchema", "system-er.md"));
  assert.ok(has(checkTableSchemas(dir), /缺少系統 ER 圖文件 TableSchema\/system-er\.md/));
  dir = item({ system: systemErTemplate().replace("    orders_detail {\n        INTEGER id PK\n        INTEGER order_id FK\n    }\n", "") });
  assert.ok(has(checkTableSchemas(dir), /system-er\.md 的系統 ER 圖 的表 orders_detail 缺少主鍵欄位 id/));
  dir = item({ system: systemErTemplate().replace('    members ||--o{ orders_master : "一位會員有多張訂單"\n', "") });
  assert.ok(has(checkTableSchemas(dir), /system-er\.md 的系統 ER 圖 缺少關聯線 members→orders_master/));
  dir = item({ system: systemErTemplate().replace("![系統 ER 圖](er/system-er.png)", "![x](er/other.png)") });
  assert.ok(has(checkTableSchemas(dir), /系統 ER 圖」要用圖片引用轉出的 PNG/));
  dir = item({ system: systemErTemplate().replace("## 版本管控歷程", "## 歷程") });
  assert.ok(has(checkTableSchemas(dir), /system-er\.md 缺少「## 版本管控歷程」/));
});

const BROWN_SQL = "CREATE TABLE orders_master (id INTEGER PRIMARY KEY, member_id INTEGER NOT NULL REFERENCES members(id));\nALTER TABLE members ADD COLUMN phone TEXT;\n";
const EXISTING = "## 既有資料表\n\n| 資料表 | 主鍵 | 外鍵 | 說明 |\n| --- | --- | --- | --- |\n| members | id | 無 | db_schema 查得 |\n| coupons | id | member_id→members.id | db_schema 查得 |\n\n";
const fence = "```";
const brownSystem = (orders_master, members, coupons, extra = "") => `${systemErTemplate().split("## 系統 ER 圖")[0]}${EXISTING}## 系統 ER 圖\n\n${fence}mermaid\nerDiagram\n    members ||--o{ orders_master : "x"\n    members |o--o{ coupons : "y"\n    members {\n        INTEGER id PK ${members}\n    }\n    orders_master {\n        INTEGER id PK ${orders_master}\n        INTEGER member_id FK\n    }\n    coupons {\n        INTEGER id PK ${coupons}\n        INTEGER member_id FK\n    }\n${extra}${fence}\n\n![系統 ER 圖](er/system-er.png)\n`;

function brownItem(system) {
  const dir = item({ sql: BROWN_SQL, docs: { orders_master: brownOrders(), members: undefined }, system });
  return dir;
}
function brownOrders() {
  const t = T().orders_master;
  const cut = t.indexOf("## 資料表：orders_detail");
  const rel = t.indexOf("## 關聯清單");
  return `${t.slice(0, cut)}${t.slice(rel)}`
    .replace("| orders_detail | 訂單明細 |\n", "")
    .replace(/\| orders_detail \| order_id[^\n]*\n/, "")
    .replace(/    orders_master \|\|--o\{ orders_detail[^\n]*\n/, "")
    .replace(/    orders_detail \{[\s\S]*?    \}\n/, "")
    .replace("### 索引", "### 索引");
}

test("brownfield：系統圖含既有表，本次新增與本次修改要標註；既有表來源可用既有資料表一節", () => {
  const good = brownSystem('"本次新增"', '"本次修改"', "");
  const dir = brownItem(good);
  const r = checkTableSchemas(dir, { baseline: "brownfield" });
  assert.deepEqual(r.filter((x) => x.includes("system-er.md")), [], r.join("\n"));
  assert.ok(has(checkTableSchemas(brownItem(brownSystem("", '"本次修改"', "")), { baseline: "brownfield" }), /表 orders_master 要標「本次新增」/));
  assert.ok(has(checkTableSchemas(brownItem(brownSystem('"本次新增"', "", "")), { baseline: "brownfield" }), /表 members 要標「本次修改」/));
  assert.ok(has(checkTableSchemas(brownItem(brownSystem('"本次新增"', '"本次修改"', '"本次新增"')), { baseline: "brownfield" }), /表 coupons 不是本次新增的表，不可標「本次新增」/));
});

test("brownfield：圖少了既有表、既有表之間的外鍵線", () => {
  const noCoupons = brownSystem('"本次新增"', '"本次修改"', "").replace(/    coupons \{[\s\S]*?    \}\n/, "").replace(/    members \|o--o\{ coupons[^\n]*\n/, "");
  assert.ok(has(checkTableSchemas(brownItem(noCoupons), { baseline: "brownfield" }), /缺少資料表：coupons/));
  const noLine = brownSystem('"本次新增"', '"本次修改"', "").replace(/    members \|o--o\{ coupons[^\n]*\n/, "");
  assert.ok(has(checkTableSchemas(brownItem(noLine), { baseline: "brownfield" }), /缺少關聯線 members→coupons/));
});

test("brownfield：取不到既有表（沒有腳本也沒有既有資料表一節）時要求補上；有專案 .sql 就自動取得", () => {
  const noSection = brownSystem('"本次新增"', '"本次修改"', "").replace(EXISTING, "");
  const r = checkTableSchemas(brownItem(noSection), { baseline: "brownfield" });
  assert.ok(has(r, /取不到既有資料表.*既有資料表/));
  const proj = path.join(root, "proj-sql");
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, "schema.sql"), "CREATE TABLE members (id INT PRIMARY KEY);\nCREATE TABLE coupons (id INT PRIMARY KEY, member_id INT REFERENCES members(id));");
  const r2 = checkTableSchemas(brownItem(noSection), { baseline: "brownfield", projectDir: proj });
  assert.equal(has(r2, /取不到既有資料表/), false);
  assert.deepEqual(r2.filter((x) => x.includes("system-er.md")), [], r2.join("\n"));
});

test("greenfield：不需要標註也不看既有資料表", () => {
  assert.deepEqual(checkTableSchemas(item(), { baseline: "greenfield" }), []);
});
