// 批次 1M（最小版）：專案層 multiModule 開關、工作項目宣告動到哪些模組、進行中功能重疊只警告不擋。
// 關閉開關時，簡單需求的狀態檔、建立／查詢回覆都不多任何欄位。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { setupEnv } from "./helpers/work-item-env.mjs";
import { parseProjectFlowOverride } from "../dist/workflow/schema.js";

const env = await setupEnv("wi-modules-");
after(() => env.cleanup());
const setFlow = async (projectDir, flow) => {
  await mkdir(path.join(projectDir, ".pipeline"), { recursive: true });
  await writeFile(path.join(projectDir, ".pipeline", "flow.json"), JSON.stringify(flow));
};
const statusOf = async (dir) => JSON.parse(await readFile(path.join(dir, "status.json"), "utf-8"));
const base = { action: "create", title: "模組需求", requirement: "y", baseline: "greenfield", scope: "both", hasDb: true, techSource: "new-guided", styleSource: "new-guided" };
const create = (projectDir, extra = {}) => env.call({ ...base, projectDir, ...extra });
const newProject = async (multi) => {
  const dir = await mkdtemp(path.join(env.tmp, "p-"));
  if (multi !== undefined) await setFlow(dir, { schemaVersion: 1, multiModule: multi });
  return dir;
};

test("flow.json：multiModule 是選填布林；非布林被拒絕；沒有時仍合法", () => {
  assert.equal(parseProjectFlowOverride({ schemaVersion: 1 }).ok, true);
  assert.equal(parseProjectFlowOverride({ schemaVersion: 1, multiModule: true }).ok, true);
  assert.equal(parseProjectFlowOverride({ schemaVersion: 1, multiModule: "yes" }).ok, false);
});

test("沒開 multiModule：宣告 modules 被拒絕並指出要先開；不宣告時狀態檔與回覆都沒有新欄位", async () => {
  const p = await newProject(undefined);
  const bad = await create(p, { modules: ["會員"] });
  assert.equal(bad.isError, true);
  assert.match(bad.json.message, /multiModule/);
  const ok = await create(p);
  assert.equal(ok.isError, false, ok.text);
  assert.ok(!("modules" in ok.json) && !("overlapWarnings" in ok.json));
  assert.ok(!Object.keys(await statusOf(ok.json.dir)).includes("modules"));
  const got = (await env.call({ action: "get", workItemId: ok.json.workItemId })).json;
  assert.ok(!("modules" in got) && !("overlapWarnings" in got));
});

test("開了 multiModule：宣告的模組整理後寫進狀態檔（去空白、去重），create 與 get 都回傳", async () => {
  const p = await newProject(true);
  const r = await create(p, { modules: [" 會員 ", "訂單", "會員"] });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(r.json.modules, ["會員", "訂單"]);
  assert.deepEqual((await statusOf(r.json.dir)).modules, ["會員", "訂單"]);
  assert.deepEqual((await env.call({ action: "get", workItemId: r.json.workItemId })).json.modules, ["會員", "訂單"]);
});

test("開了 multiModule 但沒宣告：狀態檔沒有 modules key", async () => {
  const p = await newProject(true);
  const r = await create(p);
  assert.ok(!Object.keys(await statusOf(r.json.dir)).includes("modules"));
});

test("modules 格式檢查：空字串、過長、過多都拒絕（型別錯誤由工具介面層擋）", async () => {
  const p = await newProject(true);
  for (const m of [[""], ["  "], ["x".repeat(61)], Array.from({ length: 21 }, (_, i) => `m${i}`)]) {
    const r = await create(p, { modules: m });
    assert.equal(r.isError, true, JSON.stringify(m));
  }
});

test("進行中功能重疊：有共同模組就警告（不擋），雙方都看得到；沒有共同模組不警告", async () => {
  const p = await newProject(true);
  const a = await create(p, { title: "功能A", modules: ["會員", "訂單"] });
  const b = await create(p, { title: "功能B", modules: ["會員", "庫存"] });
  assert.equal(b.isError, false, b.text);
  assert.deepEqual(b.json.overlapWarnings, [{ workItemId: a.json.workItemId, title: "功能A", modules: ["會員"] }]);
  const c = await create(p, { title: "功能C", modules: ["報表"] });
  assert.ok(!("overlapWarnings" in c.json));
  const gotA = (await env.call({ action: "get", workItemId: a.json.workItemId })).json;
  assert.equal(gotA.overlapWarnings.length, 1);
  assert.equal(gotA.overlapWarnings[0].workItemId, b.json.workItemId);
});

test("已完成的工作項目與其他專案的工作項目都不算重疊", async () => {
  const p = await newProject(true);
  const other = await newProject(true);
  const a = await create(p, { title: "功能A", modules: ["會員"] });
  await create(other, { title: "別專案", modules: ["會員"] });
  const done = await statusOf(a.json.dir);
  done.work_item_progress ??= { roles: {}, gates: {} };
  done.work_item_progress.gates["final-acceptance"] = { decision: "confirmed", by: "human", at: new Date().toISOString() };
  await writeFile(path.join(a.json.dir, "status.json"), JSON.stringify(done));
  const b = await create(p, { title: "功能B", modules: ["會員"] });
  assert.ok(!("overlapWarnings" in b.json), JSON.stringify(b.json.overlapWarnings));
});

test("專案關掉 multiModule 後，不再顯示重疊警告", async () => {
  const p = await newProject(true);
  await create(p, { title: "功能A", modules: ["會員"] });
  const b = await create(p, { title: "功能B", modules: ["會員"] });
  await setFlow(p, { schemaVersion: 1, multiModule: false });
  const got = (await env.call({ action: "get", workItemId: b.json.workItemId })).json;
  assert.ok(!("overlapWarnings" in got));
});

test("set_scope 可改 modules（回傳新的重疊警告）；給空陣列整個 key 拿掉；SA 確認後鎖定", async () => {
  const p = await newProject(true);
  const a = await create(p, { title: "功能A", modules: ["會員"] });
  const b = await create(p, { title: "功能B", modules: ["訂單"] });
  assert.ok(!("overlapWarnings" in b.json));
  const s = await env.call({ action: "set_scope", workItemId: b.json.workItemId, modules: ["訂單", "會員"] });
  assert.equal(s.isError, false, s.text);
  assert.deepEqual(s.json.modules, ["訂單", "會員"]);
  assert.deepEqual(s.json.overlapWarnings, [{ workItemId: a.json.workItemId, title: "功能A", modules: ["會員"] }]);
  const cleared = await env.call({ action: "set_scope", workItemId: b.json.workItemId, modules: [] });
  assert.equal(cleared.isError, false, cleared.text);
  assert.ok(!Object.keys(await statusOf(b.json.dir)).includes("modules"));
  const st = await statusOf(b.json.dir);
  st.work_item_progress ??= { roles: {}, gates: {} };
  st.work_item_progress.gates["sa-confirm"] = { decision: "confirmed", by: "human", at: new Date().toISOString() };
  await writeFile(path.join(b.json.dir, "status.json"), JSON.stringify(st));
  const locked = await env.call({ action: "set_scope", workItemId: b.json.workItemId, modules: ["庫存"] });
  assert.equal(locked.isError, true);
  assert.match(locked.json.message, /鎖定/);
});

test("沒開 multiModule 時 set_scope 的 modules 被拒絕", async () => {
  const p = await newProject(undefined);
  const a = await create(p);
  const r = await env.call({ action: "set_scope", workItemId: a.json.workItemId, modules: ["會員"] });
  assert.equal(r.isError, true);
  assert.match(r.json.message, /multiModule/);
});
