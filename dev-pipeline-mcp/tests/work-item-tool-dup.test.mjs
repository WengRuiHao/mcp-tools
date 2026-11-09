// S12a：前後端工程師 done 時的自動重複偵測（dup-report.md、豁免、路徑穿越、專案 dup 設定）。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setupEnv, runUntil, REUSE_RECORD_OK } from "./helpers/work-item-env.mjs";

const env = await setupEnv("wi-dup-");
after(() => env.cleanup());
const done = (id, roleId) => env.call({ action: "done", workItemId: id, roleId });
const lines = (n, tag) => Array.from({ length: n }, (_, i) => `  const value_${tag}_${i} = computeSomething(${tag}Input, ${i}) + offsetValue_${i};`);
const js = (body) => ["function demo() {", ...body, "}", ""].join("\n");
const put = async (rel, text) => { await mkdir(path.dirname(path.join(env.projectDir, rel)), { recursive: true }); await writeFile(path.join(env.projectDir, rel), text); };
const impl = (dir, extra) => writeFile(path.join(dir, "impl-fe.md"), `FE\n${REUSE_RECORD_OK}${extra}`);
const WAIVER_HEAD = "## 重複豁免\n| 檔案 | 相似檔案 | 理由 |\n| --- | --- | --- |\n";

async function setup() {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "frontend-engineer");
  const shared = lines(10, "x");
  await put("src/old.js", js(shared));
  await put("src/new.js", js(shared));
  return { id, dir };
}

test("未豁免的重複被擋下並寫出 dup-report.md，訊息含位置與建議", async () => {
  const { id, dir } = await setup();
  await impl(dir, "## 改動檔案\n- src/new.js\n");
  const r = await done(id, "frontend-engineer");
  assert.equal(r.isError, true);
  assert.match(r.json.message, /src\/new\.js 第 \d+～\d+ 行/);
  assert.match(r.json.message, /重複豁免/);
  const report = await readFile(path.join(dir, "dup-report.md"), "utf-8");
  assert.match(report, /frontend-engineer/);
  assert.match(report, /擋下交件/);
  assert.equal((await env.call({ action: "get", workItemId: id })).json.doneRoles.includes("frontend-engineer"), false);
});

test("有效豁免通過，報告列出已豁免區塊與理由；後端交件保留前端段落", async () => {
  const { id, dir } = await setup();
  await impl(dir, `## 改動檔案\n- src/new.js\n${WAIVER_HEAD}| src/new.js | src/old.js | 兩邊刻意獨立演進 |\n`);
  const r = await done(id, "frontend-engineer");
  assert.equal(r.isError, false, r.text);
  const report = await readFile(path.join(dir, "dup-report.md"), "utf-8");
  assert.match(report, /已豁免的重複區塊/);
  assert.match(report, /兩邊刻意獨立演進/);
  await writeFile(path.join(dir, "impl-be.md"), `BE\n${REUSE_RECORD_OK}## 改動檔案\n- src/ok.js\n`);
  await put("src/ok.js", js(lines(10, "unique")));
  assert.equal((await done(id, "backend-engineer")).isError, false);
  const both = await readFile(path.join(dir, "dup-report.md"), "utf-8");
  assert.match(both, /frontend-engineer/);
  assert.match(both, /backend-engineer/);
  assert.match(both, /兩邊刻意獨立演進/);
});

test("理由不足 4 字元的豁免無效，仍被擋下", async () => {
  const { id, dir } = await setup();
  await impl(dir, `## 改動檔案\n- src/new.js\n${WAIVER_HEAD}| src/new.js | src/old.js | 不用 |\n`);
  const r = await done(id, "frontend-engineer");
  assert.equal(r.isError, true);
  assert.match(r.json.message, /無效的豁免/);
  assert.match(await readFile(path.join(dir, "dup-report.md"), "utf-8"), /無效的豁免/);
});

test("沒有改動檔案資訊（非版本控制且沒列清單）要求補上「## 改動檔案」", async () => {
  const { id, dir } = await setup();
  await impl(dir, "");
  const r = await done(id, "frontend-engineer");
  assert.equal(r.isError, true);
  assert.match(r.json.message, /## 改動檔案/);
});

test("乾淨改動通過", async () => {
  const { id, dir } = await setup();
  await put("src/clean.js", js(lines(10, "clean")));
  await impl(dir, "## 改動檔案\n- src/clean.js\n");
  const r = await done(id, "frontend-engineer");
  assert.equal(r.isError, false, r.text);
  assert.match(await readFile(path.join(dir, "dup-report.md"), "utf-8"), /通過/);
});

test("路徑穿越與絕對路徑被拒，不默默過濾", async () => {
  const { id, dir } = await setup();
  for (const bad of ["../outside.js", "/etc/passwd", "src/../../x.js"]) {
    await impl(dir, `## 改動檔案\n- src/new.js\n- ${bad}\n`);
    const r = await done(id, "frontend-engineer");
    assert.equal(r.isError, true, bad);
    assert.match(r.json.message, /超出專案目錄/, bad);
  }
});

test("專案 flow.json 的 dup 設定生效（minRun 調高後 10 行重複不再擋）", async () => {
  const { id, dir } = await setup();
  await impl(dir, "## 改動檔案\n- src/new.js\n");
  assert.equal((await done(id, "frontend-engineer")).isError, true);
  await put(".pipeline/flow.json", JSON.stringify({ schemaVersion: 1, dup: { minRun: 30, testMinRun: 30 } }));
  const r = await done(id, "frontend-engineer");
  assert.equal(r.isError, false, r.text);
});
