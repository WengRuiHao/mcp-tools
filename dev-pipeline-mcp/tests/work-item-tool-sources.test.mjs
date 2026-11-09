// 畫面風格來源與技術來源：create 預設值規則、組合驗證、set_scope 修改與鎖定、get 顯示、專案規範附在角色說明。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setupEnv, runUntil } from "./helpers/work-item-env.mjs";

const env = await setupEnv("wi-sources-");
after(() => env.cleanup());
const flowFile = path.join(env.projectDir, ".pipeline", "flow.json");

async function writeFlow(obj) {
  await mkdir(path.dirname(flowFile), { recursive: true });
  await writeFile(flowFile, JSON.stringify({ schemaVersion: 1, ...obj }));
}
const createRaw = (extra) => env.call({ action: "create", projectDir: env.projectDir, title: "來源測試", requirement: "需求", baseline: "greenfield", scope: "both", hasDb: true, ...extra });

test("既有系統非翻新：沒給就是沿用現有；status.json 有兩個欄位", async () => {
  const r = await createRaw({ baseline: "brownfield" });
  assert.equal(r.isError, false);
  assert.equal(r.json.styleSource, "existing");
  assert.equal(r.json.techSource, "existing");
  const st = JSON.parse(await readFile(path.join(r.json.dir, "status.json"), "utf-8"));
  assert.equal(st.style_source, "existing");
  assert.equal(st.tech_source, "existing");
});

test("既有系統翻新案：沒給或只給一個一律回錯誤，不替使用者猜；明確給了才建立", async () => {
  const none = await createRaw({ baseline: "brownfield", renewal: true });
  assert.equal(none.isError, true);
  assert.match(none.json.message, /翻新案.*不替你猜.*styleSource.*techSource/);
  const half = await createRaw({ baseline: "brownfield", renewal: true, styleSource: "redesign" });
  assert.equal(half.isError, true);
  assert.match(half.json.message, /techSource/);
  assert.doesNotMatch(half.json.message, /缺少：styleSource/);
  const ok = await createRaw({ baseline: "brownfield", renewal: true, styleSource: "redesign", techSource: "existing" });
  assert.equal(ok.isError, false);
  assert.equal(ok.json.styleSource, "redesign");
  assert.equal(ok.json.techSource, "existing");
});

test("全新系統：沒有專案規範是全新待選；有規範是全新有規範；可分開各自判斷", async () => {
  await rm(flowFile, { force: true });
  const a = await createRaw();
  assert.equal(a.json.styleSource, "new-select");
  assert.equal(a.json.techSource, "new-select");
  await writeFlow({ styleGuide: "品牌藍、圓角" });
  const b = await createRaw();
  assert.equal(b.json.styleSource, "new-guided");
  assert.equal(b.json.techSource, "new-select");
  await writeFlow({ styleGuide: "品牌藍", techGuide: "Java 17＋Vue 3" });
  const c = await createRaw();
  assert.equal(c.json.techSource, "new-guided");
  const d = await createRaw({ styleSource: "new-select" });
  assert.equal(d.json.styleSource, "new-select", "明確給的優先於專案規範");
  await rm(flowFile, { force: true });
});

test("組合驗證：全新系統不可選沿用／換新／換技術，既有系統不可選全新；全新系統不可翻新", async () => {
  for (const extra of [{ styleSource: "existing" }, { styleSource: "redesign" }, { techSource: "existing" }, { techSource: "change" }]) {
    const r = await createRaw(extra);
    assert.equal(r.isError, true, JSON.stringify(extra));
    assert.match(r.json.message, /全新系統不可選.*可選：new-guided/);
  }
  for (const extra of [{ styleSource: "new-guided" }, { styleSource: "new-select" }, { techSource: "new-guided" }, { techSource: "new-select" }]) {
    const r = await createRaw({ baseline: "brownfield", ...extra });
    assert.equal(r.isError, true, JSON.stringify(extra));
    assert.match(r.json.message, /既有系統不可選.*可選：existing/);
  }
  const rn = await createRaw({ renewal: true });
  assert.equal(rn.isError, true);
  assert.match(rn.json.message, /renewal.*既有系統/);
});

test("壞掉的 flow.json 讓 create 回清楚錯誤", async () => {
  await mkdir(path.dirname(flowFile), { recursive: true });
  await writeFile(flowFile, "{壞掉");
  const r = await createRaw();
  assert.equal(r.isError, true);
  assert.match(r.json.message, /flow\.json/);
  await rm(flowFile, { force: true });
});

test("get 顯示兩個來源與鎖定狀態；舊項目沒有欄位時顯示 null", async () => {
  const { id } = await env.create();
  const g = await env.call({ action: "get", workItemId: id });
  assert.equal(g.json.styleSource, "new-select");
  assert.equal(g.json.styleSourceLocked, false);
  assert.equal(g.json.techSource, "new-select");
  assert.equal(g.json.techSourceLocked, false);
  await env.store.updateStatus(id, (s) => {
    const { style_source, tech_source, ...rest } = s;
    return rest;
  });
  const old = await env.call({ action: "get", workItemId: id });
  assert.equal(old.json.styleSource, null);
  assert.equal(old.json.techSource, null);
});

test("set_scope：可改兩個來源（驗證組合）；組合不合法整筆不寫入", async () => {
  const { id } = await env.create();
  const ok = await env.call({ action: "set_scope", workItemId: id, styleSource: "new-guided", techSource: "new-guided" });
  assert.equal(ok.isError, false);
  assert.equal(ok.json.styleSource, "new-guided");
  assert.equal(ok.json.techSource, "new-guided");
  const bad = await env.call({ action: "set_scope", workItemId: id, scope: "backend", styleSource: "existing" });
  assert.equal(bad.isError, true);
  assert.match(bad.json.message, /全新系統不可選/);
  const g = await env.call({ action: "get", workItemId: id });
  assert.equal(g.json.scope, "both", "整筆不寫入");
});

test("set_scope：styleSource 在 mockup 確認後鎖定；值沒變不算修改", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "sa-analyst");
  const locked = await env.call({ action: "set_scope", workItemId: id, styleSource: "new-guided" });
  assert.equal(locked.isError, true);
  assert.match(locked.json.message, /mockup 已確認.*鎖定/);
  assert.equal((await env.call({ action: "get", workItemId: id })).json.styleSourceLocked, true);
  const same = await env.call({ action: "set_scope", workItemId: id, styleSource: "new-select" });
  assert.equal(same.isError, false);
});

test("set_scope：mockup 已交件但尚未確認時要先打回；打回後可改", async () => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "mockup-confirm");
  const r = await env.call({ action: "set_scope", workItemId: id, styleSource: "new-guided" });
  assert.equal(r.isError, true);
  assert.match(r.json.message, /打回/);
  const rej = await env.call({ action: "confirm", workItemId: id, gateId: "mockup-confirm", decision: "rejected", by: "human", reason: "風格不對重畫" });
  assert.equal(rej.isError, false);
  const ok = await env.call({ action: "set_scope", workItemId: id, styleSource: "new-guided" });
  assert.equal(ok.isError, false);
});

test("tech 鎖定：技術確認通過後不可改 techSource", async () => {
  const { id } = await env.create();
  await env.store.updateStatus(id, (s) => ({ ...s, work_item_progress: { roles: {}, gates: { "tech-confirm": { decision: "confirmed", by: "human", at: "2026-01-01T00:00:00Z" } } } }));
  const r = await env.call({ action: "set_scope", workItemId: id, techSource: "new-guided" });
  assert.equal(r.isError, true);
  assert.match(r.json.message, /技術確認已通過.*鎖定/);
  assert.equal((await env.call({ action: "get", workItemId: id })).json.techSourceLocked, true);
});

test("role_prompt：mockup-designer 附 styleGuide（有標題），沒有規範時不附", async () => {
  const { id } = await env.create();
  await writeFlow({ styleGuide: "主色#0055AA、圓角 8px" });
  const r = await env.call({ action: "role_prompt", workItemId: id, roleId: "mockup-designer" });
  assert.match(r.json.prompt, /## 專案畫面風格規範（styleGuide）\n主色#0055AA、圓角 8px/);
  assert.equal(r.json.hasProjectGuide, true);
  const other = await env.call({ action: "role_prompt", workItemId: id, roleId: "sa-analyst" });
  assert.doesNotMatch(other.json.prompt, /主色#0055AA/);
  await rm(flowFile, { force: true });
  const none = await env.call({ action: "role_prompt", workItemId: id, roleId: "mockup-designer" });
  assert.equal(none.json.hasProjectGuide, false);
  assert.doesNotMatch(none.json.prompt, /專案畫面風格規範/);
});
