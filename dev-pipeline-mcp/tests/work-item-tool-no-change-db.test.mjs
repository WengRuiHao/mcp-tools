// work_item：既有系統（brownfield）DB 設計師「無異動模式」交件——02-db.sql 只有註解，只讀既有表。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { setupEnv, fulfil, runUntil } from "./helpers/work-item-env.mjs";
import { noChangeDocs, writeNoChangeItem, EXISTING_SECTION } from "./helpers/no-change-fixture.mjs";

const env = await setupEnv("wi-nochange-");
after(() => env.cleanup());
const done = (id) => env.call({ action: "done", workItemId: id, roleId: "db-designer" });
/** 建立 brownfield 工作項目並推進到輪到 db-designer。 */
async function brownfieldAtDb() {
  const { id, dir } = await env.create({ baseline: "brownfield" });
  await fulfil(dir, "baseline-survey");
  const r = await env.call({ action: "done", workItemId: id, roleId: "baseline-survey" });
  assert.equal(r.isError, false, r.text);
  await runUntil(env, id, dir, "db-designer");
  return { id, dir };
}
const dbProblems = (r) => (r.json.problems ?? []).filter((p) => p.startsWith("資料表結構文件檢查未通過"));

test("brownfield 無異動：註解 SQL＋既有資料表章節＋分組文件＋ER 圖，db-designer 交件通過", async () => {
  const { id, dir } = await brownfieldAtDb();
  writeNoChangeItem(dir);
  const r = await done(id);
  assert.deepEqual(dbProblems(r), [], r.text);
  assert.equal(r.isError, false, r.text);
});

test("brownfield 無異動：缺既有資料表章節、標「本次新增」、SQL 空白，都被退回並說明怎麼改", async () => {
  const { id, dir } = await brownfieldAtDb();
  const d = noChangeDocs();
  writeNoChangeItem(dir, { systemEr: d.systemEr.replace(EXISTING_SECTION, "") });
  let r = await done(id);
  assert.equal(r.isError, true);
  assert.ok(dbProblems(r).some((p) => /取不到既有資料表.*## 既有資料表/.test(p)), r.text);
  writeNoChangeItem(dir, { systemEr: d.systemEr.replace("INTEGER id PK\n    }\n    orders_master {", 'INTEGER id PK "本次新增"\n    }\n    orders_master {') });
  r = await done(id);
  assert.ok(dbProblems(r).some((p) => /不可標「本次新增」/.test(p)), r.text);
  writeFileSync(path.join(dir, "02-db.sql"), "\n  \n");
  r = await done(id);
  assert.ok(dbProblems(r).some((p) => /02-db\.sql 是空白/.test(p)), r.text);
});
