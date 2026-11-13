import { updateStatus, type DecisionRecord, type TicketStatus } from "../pipeline-store.js";
import { WorkItemActionError, need, okReply, type ToolReply } from "./common.js";
import { loadEffectiveDef, loadWorkItem } from "./context.js";
import { requireReasonQuote } from "./gate-guard.js";
import { refreshIndexDoc } from "./index-doc.js";
import { readPendingQuestions, type PendingQuestion } from "./sa-notes-questions.js";
import type { WorkItemArgs } from "./schema.js";

/**
 * 使用者決定記錄：使用者對 sa-notes.md 待確認問題（或其他事項）的決定與原話，存在 status.decisions。
 * 只能 by:"human"、reason 必須是使用者原話。sa-confirm 由 AI 核准前，待確認問題都要有決定記錄。
 */

export const SA_CONFIRM_GATE = "sa-confirm";
const MAX_QUESTION_CHARS = 300;
const MAX_TEXT_CHARS = 2000;
const MAX_DECISIONS = 300;
const MAX_LISTED = 10;
const NO_SUGGESTION_ANSWER = "照 SA 的建議（sa-notes.md 該項未標明「建議預設」，以該項內文目前的處理方式為準）";

export const decisionsOf = (s: TicketStatus): DecisionRecord[] => s.decisions ?? [];
const norm = (t: string): string => t.replace(/\s+/g, "").toLowerCase();

/** 這個待確認問題是否已有決定記錄（編號相同或標題相同）。 */
export const isCovered = (q: PendingQuestion, ds: readonly DecisionRecord[]): boolean => ds.some((d) => (d.ref !== undefined && d.ref === q.id) || (d.title !== undefined && norm(d.title) === norm(q.title)));

export const uncovered = (qs: readonly PendingQuestion[], ds: readonly DecisionRecord[]): PendingQuestion[] => qs.filter((q) => !isCovered(q, ds));

/** 依編號（Q3 或 3）或標題（完整或包含）找出對應的待確認問題。 */
export function matchQuestion(qs: readonly PendingQuestion[], text: string): PendingQuestion | undefined {
  const t = norm(text);
  const asId = /^q?(\d+)$/.exec(t);
  if (asId) return qs.find((q) => q.id.toLowerCase() === `q${asId[1]}`);
  return qs.find((q) => norm(q.title) === t) ?? qs.find((q) => t.length >= 4 && (norm(q.title).includes(t) || t.includes(norm(q.title))));
}

const listLine = (q: PendingQuestion): string => `${q.id} ${q.title}${q.suggestion ? `（建議預設：${q.suggestion}）` : ""}`;

/** 條列待確認問題（最多 MAX_LISTED 項）。 */
export function listQuestions(qs: readonly PendingQuestion[]): string {
  const shown = qs.slice(0, MAX_LISTED).map(listLine).join("；");
  return qs.length > MAX_LISTED ? `${shown}；…另 ${qs.length - MAX_LISTED} 項` : shown;
}

/** 新決定取代同一問題（編號或標題相同）的舊決定，其餘保留；n 依序遞增。 */
function upsert(list: readonly DecisionRecord[], d: Omit<DecisionRecord, "n">): DecisionRecord[] {
  const same = (x: DecisionRecord): boolean => (d.ref !== undefined && x.ref === d.ref) || norm(x.question) === norm(d.question);
  const n = list.reduce((m, x) => Math.max(m, x.n), 0) + 1;
  const idx = list.findIndex(same);
  const next = { ...d, n };
  return idx < 0 ? [...list, next] : list.map((x, i) => (i === idx ? next : x));
}

/** sa-confirm 由 AI 核准前呼叫：sa-notes.md 還有沒決定記錄的待確認問題就拒絕。 */
export async function requireQuestionsDecided(dir: string, status: TicketStatus): Promise<void> {
  const open = uncovered(await readPendingQuestions(dir), decisionsOf(status));
  if (open.length === 0) return;
  throw new WorkItemActionError(
    `關卡「${SA_CONFIRM_GATE}」AI 不可核准：sa-notes.md 的待確認問題還有 ${open.length} 項沒有使用者的決定記錄（${listQuestions(open)}）。這些要問使用者本人：逐項取得回答後用 work_item action=record_decision（workItemId、question＝編號或標題、answer＝使用者的決定、reason＝使用者原話、by:"human"）記錄；使用者說全部照建議就用 acceptAllSuggested:true（reason 仍要附使用者原話）。全部有記錄後再核准；發現問題要打回不受此限。`,
    { reason: "pending-decisions", pendingQuestions: open }
  );
}

async function acceptAll(dir: string, status: TicketStatus, quote: string): Promise<{ records: Omit<DecisionRecord, "n">[]; noSuggestion: string[] }> {
  const open = uncovered(await readPendingQuestions(dir), decisionsOf(status));
  if (open.length === 0) throw new WorkItemActionError("sa-notes.md 沒有尚待決定的待確認問題（沒有待確認項，或都已有決定記錄），不需要 acceptAllSuggested。");
  const at = new Date().toISOString();
  const records = open.map((q) => ({ at, question: q.title, ref: q.id, title: q.title, answer: q.suggestion ?? NO_SUGGESTION_ANSWER, quote, source: "accept_all_suggested" as const }));
  return { records, noSuggestion: open.filter((q) => !q.suggestion).map((q) => q.id) };
}

const clip = (s: string, max: number, what: string): string => {
  if (s.length > max) throw new WorkItemActionError(`${what}過長（上限 ${max} 字元）。`);
  return s;
};

export async function handleRecordDecision(a: WorkItemArgs): Promise<ToolReply> {
  const { workItemId } = need("record_decision", a, ["workItemId"]);
  if (a.by !== "human") throw new WorkItemActionError('record_decision 只能記錄使用者本人的決定：必須帶 by:"human"，AI 不可自行代答。');
  requireReasonQuote("記錄使用者決定", a.reason, "使用者做這個決定的原話");
  const quote = clip((a.reason ?? "").trim(), MAX_TEXT_CHARS, "reason");
  const all = a.acceptAllSuggested === true;
  if (!all) need("record_decision", a, ["question", "answer"]);
  const ctx = await loadWorkItem(workItemId);
  let records: Omit<DecisionRecord, "n">[];
  let noSuggestion: string[] = [];
  if (all) {
    ({ records, noSuggestion } = await acceptAll(ctx.dir, ctx.status, quote));
  } else {
    const question = clip((a.question ?? "").trim(), MAX_QUESTION_CHARS, "question");
    const answer = clip((a.answer ?? "").trim(), MAX_TEXT_CHARS, "answer");
    if (question === "" || answer === "") throw new WorkItemActionError("question 與 answer 都不可空白。");
    const hit = matchQuestion(await readPendingQuestions(ctx.dir), question);
    records = [{ at: new Date().toISOString(), question, answer, quote, source: "single" as const, ...(hit ? { ref: hit.id, title: hit.title } : {}) }];
  }
  const updated = await updateStatus(ctx.id, (s) => {
    const merged = records.reduce<DecisionRecord[]>((acc, r) => upsert(acc, r), [...decisionsOf(s)]);
    if (merged.length > MAX_DECISIONS) throw new WorkItemActionError(`決定記錄已超過 ${MAX_DECISIONS} 筆上限。`);
    return { ...s, decisions: merged };
  });
  const { def, overrideApplied } = await loadEffectiveDef(updated);
  const stillOpen = uncovered(await readPendingQuestions(ctx.dir), decisionsOf(updated));
  const indexWarning = await refreshIndexDoc({ dir: ctx.dir, status: updated }, { def, overrideApplied });
  return okReply({
    workItemId: ctx.id,
    recorded: records.map((r) => ({ question: r.question, answer: r.answer, ...(r.ref ? { ref: r.ref } : {}) })),
    totalDecisions: decisionsOf(updated).length,
    pendingQuestions: stillOpen,
    ...(noSuggestion.length > 0 ? { withoutExplicitSuggestion: noSuggestion, note: `${noSuggestion.join("、")} 在 sa-notes.md 沒標明「建議預設」，已記為「照 SA 目前的處理方式」；若使用者有別的決定請用 record_decision 逐項覆寫。` } : {}),
    ...(indexWarning ? { indexWarning } : {}),
  });
}

/** 給 AI 審查員看的文字：已記錄決定＋尚無決定的待確認問題；兩者皆空回 undefined。 */
export function decisionsPromptSection(ds: readonly DecisionRecord[], open: readonly PendingQuestion[]): string | undefined {
  if (ds.length === 0 && open.length === 0) return undefined;
  const dl = ds.map((d) => `- ${d.question} → ${d.answer}（使用者原話：${d.quote}）`);
  const parts = ["## 本工作項目的使用者決定記錄（資料）", ...(dl.length > 0 ? dl : ["- （尚無）"])];
  if (open.length > 0) parts.push("", `尚無決定記錄的待確認問題：${listQuestions(open)}`);
  return parts.join("\n");
}
