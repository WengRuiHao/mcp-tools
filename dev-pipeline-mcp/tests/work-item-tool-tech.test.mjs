// 技術選型：tech-stack.md 與 baseline「現有技術棧」的程式檢查、技術確認關卡（沿用現有自動記錄／其他來源等使用者）、舊快照相容。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setupEnv, fulfil, CLEAN_REVIEW } from "./helpers/work-item-env.mjs";
import { BASELINE_TECH_OK, STACK_TABLE, techStackFor } from "./helpers/tech-fixtures.mjs";
import { checkTechStack, checkBaselineTechStack } from "../dist/workflow/tech-stack-check.js";

const env = await setupEnv("wi-tech-");
after(() => env.cleanup());
const done = (id, roleId) => env.call({ action: "done", workItemId: id, roleId });
const confirmTech = (id, extra = {}) => env.call({ action: "confirm", workItemId: id, gateId: "tech-confirm", decision: "confirmed", by: "human", reason: "使用者說技術棧確認", ...extra });
const progress = async (id) => (await env.store.readStatus(id)).work_item_progress;

test("checkTechStack：合格文件通過；各來源額外章節", () => {
  for (const src of ["new-guided", "existing", "new-select", "change"]) assert.deepEqual(checkTechStack(techStackFor(src), { techSource: src, baselineText: BASELINE_TECH_OK }), [], src);
});

test("checkTechStack：缺三個必要章節逐項回報", () => {
  const r = checkTechStack("隨便寫寫", { techSource: "new-guided" });
  assert.equal(r.length, 3);
  assert.ok(r.some((x) => x.includes("技術來源")) && r.some((x) => x.includes("選擇理由")) && r.some((x) => x.includes("技術棧")));
  assert.ok(checkTechStack("## 技術來源\nx\n## 技術棧\n\n## 選擇理由\n\n", { techSource: "new-guided" }).some((x) => x.includes("選擇理由")));
});

test("checkTechStack：表格缺項、空白、無／N/A／待定不通過；不適用要在選擇理由說明", () => {
  const base = (table, reason = "依來源決定。") => `## 技術來源\nnew-guided\n## 技術棧\n${table}## 選擇理由\n${reason}\n`;
  assert.ok(checkTechStack(base("沒有表格\n"), { techSource: "new-guided" }).some((x) => x.includes("markdown 表格")));
  const missing = STACK_TABLE.replace("| 資料庫版本 | 8.0 |\n", "");
  assert.ok(checkTechStack(base(missing), { techSource: "new-guided" }).some((x) => x.includes("資料庫版本")));
  for (const bad of ["", "無", "N/A", "待定", "TBD"]) {
    const t = STACK_TABLE.replace("| 後端框架 | Spring Boot |", `| 後端框架 | ${bad} |`);
    assert.ok(checkTechStack(base(t), { techSource: "new-guided" }).some((x) => x.includes("後端框架")), JSON.stringify(bad));
  }
  const na = STACK_TABLE.replace("| 前端元件庫 | Element Plus |", "| 前端元件庫 | 不適用 |");
  assert.ok(checkTechStack(base(na), { techSource: "new-guided" }).some((x) => x.includes("說明為什麼不適用")));
  assert.deepEqual(checkTechStack(base(na, "純後端沒有元件庫，不適用。"), { techSource: "new-guided" }), []);
});

test("checkTechStack：全新待選要 2 個方案各有優缺點、學習與維運成本、相容性，並寫明選了哪一個", () => {
  const stack = `## 技術棧\n${STACK_TABLE}`;
  const doc = (cands, reason) => `## 技術來源\nnew-select\n${cands}${stack}## 選擇理由\n${reason}\n`;
  assert.ok(checkTechStack(doc("", "選方案 A"), { techSource: "new-select" }).some((x) => x.includes("候選方案")));
  assert.ok(checkTechStack(doc("## 候選方案\n### 方案 A\n優缺點 學習 維運 相容\n", "選方案 A"), { techSource: "new-select" }).some((x) => x.includes("至少要有 2 個")));
  const two = "## 候選方案\n### 方案 A\n優缺點：好。學習與維運成本：低。相容性：高。\n### 方案 B\n優缺點：新。學習與維運成本：高。\n";
  const r = checkTechStack(doc(two, "選方案 A"), { techSource: "new-select" });
  assert.equal(r.length, 1);
  assert.match(r[0], /方案 B.*相容性/);
  const full = techStackFor("new-select");
  assert.ok(checkTechStack(full.replace("選方案 A，因為成熟穩定。", "成熟穩定。"), { techSource: "new-select" }).some((x) => x.includes("選了哪一個")));
  assert.deepEqual(checkTechStack(full, { techSource: "new-select" }), []);
});

test("checkTechStack：換技術要有目標技術；沿用現有要有可對照的 baseline 現有技術棧", () => {
  const noTarget = techStackFor("new-guided");
  assert.ok(checkTechStack(noTarget, { techSource: "change" }).some((x) => x.includes("目標技術")));
  assert.ok(checkTechStack(techStackFor("existing"), { techSource: "existing", baselineText: "基線" }).some((x) => x.includes("現有技術棧")));
  assert.ok(checkTechStack(techStackFor("existing"), { techSource: "existing" }).some((x) => x.includes("現有技術棧")));
});

test("checkBaselineTechStack：缺章節或只有標題都不通過", () => {
  assert.equal(checkBaselineTechStack("基線", "baseline.md").length, 1);
  assert.equal(checkBaselineTechStack("## 現有技術棧\n\n## 別的\nx", "baseline.md").length, 1);
  assert.deepEqual(checkBaselineTechStack(BASELINE_TECH_OK, "baseline.md"), []);
});

test("greenfield 全新待選：tech-selector 先做、檢查不合格不標記完成、通過後停在技術確認等使用者", async () => {
  const { id, dir } = await env.create();
  assert.equal((await done(id, "mockup-designer")).isError, true, "技術確認前 mockup 不能交件");
  await writeFile(path.join(dir, "tech-stack.md"), techStackFor("new-guided"));
  const bad = await done(id, "tech-selector");
  assert.equal(bad.isError, true);
  assert.match(bad.json.message, /候選方案/);
  await fulfil(dir, "tech-selector");
  const ok = await done(id, "tech-selector");
  assert.equal(ok.isError, false);
  assert.equal(ok.json.waitingGates[0].gateId, "tech-confirm");
  assert.equal(ok.json.waitingGates[0].waitingFor, "user");
  assert.match(ok.json.summary, /等使用者確認/);
  assert.deepEqual(ok.json.nextRoles, []);
});

test("技術確認：agent 不可代確認；human 必附原話；確認後才輪到 mockup 設計師", async () => {
  const { id, dir } = await env.create();
  await fulfil(dir, "tech-selector");
  await done(id, "tech-selector");
  const agent = await env.call({ action: "confirm", workItemId: id, gateId: "tech-confirm", decision: "confirmed", by: "agent", review: CLEAN_REVIEW });
  assert.equal(agent.isError, true);
  assert.match(agent.json.message, /使用者本人/);
  const noQuote = await confirmTech(id, { reason: "" });
  assert.equal(noQuote.isError, true);
  assert.match(noQuote.json.message, /原話/);
  const ok = await confirmTech(id);
  assert.equal(ok.isError, false);
  assert.equal(ok.json.nextRoles[0].roleId, "mockup-designer");
  assert.equal((await progress(id)).gates["tech-confirm"].by, "human");
  assert.equal((await env.call({ action: "get", workItemId: id })).json.techSourceLocked, true);
});

test("技術確認被專案 flow.json 覆寫成 auto 也不能讓 agent 代確認", async () => {
  const { id, dir } = await env.create();
  const flow = path.join(env.projectDir, ".pipeline", "flow.json");
  await mkdir(path.dirname(flow), { recursive: true });
  await writeFile(flow, JSON.stringify({ schemaVersion: 1, gates: { "tech-confirm": { confirmMode: "auto" } } }));
  await fulfil(dir, "tech-selector");
  const d = await done(id, "tech-selector");
  assert.equal(d.json.waitingGates[0].waitingFor, "user");
  const agent = await env.call({ action: "confirm", workItemId: id, gateId: "tech-confirm", decision: "confirmed", by: "agent", review: CLEAN_REVIEW });
  assert.equal(agent.isError, true);
  const { rm } = await import("node:fs/promises");
  await rm(flow, { force: true });
});

test("技術確認打回：倒回 tech-selector 與下游，之後可改技術來源", async () => {
  const { id, dir } = await env.create();
  await fulfil(dir, "tech-selector");
  await done(id, "tech-selector");
  const blocked = await env.call({ action: "set_scope", workItemId: id, techSource: "new-guided" });
  assert.equal(blocked.isError, true);
  assert.match(blocked.json.message, /打回/);
  const rej = await env.call({ action: "confirm", workItemId: id, gateId: "tech-confirm", decision: "rejected", by: "human", reason: "不要這組方案" });
  assert.equal(rej.isError, false);
  assert.deepEqual(rej.json.rewoundRoles, ["tech-selector"]);
  assert.equal(rej.json.nextRoles[0].roleId, "tech-selector");
  const ok = await env.call({ action: "set_scope", workItemId: id, techSource: "new-guided" });
  assert.equal(ok.isError, false);
});

test("brownfield 沿用現有：baseline 缺現有技術棧不通過；tech-selector 交件後程式自動記錄技術確認，不需也不可確認", async () => {
  const { id, dir } = await env.create({ baseline: "brownfield" });
  await mkdir(path.join(dir, "sa-mockup"), { recursive: true });
  await writeFile(path.join(dir, "baseline.md"), "基線");
  await writeFile(path.join(dir, "impact.md"), "影響\n## 可重用清單\n- ExcelUtil：a.java\n");
  const bad = await done(id, "baseline-survey");
  assert.equal(bad.isError, true);
  assert.match(bad.json.message, /現有技術棧/);
  await fulfil(dir, "baseline-survey");
  assert.equal((await done(id, "baseline-survey")).isError, false);
  await fulfil(dir, "tech-selector");
  const ok = await done(id, "tech-selector");
  assert.equal(ok.isError, false);
  assert.equal(ok.json.nextRoles[0].roleId, "mockup-designer");
  const gate = (await progress(id)).gates["tech-confirm"];
  assert.equal(gate.by, "agent");
  assert.match(gate.reason, /沿用現有，只記錄不需確認/);
  const again = await confirmTech(id);
  assert.equal(again.isError, true);
  assert.match(again.json.message, /不需確認/);
  assert.equal((await env.call({ action: "get", workItemId: id })).json.techSourceLocked, true);
});

test("brownfield 換技術：等使用者確認，需要目標技術", async () => {
  const { id, dir } = await env.create({ baseline: "brownfield", renewal: true, styleSource: "existing", techSource: "change" });
  await fulfil(dir, "baseline-survey");
  assert.equal((await done(id, "baseline-survey")).isError, false);
  await writeFile(path.join(dir, "tech-stack.md"), techStackFor("new-guided"));
  const bad = await done(id, "tech-selector");
  assert.match(bad.json.message, /目標技術/);
  await fulfil(dir, "tech-selector");
  const ok = await done(id, "tech-selector");
  assert.equal(ok.json.waitingGates[0].waitingFor, "user");
});

test("舊快照相容：快照沒有 tech-selector 的進行中項目不受影響（不出現技術選型、可正常完成後續角色）", async () => {
  const { id, dir } = await env.create({ scope: "backend", hasDb: false });
  await env.store.updateStatus(id, (s) => ({ ...s, workflow_snapshot: { ...s.workflow_snapshot, stage_order: s.workflow_snapshot.stage_order.filter((x) => x !== "tech-selector"), roles: s.workflow_snapshot.roles.filter((r) => r.id !== "tech-selector") } }));
  const g = await env.call({ action: "get", workItemId: id });
  assert.equal(g.json.nextRoles[0].roleId, "sa-analyst");
  assert.deepEqual(g.json.waitingGates, []);
  assert.equal((await done(id, "tech-selector")).isError, true);
  await fulfil(dir, "sa-analyst");
  assert.equal((await done(id, "sa-analyst")).isError, false);
});
