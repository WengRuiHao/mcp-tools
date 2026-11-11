// 正式交付物引用檢查（步驟 H）：範本全部合格；引用內部檔、外部圖片、非交付物圖片等違規樣本；與 SA／SD 標準檢查整合不重複；get 列出兩組清單。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SA_TEMPLATE, SD_TEMPLATE, tableSchemaTemplates } from "./helpers/sasd-standard.mjs";
import { setupEnv, runUntil, fulfil } from "./helpers/work-item-env.mjs";

const { checkDeliverablePointers } = await import("../dist/workflow/deliverable-pointer-check.js");
const { buildSpecFirstWorkflow } = await import("../dist/workflow/builtin/spec-first.js");
const { buildAsanaTicketWorkflow } = await import("../dist/workflow/builtin/asana-ticket.js").catch(() => ({}));
const def = buildSpecFirstWorkflow();
const roots = [];
after(async () => { for (const r of roots) await rm(r, { recursive: true, force: true }); });

async function makeDir({ sa = SA_TEMPLATE(), sd = SD_TEMPLATE(), schemas = tableSchemaTemplates() } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ptr-"));
  roots.push(dir);
  await writeFile(path.join(dir, "01-sa.md"), sa);
  await writeFile(path.join(dir, "03-sd.md"), sd);
  await mkdir(path.join(dir, "TableSchema"));
  for (const [name, text] of Object.entries(schemas)) await writeFile(path.join(dir, "TableSchema", `${name}.md`), text);
  return dir;
}

test("交付物旗標：SA、TableSchema、flow、SD 是正式交付物，其餘是內部檔", () => {
  assert.deepEqual(def.artifacts.filter((a) => a.deliverable).map((a) => a.id), ["sa", "table-schema", "flow", "sd"]);
  if (buildAsanaTicketWorkflow) assert.equal(buildAsanaTicketWorkflow().artifacts.some((a) => a.deliverable), false);
});

test("SA／SD／資料表結構文件範本全部合格", async () => {
  const dir = await makeDir();
  assert.deepEqual(checkDeliverablePointers(dir, def), []);
});

test("SA 引用內部檔名：指出檔名、行號與內部檔；圖片非 sa-images 也被指出", async () => {
  const sa = SA_TEMPLATE() + "\n詳見 sa-notes.md 的說明。\n\n![x](sa-mockup/index.png)\n![y](evidence/a.png)\n![z](https://example.com/a.png)\n";
  const dir = await makeDir({ sa });
  const out = checkDeliverablePointers(dir, def);
  const n = sa.split("\n").length;
  assert.ok(out.some((v) => v.startsWith("01-sa.md") && v.includes(`第 ${n - 5} 行`) && v.includes("sa-notes")), out.join("\n"));
  assert.ok(out.some((v) => v.includes("sa-mockup/index.png") && v.includes("不是正式交付物")));
  assert.ok(out.some((v) => v.includes("evidence/a.png")));
  assert.ok(out.some((v) => v.includes("https://example.com/a.png") && v.includes("外部網址")));
  assert.equal(out.filter((v) => v.includes("「sa-mockup」")).length, 0, "圖片路徑裡的 sa-mockup 只報一次（圖片違規），不重複報內部檔名");
});

test("SD 與資料表結構文件引用內部檔：連結與文字都擋；連到 03-sd.md 不算", async () => {
  const schemas = tableSchemaTemplates();
  const first = Object.keys(schemas)[0];
  schemas[first] += "\n參考 [設計](../02-db.md) 與 impl-be.md。\n";
  const dir = await makeDir({ sd: SD_TEMPLATE() + "\n結果見 [驗證](verify.md)。\n", schemas });
  const out = checkDeliverablePointers(dir, def);
  assert.ok(out.some((v) => v.startsWith("03-sd.md") && v.includes("verify.md")));
  assert.ok(out.some((v) => v.startsWith(`TableSchema/${first}.md`) && v.includes("02-db")));
  assert.ok(out.some((v) => v.startsWith(`TableSchema/${first}.md`) && v.includes("impl-be")));
  assert.equal(out.some((v) => v.includes("03-sd.md」") && v.startsWith("TableSchema")), false);
});

test("suppress：SA／SD 標準檢查已回報的內部檔名不重複判定", async () => {
  const dir = await makeDir({ sa: SA_TEMPLATE() + "\n見 spec-check 與 tech-stack.md。\n" });
  const plain = checkDeliverablePointers(dir, def, { only: ["sa"] });
  assert.equal(plain.length, 2);
  const sup = checkDeliverablePointers(dir, def, { only: ["sa"], suppress: { "01-sa.md": ["spec-check"] } });
  assert.equal(sup.length, 1);
  assert.match(sup[0], /tech-stack\.md/);
});

const env = await setupEnv("wi-ptr-");
after(() => env.cleanup());

test("get 列出正式交付物與內部過程檔兩組；內部檔不在交付物組", async () => {
  const { id, dir } = await env.create();
  const r = (await env.call({ action: "get", workItemId: id })).json;
  const del = r.deliverables.map((f) => f.path);
  const internal = r.internalFiles.map((f) => f.path);
  assert.deepEqual(del.sort(), ["01-sa.docx", "01-sa.md", "03-sd.md", "TableSchema/", "flow.png", "sa-images/"].sort());
  for (const f of ["sa-notes.md", "02-db.sql", "02-db.md", "spec-check.md", "impl-fe.md", "verify.md", "test.md", "dup-report.md", "sa-mockup/"]) assert.ok(internal.includes(f), f);
  assert.equal(internal.some((p) => del.includes(p)), false);
});

test("tester 交件前檢查全部正式交付物：SD 被改成引用內部檔會擋，修正後通過", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "tester");
  const sdFile = path.join(dir, "03-sd.md");
  const original = await readFile(sdFile, "utf-8");
  await writeFile(sdFile, original + "\n另見 impl-be.md。\n");
  await fulfil(dir, "tester");
  const bad = await env.call({ action: "done", workItemId: id, roleId: "tester" });
  assert.equal(bad.isError, true);
  assert.ok(bad.json.problems.some((p) => p.includes("交付物引用檢查未通過") && p.includes("03-sd.md") && p.includes("impl-be")));
  await writeFile(sdFile, original);
  assert.equal((await env.call({ action: "done", workItemId: id, roleId: "tester" })).isError, false);
});
