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

test("1M 擋住：SD 確認時依賴的工作項目未完成，AI 不能代確認；本人可放行；完成後、打回、其他關卡都不擋", async () => {
  const { requireDependenciesReady } = await import("../dist/work-item-actions/module-map-checks.js");
  const p = await newProject(true);
  const a = (await create(p, { title: "A" })).json;
  const st = { project_dir: p, depends_on: [a.workItemId] };
  await assert.rejects(requireDependenciesReady(st, "sd-confirm", "agent", "confirmed"), /依賴的工作項目.*未完成.*本人/);
  await requireDependenciesReady(st, "sd-confirm", "human", "confirmed");
  await requireDependenciesReady(st, "sd-confirm", "agent", "rejected");
  await requireDependenciesReady(st, "sa-confirm", "agent", "confirmed");
  await requireDependenciesReady({ project_dir: p }, "sd-confirm", "agent", "confirmed");
  await finish(a.dir);
  await requireDependenciesReady(st, "sd-confirm", "agent", "confirmed");
});

test("1M 擋住：專案關掉 multiModule 後，已宣告的依賴不再擋", async () => {
  const { requireDependenciesReady } = await import("../dist/work-item-actions/module-map-checks.js");
  const p = await newProject(true);
  const a = (await create(p, { title: "A" })).json;
  await setFlow(p, { schemaVersion: 1, multiModule: false });
  await requireDependenciesReady({ project_dir: p, depends_on: [a.workItemId] }, "sd-confirm", "agent", "confirmed");
});

test("1M 放行登記：本人在 SD 確認放行會寫進 release-register.md；releaseDue 格式與過去日期被拒絕；沒有放行就不寫", async () => {
  const p = await newProject(true);
  const a = (await create(p, { title: "A" })).json;
  const b = (await create(p, { title: "B", dependsOn: [a.workItemId] })).json;
  await runUntil(env, b.workItemId, b.dir, "sd-confirm");
  const confirm = (extra) => env.call({ action: "confirm", workItemId: b.workItemId, gateId: "sd-confirm", decision: "confirmed", by: "human", reason: "使用者說先做，我負責補", ...extra });
  const bad = await confirm({ releaseDue: "2026/12/01" });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /releaseDue/);
  const past = await confirm({ releaseDue: "2020-01-01" });
  assert.equal(past.isError, true);
  assert.match(past.text, /早於今天/);
  const none = await env.call({ action: "project_doc_read", workItemId: b.workItemId, filename: "release-register.md" });
  assert.ok(none.isError || !none.json?.exists, "被拒絕時不能留下登記");
  const ok = await confirm({ releaseDue: "2099-01-01" });
  assert.equal(ok.isError, false, ok.text);
  assert.equal(ok.json.releaseRecorded.file, "release-register.md");
  assert.equal(ok.json.releaseRecorded.due, "2099-01-01");
  const doc = await env.call({ action: "project_doc_read", workItemId: b.workItemId, filename: "release-register.md" });
  assert.match(doc.text, new RegExp(b.workItemId));
  assert.match(doc.text, /到期日：2099-01-01/);
  assert.match(doc.text, /使用者說先做，我負責補/);
});

test("1M 放行登記：依賴已完成時本人確認不登記；get 回逾期放行提醒，未逾期不多欄位", async () => {
  const p = await newProject(true);
  const a = (await create(p, { title: "A" })).json;
  const b = (await create(p, { title: "B", dependsOn: [a.workItemId] })).json;
  await finish(a.dir);
  await runUntil(env, b.workItemId, b.dir, "sd-confirm");
  const r = await env.call({ action: "confirm", workItemId: b.workItemId, gateId: "sd-confirm", decision: "confirmed", by: "human", reason: "使用者說確認" });
  assert.equal(r.isError, false, r.text);
  assert.ok(!("releaseRecorded" in r.json));
  const clean = await env.call({ action: "get", workItemId: b.workItemId });
  assert.ok(!("releaseWarnings" in clean.json));
  const w = await env.call({ action: "project_doc_write", workItemId: b.workItemId, filename: "release-register.md", content: "- wi-20200101-001｜舊放行｜放行日：2020-01-01｜到期日：2020-02-01\n- wi-20990101-001｜新放行｜放行日：2026-11-25｜到期日：2099-01-01\n" });
  assert.equal(w.isError, false, w.text);
  const got = await env.call({ action: "get", workItemId: b.workItemId });
  assert.equal(got.json.releaseWarnings.length, 1);
  assert.match(got.json.releaseWarnings[0], /wi-20200101-001.*逾期/);
});

test("1M 循環依賴：set_scope 讓依賴形成環（直接或間接）會被拒絕並列出路徑；不成環照常成功", async () => {
  const p = await newProject(true);
  const a = (await create(p, { title: "A" })).json;
  const b = (await create(p, { title: "B", dependsOn: [a.workItemId] })).json;
  const c = (await create(p, { title: "C", dependsOn: [b.workItemId] })).json;
  const direct = await env.call({ action: "set_scope", workItemId: a.workItemId, dependsOn: [b.workItemId] });
  assert.equal(direct.isError, true);
  assert.match(direct.text, /循環/);
  assert.ok(direct.text.includes(a.workItemId) && direct.text.includes(b.workItemId));
  const indirect = await env.call({ action: "set_scope", workItemId: a.workItemId, dependsOn: [c.workItemId] });
  assert.equal(indirect.isError, true);
  assert.match(indirect.text, /循環/);
  assert.ok(!Object.keys(await statusOf(a.dir)).includes("depends_on"), "被拒絕時不能寫入");
  const d = (await create(p, { title: "D" })).json;
  const fine = await env.call({ action: "set_scope", workItemId: d.workItemId, dependsOn: [c.workItemId, a.workItemId] });
  assert.equal(fine.isError, false, fine.text);
});

test("1M 模組名稱核對：宣告的模組不在模組地圖，create／set_scope／get 都回 moduleWarnings（只警告）；沒地圖或都存在不多欄位", async () => {
  const p = await newProject(true);
  const noMap = (await create(p, { title: "無地圖", modules: ["隨便"] })).json;
  assert.ok(!("moduleWarnings" in noMap), "沒有模組地圖不檢查");
  await mkdir(path.join(p, ".dev-pipeline", "project-docs"), { recursive: true });
  await writeFile(path.join(p, ".dev-pipeline", "project-docs", "module-map.md"), "## 模組：會員\n- 負責人：小王\n\n## 模組：訂單\n- 負責人：小李\n");
  const ok = (await create(p, { title: "正常", modules: ["會員", "訂單"] })).json;
  assert.ok(!("moduleWarnings" in ok));
  const typo = await create(p, { title: "打錯字", modules: ["會員", "訂單們"] });
  assert.equal(typo.isError, false, typo.text);
  assert.equal(typo.json.moduleWarnings.length, 1);
  assert.match(typo.json.moduleWarnings[0], /訂單們/);
  const got = await env.call({ action: "get", workItemId: typo.json.workItemId });
  assert.equal(got.json.moduleWarnings.length, 1);
  const fixed = await env.call({ action: "set_scope", workItemId: typo.json.workItemId, modules: ["會員", "訂單"] });
  assert.equal(fixed.isError, false, fixed.text);
  assert.ok(!("moduleWarnings" in fixed.json));
});
