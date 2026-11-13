import { updateStatus, type TicketStatus } from "../pipeline-store.js";
import type { GateDecisionValue } from "../workflow/work-item-progress.js";
import { resolveConfirmMode } from "../workflow/resolve.js";
import { TECH_CONFIRM_GATE } from "../work-item-sources.js";
import { applyGateDecision, isProgramCheckGate, isTechConfirmAuto } from "../workflow/spec-first-engine.js";
import type { WorkflowDefinition } from "../workflow/schema.js";
import { WorkItemActionError, errorMessage, need, okReply, type ToolReply } from "./common.js";
import { loadEffectiveDef, loadWorkItem } from "./context.js";
import { FINAL_ACCEPTANCE_GATE, writeFinalSummary } from "./final-summary-io.js";
import { authorizeDecision, requireAgentRejectReason, requireHumanQuote, requireReviewReasons, withReviewNote } from "./gate-guard.js";
import { MOCKUP_CONFIRM_GATE, moveLosingCandidates, validateSelected, type MovedCandidate } from "./mockup-select.js";
import { recordEscalation, withoutEscalation } from "./review-escalation.js";
import { refreshIndexDoc } from "./index-doc.js";
import type { WorkItemArgs } from "./schema.js";
import { nextBlock, viewFor } from "./view.js";

export const doneRoleIds = (s: TicketStatus): string[] => Object.entries(s.work_item_progress?.roles ?? {}).filter(([, r]) => r.done).map(([id]) => id);

/** confirm 的 confirmed／rejected 對應到關卡型別接受的決定值：content／evidence 關卡用 passed／failed。 */
function mapDecision(gateType: string, decision: "confirmed" | "rejected"): GateDecisionValue {
  if (gateType === "confirmation") return decision;
  return decision === "confirmed" ? "passed" : "failed";
}

/** 最終驗收確認後寫整理報告；寫檔失敗不影響確認，改附 warning。 */
async function trySummary(dir: string, status: TicketStatus, def: WorkflowDefinition, id: string): Promise<Record<string, unknown>> {
  try {
    return await writeFinalSummary(dir, status, def, id);
  } catch (e) {
    return { warning: `最終驗收已確認，但整理報告 final-summary.md 寫入失敗：${errorMessage(e)}` };
  }
}

/** mockup-confirm 核准記錄選定風格；打回則清掉（尚未選定）。其他關卡原樣回傳。 */
function withStyleSelection(s: TicketStatus, gateId: string, decision: "confirmed" | "rejected", selected: string | undefined): TicketStatus {
  if (gateId !== MOCKUP_CONFIRM_GATE) return s;
  if (selected) return { ...s, selected_style: selected };
  if (decision === "rejected" && s.selected_style !== undefined) {
    const { selected_style: _drop, ...rest } = s;
    void _drop;
    return rest;
  }
  return s;
}

/** 確認成功後把落選候選移到 _candidates/；移動失敗不影響確認，改附 warnings。 */
async function applySelection(dir: string, selected: string): Promise<{ selectedStyle: string; movedCandidates: MovedCandidate[]; warnings?: string[] }> {
  try {
    const r = await moveLosingCandidates(dir, selected);
    return { selectedStyle: selected, movedCandidates: r.moved, ...(r.warnings.length > 0 ? { warnings: r.warnings } : {}) };
  } catch (e) {
    return { selectedStyle: selected, movedCandidates: [], warnings: [`已記錄選定風格 ${selected}，但移動落選候選檔失敗：${errorMessage(e)}；請手動把其餘 style-*.html 移到 sa-mockup/_candidates/`] };
  }
}

export async function handleConfirm(a: WorkItemArgs): Promise<ToolReply> {
  const { workItemId, gateId, decision, by } = need("confirm", a, ["workItemId", "gateId", "decision", "by"]);
  const ctx = await loadWorkItem(workItemId);
  const { def, overrideApplied } = await loadEffectiveDef(ctx.status);
  const gate = def.gates.find((g) => g.id === gateId);
  if (!gate) throw new WorkItemActionError(`找不到關卡：${gateId}`);
  if (gate.type === "verdict") throw new WorkItemActionError(`關卡「${gateId}」是判定關卡，請改用 verdict 動作（result=pass／fail）。`);
  if (isTechConfirmAuto(gateId, ctx.status)) {
    throw new WorkItemActionError(`關卡「${gateId}」的技術來源是沿用現有，技術選型師交件後由程式自動記錄，不需確認。`);
  }
  if (gateId === TECH_CONFIRM_GATE && by === "agent" && decision === "confirmed") {
    throw new WorkItemActionError(`關卡「${gateId}」的技術來源不是沿用現有、或選型文件含候選方案，必須由使用者本人確認技術棧（by="human"，reason 附使用者原話），AI 不可代確認（技術來源沿用現有但 tech-stack.md 含「候選方案」時也一樣）。`);
  }
  if (isProgramCheckGate(gate.type, resolveConfirmMode(def, gateId).mode)) {
    throw new WorkItemActionError(`關卡「${gateId}」由程式檢查，不需確認：所屬角色 done 且交件檢查通過時會自動通過。若專案要人工把關，請在專案 flow.json 把它的 confirmMode 設成 manual。`);
  }
  requireHumanQuote(def, gateId, by, a.reason, decision);
  requireAgentRejectReason(gateId, by, decision, a.reason);
  const alsoRewind = [...new Set((a.alsoRewind ?? []).map((x) => x.trim()).filter((x) => x !== ""))];
  if (alsoRewind.length > 0 && decision !== "rejected") throw new WorkItemActionError("alsoRewind 只能搭配打回（decision=\"rejected\"）使用。");
  if (decision === "confirmed") requireReviewReasons(by, a.review);
  const selected = await validateSelected(ctx.dir, { gateId, decision, styleSource: ctx.status.style_source, selected: a.selected });
  const value = mapDecision(gate.type, decision);
  const reason = withReviewNote(a.reason, by, a.review);
  let rewound: string[] = [];
  let updated: TicketStatus;
  try {
    updated = await updateStatus(ctx.id, async (s) => {
      await authorizeDecision({ dir: ctx.dir, status: s }, def, gateId, by, a.review, decision === "rejected");
      const r = applyGateDecision(s, gateId, { decision: value, by, ...(reason !== undefined ? { reason } : {}), ...(alsoRewind.length > 0 ? { alsoRewind } : {}) }, { def });
      if (!r.ok) throw new WorkItemActionError(r.error);
      const after = new Set(doneRoleIds(r.status));
      rewound = doneRoleIds(s).filter((id) => !after.has(id));
      return withStyleSelection(withoutEscalation(r.status, gateId), gateId, decision, selected);
    });
  } catch (e) {
    if (by === "agent" && decision === "confirmed" && e instanceof WorkItemActionError) await recordEscalation(ctx.id, gateId, a.review);
    throw e;
  }
  const style = selected ? await applySelection(ctx.dir, selected) : {};
  const summary = gateId === FINAL_ACCEPTANCE_GATE && value === "confirmed" ? await trySummary(ctx.dir, updated, def, ctx.id) : {};
  const indexWarning = await refreshIndexDoc({ dir: ctx.dir, status: updated }, { def, overrideApplied });
  return okReply({ workItemId: ctx.id, gateId, decision: value, by, rewoundRoles: rewound, ...(alsoRewind.length > 0 ? { alsoRewind } : {}), ...style, ...summary, ...(indexWarning ? { indexWarning } : {}), ...nextBlock(viewFor(updated, def, overrideApplied)) });
}
