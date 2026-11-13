// 問題 11、12：SD 交件核對「重用既有」指向的檔案與方法真的存在、說明夠具體；API INPUT「對應 DB 欄位」對得上資料表結構文件。
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VALID_SD, VALID_TABLE_SCHEMA, setupEnv, runUntil, fulfil } from "./helpers/work-item-env.mjs";
import { checkSdStructure } from "../dist/workflow/sd-structure-check.js";
import { dbColumnRefs } from "../dist/workflow/sd-reuse-check.js";

let tmp, wi, proj;
before(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "wi-eng-c-sd-"));
  wi = path.join(tmp, "wi");
  proj = path.join(tmp, "proj");
  await mkdir(path.join(wi, "TableSchema"), { recursive: true });
  await writeFile(path.join(wi, "TableSchema", "t.md"), VALID_TABLE_SCHEMA);
  await writeFile(path.join(wi, "02-db.sql"), "CREATE TABLE t (id INT PRIMARY KEY);");
  await mkdir(path.join(proj, "src", "main"), { recursive: true });
  await writeFile(path.join(proj, "src", "main", "ExcelUtil.java"), "public class ExcelUtil { public static void write() {} }");
  await mkdir(path.join(proj, "db"), { recursive: true });
  await writeFile(path.join(proj, "db", "schema.sql"), "CREATE TABLE orders (order_id INT PRIMARY KEY, amount INT);");
});
after(() => rm(tmp, { recursive: true, force: true }));
const withRow = (sd, from, to) => {
  assert.ok(sd.includes(from), from);
  return sd.replace(from, to);
};
const NOTE = "既有 Excel 匯出工具，登入紀錄下載時直接沿用";
const ROW = `| ExcelUtil | src/main/ExcelUtil.java | 重用既有 | 登入 API 的服務層 | ${NOTE} |`;
const check = (sd, projectDir = proj) => checkSdStructure(sd, wi, projectDir);

test("基準：樣本 SD 在檔案與方法都存在時合格；沒給 projectDir 完全略過新檢查", () => {
  assert.deepEqual(check(VALID_SD), []);
  const broken = withRow(VALID_SD, ROW, "| ExcelUtil | src/none/Nope.java | 重用既有 | 登入 | 短 |");
  assert.deepEqual(checkSdStructure(broken, wi), []);
  assert.deepEqual(checkSdStructure(broken, wi, null), []);
  assert.ok(check(broken).length > 0);
});

test("重用既有：位置檔案不存在 → 指出第幾列與修法", () => {
  const p = check(withRow(VALID_SD, "src/main/ExcelUtil.java", "src/main/Missing.java"));
  assert.equal(p.length, 1);
  assert.match(p[0], /共用方法清單」第 1 列/);
  assert.match(p[0], /Missing\.java 在專案目錄裡找不到/);
  assert.match(p[0], /新建共用/);
});

test("重用既有：方法名沒有在檔案內以完整詞出現（子字串不算）；Class.method 寫法可接受", () => {
  const p1 = check(withRow(VALID_SD, "| ExcelUtil | src/main", "| Excel | src/main"));
  assert.match(p1.join("\n"), /找不到方法名稱：Excel/);
  const ok = check(withRow(VALID_SD, "| ExcelUtil | src/main", "| ExcelUtil.write | src/main").replace("**使用的共用方法:** ExcelUtil", "**使用的共用方法:** ExcelUtil.write"));
  assert.deepEqual(ok, []);
});

test("重用既有：路徑穿越到專案外被拒絕", async () => {
  await writeFile(path.join(tmp, "Outside.java"), "class ExcelUtil {}");
  const p = check(withRow(VALID_SD, "src/main/ExcelUtil.java", "../Outside.java"));
  assert.match(p.join("\n"), /超出專案目錄/);
});

test("重用既有：說明欄少於 8 個字元（去空白）被拒；剛好 8 個字元合格", () => {
  const short = check(withRow(VALID_SD, NOTE, "既有工具"));
  assert.match(short.join("\n"), /說明至少要 8 個字元/);
  assert.deepEqual(check(withRow(VALID_SD, NOTE, "既有 工具 匯出 登入 沿用")), []);
  assert.deepEqual(check(withRow(VALID_SD, NOTE, "一二三四五六七八")), []);
  assert.match(check(withRow(VALID_SD, NOTE, "一二三四五六七")).join("\n"), /說明至少要 8 個字元/);
  assert.match(check(withRow(VALID_SD, NOTE, "")).join("\n"), /說明至少要 8 個字元/);
});

test("新建共用／新建專用的既有規則不變：不檢查檔案存在、說明沿用原本的必填規則", () => {
  const created = withRow(VALID_SD, ROW, "| NewUtil | src/main/NewUtil.java | 新建共用 | 登入 API 的服務層 | 新的匯出工具 |").replace("**使用的共用方法:** ExcelUtil", "**使用的共用方法:** NewUtil");
  assert.deepEqual(check(created), []);
  const noNote = withRow(created, "| 新的匯出工具 |", "|  |");
  assert.match(check(noNote).join("\n"), /類型為「新建共用」，說明必填/);
});

test("INPUT 對應 DB 欄位：表.欄位存在（忽略大小寫）合格；寫—、無、不涉及或非表.欄位格式不檢查", () => {
  assert.deepEqual(check(withRow(VALID_SD, "| t.id |", "| T.ID |")), []);
  for (const v of ["—", "無", "不涉及", "帳號欄位（見 t 表）", "dbo.t.nope"]) assert.deepEqual(check(withRow(VALID_SD, "| t.id |", `| ${v} |`)), [], v);
});

test("INPUT 對應 DB 欄位：欄位不存在、表不存在都指出 API、列與修法", () => {
  const col = check(withRow(VALID_SD, "| t.id |", "| t.account_no |"));
  assert.equal(col.length, 1);
  assert.match(col[0], /API「1\. 登入」INPUT 第 1 列（account）/);
  assert.match(col[0], /資料表 t 沒有欄位 account_no/);
  assert.match(col[0], /已知欄位：id/);
  const tbl = check(withRow(VALID_SD, "| t.id |", "| ghost.id |"));
  assert.match(tbl.join("\n"), /資料表 ghost 不存在/);
  assert.match(tbl.join("\n"), /寫「—」/);
});

test("INPUT 對應 DB 欄位：既有資料表（專案 .sql 掃描）也算，欄位要對得上", () => {
  assert.deepEqual(check(withRow(VALID_SD, "| t.id |", "| orders.order_id、t.id |")), []);
  assert.match(check(withRow(VALID_SD, "| t.id |", "| orders.nope |")).join("\n"), /資料表 orders 沒有欄位 nope/);
});

test("單元：dbColumnRefs 只取「表.欄位」", () => {
  assert.deepEqual(dbColumnRefs("`t.id`、orders.order_id（訂單）").map((x) => x.text), ["t.id", "orders.order_id"]);
  assert.deepEqual(dbColumnRefs("—"), []);
  assert.deepEqual(dbColumnRefs("a.b.c"), []);
});

test("done：SD 分析師交件時重用既有指向的檔案不存在 → 交件被擋；補上後通過", async () => {
  const env = await setupEnv("wi-eng-c-sddone-");
  try {
    const { id, dir } = await env.create();
    await runUntil(env, id, dir, "sd-analyst");
    await fulfil(dir, "sd-analyst");
    await rm(path.join(env.projectDir, "src", "main", "ExcelUtil.java"));
    const bad = await env.call({ action: "done", workItemId: id, roleId: "sd-analyst" });
    assert.equal(bad.isError, true);
    assert.match(bad.json.message, /ExcelUtil\.java 在專案目錄裡找不到/);
    await writeFile(path.join(env.projectDir, "src", "main", "ExcelUtil.java"), "class ExcelUtil { static void write() {} }");
    const ok = await env.call({ action: "done", workItemId: id, roleId: "sd-analyst" });
    assert.equal(ok.isError, false, ok.text);
  } finally {
    await env.cleanup();
  }
});
