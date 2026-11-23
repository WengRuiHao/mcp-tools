// highRisk 開關（批次 1-A）：只在 true 時寫入狀態檔與回覆；SA 確認後鎖定；進入 when context。全部用暫存目錄隔離。
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "wi-hr-data-"));
process.env.ASANA_PIPELINE_DATA_DIR = dataDir;

const { createWorkItem, updateWorkItemScope, buildWhenContext } = await import("../dist/work-item-store.js");
const { readStatus, recordSpecConfirmation } = await import("../dist/pipeline-store.js");
const { KNOWN_WHEN_KEYS, evalWhen } = await import("../dist/workflow/validate.js");

const base = { title: "高風險示範", requirement: "需求原文", baseline: "greenfield", scope: "both", hasDb: true, workflow: "spec-first" };
const newProject = () => mkdtemp(path.join(os.tmpdir(), "wi-hr-proj-"));
const readRaw = (dir) => readFile(path.join(dir, "status.json"), "utf-8");

test("沒給 highRisk：status.json 完全沒有 high_risk 這個 key（簡單需求逐字不變）", async () => {
  const { dir } = await createWorkItem({ ...base, projectDir: await newProject() });
  assert.ok(!Object.keys(JSON.parse(await readRaw(dir))).includes("high_risk"));
});

test("highRisk=false 也不寫入 high_risk", async () => {
  const { dir } = await createWorkItem({ ...base, highRisk: false, projectDir: await newProject() });
  assert.ok(!Object.keys(JSON.parse(await readRaw(dir))).includes("high_risk"));
});

test("highRisk=true：寫入 high_risk=true", async () => {
  const { id } = await createWorkItem({ ...base, highRisk: true, projectDir: await newProject() });
  assert.equal((await readStatus(id)).high_risk, true);
});

test("highRisk 不是布林值就拒絕建立與修改", async () => {
  const projectDir = await newProject();
  await assert.rejects(createWorkItem({ ...base, highRisk: "yes", projectDir }), /highRisk 必須是布林值/);
  const { id } = await createWorkItem({ ...base, projectDir });
  await assert.rejects(updateWorkItemScope(id, { highRisk: 1 }), /highRisk 必須是布林值/);
});

test("set_scope：SA 確認前可開可關，確認後鎖定", async () => {
  const { id } = await createWorkItem({ ...base, projectDir: await newProject() });
  assert.equal((await updateWorkItemScope(id, { highRisk: true })).high_risk, true);
  const off = await updateWorkItemScope(id, { highRisk: false });
  assert.ok(!Object.keys(off).includes("high_risk"), "關掉後不留 high_risk key");
  await updateWorkItemScope(id, { highRisk: true });
  await recordSpecConfirmation(id, true, "ok", false, "human");
  await assert.rejects(updateWorkItemScope(id, { highRisk: false }), /已確認/);
  assert.equal((await readStatus(id)).high_risk, true);
});

test("buildWhenContext 帶 highRisk 字串；when 可以用 highRisk==true 並可與 baseline 以 && 組合", () => {
  assert.equal(buildWhenContext({ baseline: "greenfield", scope: "both", has_db: true }).highRisk, "false");
  const on = buildWhenContext({ baseline: "greenfield", scope: "both", has_db: true, high_risk: true });
  assert.equal(on.highRisk, "true");
  assert.ok(KNOWN_WHEN_KEYS.includes("highRisk"));
  assert.equal(evalWhen("baseline==greenfield&&highRisk==true", on), true);
  assert.equal(evalWhen("baseline==greenfield&&highRisk==true", buildWhenContext({ baseline: "greenfield", scope: "both", has_db: true })), false);
  assert.equal(evalWhen("baseline==brownfield&&highRisk==true", on), false);
});

// ---- work_item 工具層：create／get／set_scope／交付摘要 ----
const { setupEnv } = await import("./helpers/work-item-env.mjs");
const { after } = await import("node:test");
const env = await setupEnv("wi-hr-");
after(() => env.cleanup());
const createArgs = (extra = {}) => ({ action: "create", projectDir: env.projectDir, title: "訂單", requirement: "要處理高併發訂單", baseline: "greenfield", scope: "both", hasDb: true, ...extra });

test("工具：create 沒給 highRisk，回覆與 get 都沒有 highRisk 欄位", async () => {
  const c = await env.call(createArgs());
  assert.equal(c.isError, false);
  assert.ok(!("highRisk" in c.json));
  const g = await env.call({ action: "get", workItemId: c.json.workItemId });
  assert.ok(!("highRisk" in g.json));
});

test("工具：create highRisk=true，回覆與 get 都顯示 highRisk=true", async () => {
  const c = await env.call(createArgs({ highRisk: true }));
  assert.equal(c.isError, false);
  assert.equal(c.json.highRisk, true);
  const g = await env.call({ action: "get", workItemId: c.json.workItemId });
  assert.equal(g.json.highRisk, true);
});

test("工具：set_scope 只給 highRisk 也可以，SA 確認後被鎖定", async () => {
  const c = await env.call(createArgs());
  const id = c.json.workItemId;
  const on = await env.call({ action: "set_scope", workItemId: id, highRisk: true });
  assert.equal(on.isError, false);
  assert.equal(on.json.highRisk, true);
  const off = await env.call({ action: "set_scope", workItemId: id, highRisk: false });
  assert.ok(!("highRisk" in off.json));
  const none = await env.call({ action: "set_scope", workItemId: id });
  assert.equal(none.isError, true);
  assert.match(none.json.message, /highRisk/);
});

test("工具：參數 schema 有 highRisk（布林）", async () => {
  const { tools } = await env.client.listTools();
  const t = tools.find((x) => x.name === "work_item");
  assert.equal(t.inputSchema.properties.highRisk.type, "boolean");
});

// ---- 1-B：技術選型拆分（只對 highRisk 生效）----
const { checkTechStack } = await import("../dist/workflow/tech-stack-check.js");
const { STACK_TABLE, techStackFor } = await import("./helpers/tech-fixtures.mjs");
const noDbTable = STACK_TABLE.replace("| 資料庫種類 | MySQL |\n", "").replace("| 資料庫版本 | 8.0 |\n", "");
const stackDoc = (table) => `## 技術來源\nnew-guided\n## 技術棧\n${table}## 選擇理由\n依來源決定。\n`;

test("一般需求：缺資料庫種類與版本照舊擋回（行為完全不變）", () => {
  const r = checkTechStack(stackDoc(noDbTable), { techSource: "new-guided" });
  assert.ok(r.some((x) => x.includes("資料庫種類")) && r.some((x) => x.includes("資料庫版本")));
  assert.ok(checkTechStack(stackDoc(noDbTable), { techSource: "new-guided", highRisk: false }).some((x) => x.includes("資料庫種類")));
});

test("highRisk：技術棧表格不再要求資料庫種類與版本，其餘列照舊要求", () => {
  assert.deepEqual(checkTechStack(stackDoc(noDbTable), { techSource: "new-guided", highRisk: true }), []);
  const noBackend = noDbTable.replace("| 後端語言 | Java |\n", "");
  assert.ok(checkTechStack(stackDoc(noBackend), { techSource: "new-guided", highRisk: true }).some((x) => x.includes("後端語言")));
});

test("highRisk：仍有資料庫列也合格（寫了不會被擋），佔位字樣也不檢查", () => {
  assert.deepEqual(checkTechStack(techStackFor("new-guided"), { techSource: "new-guided", highRisk: true }), []);
  const placeholder = STACK_TABLE.replace("| 資料庫種類 | MySQL |", "| 資料庫種類 | 待定 |");
  assert.deepEqual(checkTechStack(stackDoc(placeholder), { techSource: "new-guided", highRisk: true }), []);
});

test("highRisk：擋回訊息的列名範例不再列出資料庫種類與版本", () => {
  const r = checkTechStack(stackDoc("沒有表格\n"), { techSource: "new-guided", highRisk: true });
  assert.ok(r.length > 0 && r.every((x) => !x.includes("資料庫種類")));
});

test("工具：highRisk 工作項目的 tech-selector 交件，沒有資料庫列也通過；一般工作項目仍被擋", async () => {
  const make = async (extra) => {
    const c = await env.call(createArgs({ techSource: "new-guided", styleSource: "new-guided", ...extra }));
    return { id: c.json.workItemId, dir: c.json.dir };
  };
  const hi = await make({ highRisk: true });
  const lo = await make({});
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path.join(hi.dir, "tech-stack.md"), stackDoc(noDbTable));
  await writeFile(path.join(lo.dir, "tech-stack.md"), stackDoc(noDbTable));
  const rHi = await env.call({ action: "done", workItemId: hi.id, roleId: "tech-selector" });
  const rLo = await env.call({ action: "done", workItemId: lo.id, roleId: "tech-selector" });
  const text = (r) => JSON.stringify(r.json);
  assert.equal(rHi.isError, false, text(rHi).slice(0, 400));
  assert.ok(!text(rHi).includes("資料庫種類"), text(rHi).slice(0, 300));
  assert.equal(rLo.isError, true);
  assert.ok(text(rLo).includes("資料庫種類"), text(rLo).slice(0, 300));
});

test("角色說明：highRisk 的 tech-selector 附加段落；一般需求逐字等於靜態說明書", async () => {
  const { getSpecFirstRolePrompt } = await import("../dist/prompts-spec-first.js");
  const { highRiskPromptSection, MAX_SECTION_CHARS, HIGH_RISK_ROLE_IDS } = await import("../dist/work-item-actions/high-risk-prompt.js");
  const hi = (await env.call(createArgs({ highRisk: true }))).json.workItemId;
  const lo = (await env.call(createArgs({}))).json.workItemId;
  const pHi = await env.call({ action: "role_prompt", workItemId: hi, roleId: "tech-selector" });
  const pLo = await env.call({ action: "role_prompt", workItemId: lo, roleId: "tech-selector" });
  assert.match(pHi.json.prompt, /高風險需求：技術選型只選語言與框架/);
  assert.ok(!pLo.json.prompt.includes("高風險需求"));
  assert.equal(pLo.json.prompt, getSpecFirstRolePrompt("tech-selector", { workItemDir: (await env.call({ action: "get", workItemId: lo })).json.dir }));
  for (const id of HIGH_RISK_ROLE_IDS) assert.ok(highRiskPromptSection(id).length <= MAX_SECTION_CHARS, `${id} 段落超過上限`);
  const other = await env.call({ action: "role_prompt", workItemId: hi, roleId: "sa-analyst" });
  assert.ok(!other.json.prompt.includes("高風險需求：技術選型"));
});

test("角色說明：highRisk 的 sd-analyst 附加「上線與回滾」段落；一般需求不附加", async () => {
  const hi = (await env.call(createArgs({ highRisk: true }))).json.workItemId;
  const lo = (await env.call(createArgs({}))).json.workItemId;
  const pHi = await env.call({ action: "role_prompt", workItemId: hi, roleId: "sd-analyst" });
  const pLo = await env.call({ action: "role_prompt", workItemId: lo, roleId: "sd-analyst" });
  assert.match(pHi.json.prompt, /高風險需求：SD 要有「上線與回滾」章節/);
  assert.ok(!pLo.json.prompt.includes("上線與回滾"));
});

test("角色說明：highRisk 的 sa-analyst、tester、sd-analyst 附加追溯矩陣說明；一般需求不附加", async () => {
  const hi = (await env.call(createArgs({ highRisk: true }))).json.workItemId;
  const lo = (await env.call(createArgs({}))).json.workItemId;
  const get = async (id, roleId) => (await env.call({ action: "role_prompt", workItemId: id, roleId })).json.prompt;
  assert.match(await get(hi, "sa-analyst"), /需求編號/);
  assert.match(await get(hi, "tester"), /對應需求/);
  assert.match(await get(hi, "sd-analyst"), /追溯矩陣/);
  for (const r of ["sa-analyst", "tester", "sd-analyst"]) assert.ok(!(await get(lo, r)).includes("追溯矩陣") && !(await get(lo, r)).includes("高風險需求"), r);
});
