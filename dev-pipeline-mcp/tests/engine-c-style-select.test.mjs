// 問題 3：全新待選風格（new-select）在 mockup-confirm 必須用 selected 指定選定的風格檔，其餘候選移到 sa-mockup/_candidates/。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { setupEnv, runUntil, VALID_MOCKUP } from "./helpers/work-item-env.mjs";
import { checkMockupDir } from "../dist/workflow/mockup-check.js";

const env = await setupEnv("wi-eng-c-style-");
after(() => env.cleanup());
const confirm = (id, extra = {}) => env.call({ action: "confirm", workItemId: id, gateId: "mockup-confirm", decision: "confirmed", by: "human", reason: "使用者說就選這個", ...extra });
const exists = (p) => stat(p).then(() => true, () => false);

async function newSelect(extraFiles = {}) {
  const { id, dir } = await env.create({ styleSource: "new-select", techSource: "new-select" });
  await runUntil(env, id, dir, "mockup-confirm");
  for (const n of ["style-a.html", "style-b.html", "style-c.html"]) await writeFile(path.join(dir, "sa-mockup", n), extraFiles[n] ?? VALID_MOCKUP);
  return { id, dir };
}

test("new-select 核准 mockup-confirm 沒給 selected：拒絕且不寫入關卡紀錄", async () => {
  const { id } = await newSelect();
  const r = await confirm(id);
  assert.equal(r.isError, true);
  assert.match(r.json.message, /selected/);
  assert.equal((await env.store.readStatus(id)).work_item_progress.gates["mockup-confirm"], undefined);
});

test("selected 格式不對或檔案不存在：拒絕，檔案不被移動", async () => {
  const { id, dir } = await newSelect();
  for (const bad of ["../style-a.html", "index.html", "style-z.html", "style-a.htm", "sub/style-a.html"]) {
    const r = await confirm(id, { selected: bad });
    assert.equal(r.isError, true, bad);
  }
  assert.ok(await exists(path.join(dir, "sa-mockup", "style-a.html")));
  assert.equal((await env.store.readStatus(id)).selected_style, undefined);
});

test("選定 style-b.html：其餘候選移到 _candidates/（不刪除）、記錄 selected_style、其他畫面檔不動", async () => {
  const { id, dir } = await newSelect();
  const r = await confirm(id, { selected: "style-b.html" });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.selectedStyle, "style-b.html");
  assert.deepEqual(r.json.movedCandidates.map((m) => m.to), ["sa-mockup/_candidates/style-a.html", "sa-mockup/_candidates/style-c.html"]);
  assert.deepEqual((await readdir(path.join(dir, "sa-mockup"))).sort(), ["_candidates", "index.html", "style-b.html"]);
  assert.deepEqual((await readdir(path.join(dir, "sa-mockup", "_candidates"))).sort(), ["style-a.html", "style-c.html"]);
  assert.equal((await env.store.readStatus(id)).selected_style, "style-b.html");
  assert.equal((await env.call({ action: "get", workItemId: id })).json.selectedStyle, "style-b.html");
  assert.match(await readFile(path.join(dir, "00-索引.md"), "utf-8"), /mockup-confirm.*選定風格：style-b\.html/);
});

test("_candidates/ 已有同名檔：加序號後綴，不覆蓋", async () => {
  const { id, dir } = await newSelect();
  await mkdir(path.join(dir, "sa-mockup", "_candidates"), { recursive: true });
  await writeFile(path.join(dir, "sa-mockup", "_candidates", "style-a.html"), "舊的");
  const r = await confirm(id, { selected: "style-b.html" });
  assert.equal(r.isError, false, r.text);
  assert.ok(r.json.movedCandidates.some((m) => m.to === "sa-mockup/_candidates/style-a-2.html"));
  assert.equal(await readFile(path.join(dir, "sa-mockup", "_candidates", "style-a.html"), "utf-8"), "舊的");
});

test("其他 html 以相對路徑引用被移走的候選：不擋，回警告", async () => {
  const { id, dir } = await newSelect();
  await writeFile(path.join(dir, "sa-mockup", "index.html"), `${VALID_MOCKUP}<a href="style-a.html">舊版</a>`);
  const r = await confirm(id, { selected: "style-b.html" });
  assert.equal(r.isError, false, r.text);
  assert.ok(r.json.warnings.some((w) => /index\.html/.test(w) && /style-a\.html/.test(w)));
});

test("非 new-select（new-guided）給 selected：拒絕；不給則行為不變、不移動檔案", async () => {
  const { id, dir } = await env.create({ styleSource: "new-guided", techSource: "new-select" });
  await runUntil(env, id, dir, "mockup-confirm");
  await writeFile(path.join(dir, "sa-mockup", "style-a.html"), VALID_MOCKUP);
  const bad = await confirm(id, { selected: "style-a.html" });
  assert.equal(bad.isError, true);
  assert.match(bad.json.message, /selected/);
  const ok = await confirm(id);
  assert.equal(ok.isError, false, ok.text);
  assert.equal(ok.json.selectedStyle, undefined);
  assert.ok(await exists(path.join(dir, "sa-mockup", "style-a.html")));
  assert.equal((await env.store.readStatus(id)).selected_style, undefined);
});

test("new-select 打回 mockup-confirm 時給 selected：拒絕；正常打回不需要 selected", async () => {
  const { id } = await newSelect();
  const bad = await env.call({ action: "confirm", workItemId: id, gateId: "mockup-confirm", decision: "rejected", by: "human", reason: "都不好看", selected: "style-a.html" });
  assert.equal(bad.isError, true);
  const ok = await env.call({ action: "confirm", workItemId: id, gateId: "mockup-confirm", decision: "rejected", by: "human", reason: "都不好看" });
  assert.equal(ok.isError, false, ok.text);
});

test("單元：checkMockupDir 略過 _ 開頭資料夾；已選定後主目錄只能留被選中的風格檔，其他畫面檔不受限", async () => {
  const { id, dir } = await newSelect();
  void id;
  await mkdir(path.join(dir, "sa-mockup", "_candidates"), { recursive: true });
  await writeFile(path.join(dir, "sa-mockup", "_candidates", "bad.html"), "<html></html>");
  assert.deepEqual(checkMockupDir(dir), []); // 未選定：候選都在主目錄也不擋
  const p = checkMockupDir(dir, { selectedStyle: "style-b.html" });
  assert.equal(p.length, 1);
  assert.match(p[0], /style-a\.html、style-c\.html/);
  assert.match(p[0], /_candidates/);
  assert.match(checkMockupDir(dir, { selectedStyle: "style-q.html" }).join("\n"), /找不到使用者已選定的風格檔 style-q\.html/);
  await env.call({ action: "get", workItemId: id });
});

test("單元：只有 _candidates 內有 html 時仍要求主目錄至少一個 html", async () => {
  const { dir } = await env.create({ styleSource: "new-select", techSource: "new-select" });
  await mkdir(path.join(dir, "sa-mockup", "_candidates"), { recursive: true });
  await writeFile(path.join(dir, "sa-mockup", "_candidates", "style-a.html"), VALID_MOCKUP);
  assert.match(checkMockupDir(dir).join("\n"), /至少要有一個 html/);
});
