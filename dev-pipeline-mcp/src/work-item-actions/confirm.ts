import { updateStatus, type TicketStatus } from "../pipeline-store.js";
import type { GateDecisionValue } from "../workflow/work-item-progress.js";
import { resolveConfirmMode } from "../workflow/resolve.js";
import { applyGateDecision, isProgramCheckGate } from "../workflow/spec-first-engine.js";
import { WorkItemActionError, need, okReply, type ToolReply } from "./common.js";
import { loadEffectiveDef, loadWorkItem } from "./context.js";
import { authorizeDecision, requireHumanQuote, withReviewNote } from "./gate-guard.js";
import type { WorkItemArgs } from "./schema.js";
import { nextBlock, viewFor } from "./view.js";

export const doneRoleIds = (s: TicketStatus): string[] => Object.entries(s.work_item_progress?.roles ?? {}).filter(([, r]) => r.done).map(([id]) => id);

/** confirm 的 confirmed／rejected 對應到關卡型別接受的決定值：content／evidence 關卡用 passed／failed。 */
function mapDecision(gateType: string, decision: "confirmed" | "rejected"): GateDecisionValue {
  if (gateType === "confirmation") return decision;
  return decision === "confirmed" ? "passed" : "failed";
}

export async function handleConfirm(a: WorkItemArgs): Promise<ToolReply> {
  const { workItemId, gateId, decision, by } = need("confirm", a, ["workItemId", "gateId", "decision", "by"]);
  const ctx = await loadWorkItem(workItemId);
  const { def, overrideApplied } = await loadEffectiveDef(ctx.status);
  const gate = def.gates.find((g) => g.id === gateId);
  if (!gate) throw new WorkItemActionError(`找不到關卡：${gateId}`);
  if (gate.type === "verdict") throw new WorkItemActionError(`關卡「${gateId}」是判定關卡，請改用 verdict 動作（result=pass／fail）。`);
  if (isProgramCheckGate(gate.type, resolveConfirmMode(def, gateId).mode)) {
    throw new WorkItemActionError(`關卡「${gateId}」由程式檢查，不需確認：所屬角色 done 且交件檢查通過時會自動通過。若專案要人工把關，請在專案 flow.json 把它的 confirmMode 設成 manual。`);
  }
  requireHumanQuote(def, gateId, by, a.reason);
  const value = mapDecision(gate.type, decision);
  const reason = withReviewNote(a.reason, by, a.review);
  let rewound: string[] = [];
  const updated = await updateStatus(ctx.id, async (s) => {
    await authorizeDecision({ dir: ctx.dir, status: s }, def, gateId, by, a.review);
    const r = applyGateDecision(s, gateId, { decision: value, by, ...(reason !== undefined ? { reason } : {}) }, { def });
    if (!r.ok) throw new WorkItemActionError(r.error);
    const after = new Set(doneRoleIds(r.status));
    rewound = doneRoleIds(s).filter((id) => !after.has(id));
    return r.status;
  });
  return okReply({ workItemId: ctx.id, gateId, decision: value, by, rewoundRoles: rewound, ...nextBlock(viewFor(updated, def, overrideApplied)) });
}
