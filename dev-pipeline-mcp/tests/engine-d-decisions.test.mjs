// 問題 8、13 方案 2：使用者決定記錄（record_decision）與 sa-notes 待確認問題把關。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setupEnv, runUntil, CLEAN_REVIEW } from "./helpers/work-item-env.mjs";
import { parsePendingQuestions } from "../dist/work-item-actions/sa-notes-questions.js";
import { REVIEWER_PROMPT } from "../dist/prompts-spec-first/reviewer.js";

const env = await setupEnv("wi-eng-d-decisions-");
after(() => env.cleanup());

const NOTES_H3 = "## 待確認問題\n\n### Q1 10000 列上限是否含標題列\n不含。\n建議預設：不含標題列\n\n### Q2 單日區間是否允許\n建議預設：允許\n\n## 現況依據\n- 其他\n";
const rec = (id, extra = {}) => env.call({ action: "record_decision", workItemId: id, question: "Q1", answer: "不含標題列", reason: "使用者說就照你建議的", by: "human", ...extra });
const agentConfirm = (id) => env.call({ action: "confirm", workItemId: id, gateId: "sa-confirm", decision: "confirmed", by: "agent", reason: "審查通過", review: CLEAN_REVIEW });
const atSaConfirm = async (notes) => {
  const { id, dir } = await env.create();
  await runUntil(env, id, dir, "sa-confirm");
  if (notes !== undefined) {
    const w = await env.call({ action: "write", workItemId: id, filename: "sa-notes.md", content: notes });
    assert.equal(w.isError, false, w.text);
  }
  return { id, dir };
};

test("解析：子標題、編號清單、項目符號、表格；占位與已確認項不算；建議預設擷取", () => {
  const q = parsePendingQuestions(NOTES_H3);
  assert.deepEqual(q.map((x) => [x.id, x.title, x.suggestion]), [["Q1", "10000 列上限是否含標題列", "不含標題列"], ["Q2", "單日區間是否允許", "允許"]]);
  const list = parsePendingQuestions("## 待確認問題（未定案）\n1. 金額型態？目前解讀為數字\n2. 欄寬未規定（建議預設：自動）\n   補充說明\n- 已確認：不用問\n- 無\n## 其他\n");
  assert.deepEqual(list.map((x) => [x.id, x.suggestion]), [["Q1", undefined], ["Q2", "自動"]]);
  assert.equal(list[1].title, "欄寬未規定");
  const table = parsePendingQuestions("## 待確認問題\n| 問題 | 建議預設 |\n| --- | --- |\n| 日期含當天嗎 | 建議預設：含 |\n");
  assert.equal(table.length, 1);
  assert.equal(table[0].suggestion, "含");
  assert.deepEqual(parsePendingQuestions("## 待確認問題\n- 無\n"), []);
  assert.deepEqual(parsePendingQuestions("## 待確認問題\n（無）\n"), []);
  assert.deepEqual(parsePendingQuestions("## 需求依據\n- x\n"), []);
});

test("record_decision 拒絕：by 非 human、缺／太短／選項代號 reason、缺 question／answer；不寫入", async () => {
  const { id } = await atSaConfirm(NOTES_H3);
  const cases = [[{ by: "agent" }, /by:"human"/], [{ by: undefined }, /by:"human"/], [{ reason: undefined }, /reason/], [{ reason: "好" }, /reason/], [{ reason: "A2" }, /選項代號/], [{ question: undefined }, /question/], [{ answer: undefined }, /answer/]];
  for (const [extra, re] of cases) {
    const r = await rec(id, extra);
    assert.equal(r.isError, true, JSON.stringify(extra));
    assert.match(r.json.message, re);
  }
  assert.equal((await env.store.readStatus(id)).decisions, undefined);
});

test("sa-confirm：AI 核准在有未決待確認問題時被擋（訊息列清單與用法），打回不受限；human 核准不受限", async () => {
  const { id } = await atSaConfirm(NOTES_H3);
  const r = await agentConfirm(id);
  assert.equal(r.isError, true);
  assert.match(r.json.message, /Q1/);
  assert.match(r.json.message, /Q2/);
  assert.match(r.json.message, /record_decision/);
  assert.match(r.json.message, /acceptAllSuggested/);
  assert.equal(r.json.reason, "pending-decisions");
  assert.equal((await env.store.readStatus(id)).review_escalations, undefined);
  const rej = await env.call({ action: "confirm", workItemId: id, gateId: "sa-confirm", decision: "rejected", by: "agent", reason: "提示文字不符" });
  assert.equal(rej.isError, false, rej.text);
  const { id: id2 } = await atSaConfirm(NOTES_H3);
  const h = await env.call({ action: "confirm", workItemId: id2, gateId: "sa-confirm", decision: "confirmed", by: "human", reason: "使用者說確認" });
  assert.equal(h.isError, false, h.text);
});

test("逐項決定後才可核准；同題再記取代舊決定；get 與索引含決定", async () => {
  const { id, dir } = await atSaConfirm(NOTES_H3);
  assert.equal((await rec(id)).isError, false);
  assert.equal((await agentConfirm(id)).isError, true);
  const r2 = await rec(id, { question: "單日區間是否允許", answer: "允許", reason: "使用者說單日可以" });
  assert.equal(r2.isError, false, r2.text);
  assert.deepEqual(r2.json.pendingQuestions, []);
  const re = await rec(id, { answer: "含標題列", reason: "使用者改口說含標題列" });
  assert.equal(re.json.totalDecisions, 2);
  const g = (await env.call({ action: "get", workItemId: id })).json;
  assert.equal(g.decisions.length, 2);
  assert.equal(g.decisions.find((d) => d.question === "Q1").answer, "含標題列");
  assert.equal(g.pendingQuestions, undefined);
  const idx = await readFile(path.join(dir, "00-索引.md"), "utf-8");
  assert.match(idx, /使用者決定記錄/);
  assert.match(idx, /使用者說單日可以/);
  const ok = await agentConfirm(id);
  assert.equal(ok.isError, false, ok.text);
});

test("acceptAllSuggested：一次接受全部未決項、reason 必填原話；沒有未決項時拒絕；無建議預設的項目另行告知", async () => {
  const { id } = await atSaConfirm(NOTES_H3);
  const bad = await env.call({ action: "record_decision", workItemId: id, acceptAllSuggested: true, by: "human", reason: "1" });
  assert.equal(bad.isError, true);
  const r = await env.call({ action: "record_decision", workItemId: id, acceptAllSuggested: true, by: "human", reason: "全部照建議" });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.recorded.length, 2);
  assert.equal(r.json.recorded[0].answer, "不含標題列");
  assert.equal(r.json.withoutExplicitSuggestion, undefined);
  assert.equal((await agentConfirm(id)).isError, false);
  const again = await env.call({ action: "record_decision", workItemId: id, acceptAllSuggested: true, by: "human", reason: "全部照建議" });
  assert.equal(again.isError, true);
  const { id: id3 } = await atSaConfirm("## 待確認問題\n1. 金額型態？目前解讀為數字\n");
  const r3 = await env.call({ action: "record_decision", workItemId: id3, acceptAllSuggested: true, by: "human", reason: "全部照建議" });
  assert.deepEqual(r3.json.withoutExplicitSuggestion, ["Q1"]);
});

test("相容：沒有待確認項（- 無）的舊式工作項目照舊由 AI 核准；不在待確認清單的決定也可記錄", async () => {
  const { id } = await atSaConfirm();
  const free = await rec(id, { question: "sd-confirm 的 A2、B2", answer: "採 A2 與 B2", reason: "使用者說就選 A2 跟 B2" });
  assert.equal(free.isError, false, free.text);
  assert.equal(free.json.recorded[0].ref, undefined);
  assert.equal((await agentConfirm(id)).isError, false);
});

test("審查員說明書：無記錄時原文不變；有記錄時附決定與未決項；說明書寫明已記錄決定不申報", async () => {
  assert.ok(REVIEWER_PROMPT.length <= 1600);
  assert.match(REVIEWER_PROMPT, /已記錄決定涵蓋的事項/);
  const { id } = await atSaConfirm();
  assert.equal((await env.call({ action: "role_prompt", workItemId: id, roleId: "reviewer" })).json.prompt, REVIEWER_PROMPT);
  const { id: id2 } = await atSaConfirm(NOTES_H3);
  await rec(id2);
  const p = (await env.call({ action: "role_prompt", workItemId: id2, roleId: "reviewer" })).json.prompt;
  assert.ok(p.startsWith(REVIEWER_PROMPT));
  assert.match(p, /Q1 → 不含標題列（使用者原話：使用者說就照你建議的）/);
  assert.match(p, /尚無決定記錄的待確認問題：Q2/);
});
