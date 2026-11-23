// 批次 1M 第二步：工作項目宣告依賴哪些其他工作項目（dependsOn），對方還沒完成只警告不擋。
// 沒開 multiModule 的專案，狀態檔與回覆都不多任何欄位。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { setupEnv, runUntil } from "./helpers/work-item-env.mjs";

const env = await setupEnv("wi-deps-");
after(() => env.cleanup());
const setFlow = async (projectDir, flow) => {
  await mkdir(path.join(projectDir, ".pipeline"), { recursive: true });
  await writeFile(path.join(projectDir, ".pipeline", "flow.json"), JSON.stringify(flow));
};
const statusOf = async (dir) => JSON.parse(await readFile(path.join(dir, "status.json"), "utf-8"));
const base = { action: "create", title: "依賴需求", requirement: "y", baseline: "greenfield", scope: "both", hasDb: true, techSource: "new-guided", styleSource: "new-guided" };
const create = (projectDir, extra = {}) => env.call({ ...base, projectDir, ...extra });
const newProject = async (multi) => {
  const dir = await mkdtemp(path.join(env.tmp, "p-"));
  if (multi !== undefined) await setFlow(dir, { schemaVersion: 1, multiModule: multi });
  return dir;
};
const finish = async (dir) => {
  const s = await statusOf(dir);
  s.work_item_progress ??= { roles: {}, gates: {} };
  s.work_item_progress.gates["final-acceptance"] = { decision: "confirmed", by: "human", at: new Date().toISOString() };
  await writeFile(path.join(dir, "status.json"), JSON.stringify(s));
};

test("沒開 multiModule：宣告 dependsOn 被拒絕；不宣告時沒有任何新欄位", async () => {
  const p = await newProject(undefined);
  const a = await create(p, { title: "A" });
  const bad = await create(p, { dependsOn: [a.json.workItemId] });
  assert.equal(bad.isError, true);
  assert.match(bad.json.message, /multiModule/);
  assert.ok(!("dependsOn" in a.json) && !("dependencyWarnings" in a.json));
  assert.ok(!Object.keys(await statusOf(a.json.dir)).includes("depends_on"));
  const got = (await env.call({ action: "get", workItemId: a.json.workItemId })).json;
  assert.ok(!("dependsOn" in got) && !("dependencyWarnings" in got));
});

test("依賴的項目還沒完成：create／get 都回 dependencyWarnings（不擋）；完成後警告消失但仍列依賴", async () => {
  const p = await newProject(true);
  const a = await create(p, { title: "功能A" });
  const b = await create(p, { title: "功能B", dependsOn: [a.json.workItemId, a.json.workItemId] });
  assert.equal(b.isError, false, b.text);
  assert.deepEqual(b.json.dependsOn, [a.json.workItemId]);
  assert.deepEqual(b.json.dependencyWarnings, [{ workItemId: a.json.workItemId, title: "功能A" }]);
  assert.deepEqual((await statusOf(b.json.dir)).depends_on, [a.json.workItemId]);
  const got = (await env.call({ action: "get", workItemId: b.json.workItemId })).json;
  assert.equal(got.dependencyWarnings.length, 1);
  await finish(a.json.dir);
  const after = (await env.call({ action: "get", workItemId: b.json.workItemId })).json;
  assert.deepEqual(after.dependsOn, [a.json.workItemId]);
  assert.ok(!("dependencyWarnings" in after));
});

test("驗證：找不到、其他專案、自己依賴自己、格式不對、過多都拒絕", async () => {
  const p = await newProject(true);
  const other = await newProject(true);
  const a = await create(p, { title: "A" });
  const o = await create(other, { title: "別專案" });
  for (const d of [["wi-20990101-999"], [o.json.workItemId], ["abc"], Array.from({ length: 11 }, (_, i) => `wi-20260101-${i + 1}`)]) {
    const r = await create(p, { dependsOn: d });
    assert.equal(r.isError, true, JSON.stringify(d));
  }
  const self = await env.call({ action: "set_scope", workItemId: a.json.workItemId, dependsOn: [a.json.workItemId] });
  assert.equal(self.isError, true);
  assert.match(self.json.message, /自己/);
});

test("set_scope 可改 dependsOn、給空陣列整個 key 拿掉；SA 確認後仍可改（依賴關係不是範圍）", async () => {
  const p = await newProject(true);
  const a = await create(p, { title: "A" });
  const b = await create(p, { title: "B" });
  const set = await env.call({ action: "set_scope", workItemId: b.json.workItemId, dependsOn: [a.json.workItemId] });
  assert.equal(set.isError, false, set.text);
  assert.equal(set.json.dependencyWarnings.length, 1);
  const st = await statusOf(b.json.dir);
  st.work_item_progress ??= { roles: {}, gates: {} };
  st.work_item_progress.gates["sa-confirm"] = { decision: "confirmed", by: "human", at: new Date().toISOString() };
  await writeFile(path.join(b.json.dir, "status.json"), JSON.stringify(st));
  const cleared = await env.call({ action: "set_scope", workItemId: b.json.workItemId, dependsOn: [] });
  assert.equal(cleared.isError, false, cleared.text);
  assert.ok(!Object.keys(await statusOf(b.json.dir)).includes("depends_on"));
});

test("SA 確認時，依賴的項目還沒完成會在回覆附 dependencyWarnings（照樣確認成功）", async () => {
  const p = await newProject(true);
  const a = await create(p, { title: "A" });
  const b = (await create(p, { title: "B", dependsOn: [a.json.workItemId] })).json;
  await runUntil(env, b.workItemId, b.dir, "sa-confirm");
  const r = await env.call({ action: "confirm", workItemId: b.workItemId, gateId: "sa-confirm", decision: "confirmed", by: "human", reason: "使用者說確認" });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.dependencyWarnings.length, 1);
  assert.equal(r.json.dependencyWarnings[0].workItemId, a.json.workItemId);
});
