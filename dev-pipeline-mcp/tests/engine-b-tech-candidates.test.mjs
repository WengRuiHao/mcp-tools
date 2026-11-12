// 問題 36：tech-stack.md 含「候選方案」時，即使技術來源為沿用現有，tech-confirm 也必須由使用者確認。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setupEnv, fulfil, CLEAN_REVIEW } from "./helpers/work-item-env.mjs";
import { techStackFor } from "./helpers/tech-fixtures.mjs";
import { hasTechCandidates } from "../dist/workflow/tech-stack-check.js";

const env = await setupEnv("wi-eng-b-techcand-");
after(() => env.cleanup());
const CANDIDATES = "## 候選方案\n### 方案 A\n使用外部套件 exceljs。優缺點：功能完整。學習與維運成本：低。與現有專案相容性：高。\n### 方案 B\n自行實作。優缺點：無相依。學習與維運成本：高。與現有專案相容性：高。\n";
const gate = async (id) => (await env.store.readStatus(id)).work_item_progress.gates["tech-confirm"];

async function toTechSelector(extra) {
  const { id, dir } = await env.create({ baseline: "brownfield" });
  await fulfil(dir, "baseline-survey");
  assert.equal((await env.call({ action: "done", workItemId: id, roleId: "baseline-survey" })).isError, false);
  await writeFile(path.join(dir, "tech-stack.md"), techStackFor("existing") + extra);
  return { id, dir, done: await env.call({ action: "done", workItemId: id, roleId: "tech-selector" }) };
}

test("hasTechCandidates：有方案子標題或實質內容才算；沒有小節、空白、「無」都不算", () => {
  assert.equal(hasTechCandidates("## 技術來源\nexisting\n" + CANDIDATES), true);
  assert.equal(hasTechCandidates("## 候選方案\n是否使用外部套件 exceljs 需使用者決定\n"), true);
  assert.equal(hasTechCandidates("## 技術來源\nexisting\n"), false);
  assert.equal(hasTechCandidates("## 候選方案\n"), false);
  for (const none of ["無", "- 無", "無。沿用現有技術", "沒有", "N/A", "不適用"]) assert.equal(hasTechCandidates(`## 候選方案\n${none}\n## 選擇理由\n沿用\n`), false, none);
  assert.equal(hasTechCandidates("```\n## 候選方案\n### 方案 A\n```\n"), false);
});

test("沿用現有且含候選方案：tech-confirm 不自動通過，改等使用者，get 提示說明原因", async () => {
  const { id, done } = await toTechSelector(CANDIDATES);
  assert.equal(done.isError, false, done.text);
  assert.match(done.json.techConfirmNote, /候選方案/);
  assert.equal(await gate(id), undefined);
  const g = done.json.waitingGates.find((x) => x.gateId === "tech-confirm");
  assert.equal(g.waitingFor, "user");
  assert.match(g.howTo, /候選方案/);
  const got = await env.call({ action: "get", workItemId: id });
  assert.match(got.json.waitingGates[0].howTo, /沿用現有，但 tech-stack\.md 含「候選方案」/);
});

test("含候選方案：AI 不可確認；使用者確認後通過", async () => {
  const { id } = await toTechSelector(CANDIDATES);
  const agent = await env.call({ action: "confirm", workItemId: id, gateId: "tech-confirm", decision: "confirmed", by: "agent", review: CLEAN_REVIEW });
  assert.equal(agent.isError, true);
  assert.match(agent.json.message, /使用者本人/);
  const human = await env.call({ action: "confirm", workItemId: id, gateId: "tech-confirm", decision: "confirmed", by: "human", reason: "使用者說用方案 A" });
  assert.equal(human.isError, false, human.text);
  assert.equal((await gate(id)).by, "human");
});

test("含候選方案：使用者打回後重交、改成沒有候選方案，重新判定為自動通過", async () => {
  const { id, dir } = await toTechSelector(CANDIDATES);
  await env.call({ action: "confirm", workItemId: id, gateId: "tech-confirm", decision: "rejected", by: "human", reason: "使用者說不要新套件" });
  await writeFile(path.join(dir, "tech-stack.md"), techStackFor("existing") + "## 候選方案\n無\n");
  const again = await env.call({ action: "done", workItemId: id, roleId: "tech-selector" });
  assert.equal(again.isError, false, again.text);
  assert.equal(again.json.techConfirmNote, undefined);
  assert.equal((await gate(id)).by, "agent");
});

test("沒有候選方案（沿用現有）：維持現狀，自動記錄不需確認", async () => {
  const { id, done } = await toTechSelector("");
  assert.equal(done.isError, false, done.text);
  assert.equal(done.json.techConfirmNote, undefined);
  assert.equal((await gate(id)).by, "agent");
  const c = await env.call({ action: "confirm", workItemId: id, gateId: "tech-confirm", decision: "confirmed", by: "human", reason: "使用者說確認" });
  assert.equal(c.isError, true);
  assert.match(c.json.message, /沿用現有/);
});
