// ER 圖來源改為內部檔 TableSchema/_src/<名稱>.mmd：文件只放圖片引用（問題 67）；舊格式（legacy，內嵌 mermaid）仍接受。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTmpDir, removeDir } from "./helpers/support.mjs";
import { tableSchemaTemplates, TEMPLATE_SQL, installSchemaExtras, splitErInline } from "./helpers/sasd-standard.mjs";

const { checkTableSchemas } = await import("../dist/workflow/table-schema-check.js");
const root = makeTmpDir("dpm-er-source-");
after(() => removeDir(root));
const has = (list, re) => list.some((x) => re.test(x));

let n = 0;
/** inline＝true 時不拆來源（維持內嵌 mermaid 的舊格式）。 */
function item({ inline = false } = {}) {
  const dir = path.join(root, `w${n++}`);
  fs.mkdirSync(path.join(dir, "TableSchema"), { recursive: true });
  fs.writeFileSync(path.join(dir, "02-db.sql"), TEMPLATE_SQL);
  for (const [k, v] of Object.entries(tableSchemaTemplates())) fs.writeFileSync(path.join(dir, "TableSchema", `${k}.md`), v);
  installSchemaExtras(dir);
  if (!inline) splitErInline(dir);
  return dir;
}

test("新格式：文件只放圖片引用，來源在 _src/*.mmd，範本通過", () => {
  const dir = item();
  assert.ok(fs.existsSync(path.join(dir, "TableSchema", "_src", "orders_master.mmd")));
  assert.ok(!fs.readFileSync(path.join(dir, "TableSchema", "orders_master.md"), "utf-8").includes("```mermaid"));
  assert.deepEqual(checkTableSchemas(dir), []);
});

test("新格式：文件章節內放 mermaid 區塊會擋，指引改放 _src", () => {
  const dir = item({ inline: true });
  const r = checkTableSchemas(dir);
  assert.ok(has(r, /orders_master\.md「模組 ER 圖」不可放 ```mermaid 程式碼區塊.*TableSchema\/_src\/orders_master\.mmd/), r.join("\n"));
  assert.ok(has(r, /system-er\.md「系統 ER 圖」不可放 ```mermaid 程式碼區塊/), r.join("\n"));
});

test("新格式：缺來源檔會擋，並指引 write 與 render", () => {
  const dir = item();
  fs.rmSync(path.join(dir, "TableSchema", "_src", "members.mmd"));
  const r = checkTableSchemas(dir);
  assert.ok(has(r, /members\.md缺少 ER 圖來源 TableSchema\/_src\/members\.mmd.*write.*render/), r.join("\n"));
});

test("新格式：圖片比來源舊要擋（來源改過後須重新轉圖），重新轉圖後通過", () => {
  const dir = item();
  const png = path.join(dir, "TableSchema", "er", "members.png");
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(png, old, old);
  assert.ok(has(checkTableSchemas(dir), /members\.png 比來源 TableSchema\/_src\/members\.mmd 舊.*重新轉圖/));
  fs.utimesSync(png, new Date(), new Date());
  assert.deepEqual(checkTableSchemas(dir), []);
});

test("舊格式（legacy）：內嵌 mermaid 的文件仍通過；有 _src 來源時以來源為準", () => {
  const dir = item({ inline: true });
  assert.deepEqual(checkTableSchemas(dir, { legacy: true }), []);
  const dir2 = item();
  assert.deepEqual(checkTableSchemas(dir2, { legacy: true }), []);
});
