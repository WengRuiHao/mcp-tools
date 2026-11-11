import { updateStatus, type TicketStatus } from "../pipeline-store.js";
import { buildWhenContext } from "../work-item-store.js";
import { resolveWorkflow } from "../workflow/resolve.js";
import { TECH_CONFIRM_GATE } from "../work-item-sources.js";
import { applyGateDecision, applyRoleDone, isProgramCheckGate, isTechConfirmAuto } from "../workflow/spec-first-engine.js";
import type { WorkflowDefinition } from "../workflow/schema.js";
import { WorkItemActionError, need, okReply, type ToolReply } from "./common.js";
import { loadEffectiveDef, loadWorkItem } from "./context.js";
import { checkDeliverables } from "./deliverables.js";
import { checkDuplicatesOnDone } from "./dup-check.js";
import type { WorkItemArgs } from "./schema.js";
import { nextBlock, viewFor } from "./view.js";

/** 程式檢查關卡通過時寫進紀錄的檢查名稱（對應 deliverables.ts 的檢查）。 */
const CHECK_NAMES: Readonly<Record<string, string>> = {
  "sa-content-check": "checkSaStandard、checkSaImages、checkSaNoCode",
  "impact-content": "checkImpactReuseList",
  "implementation-content": "checkReuseRecord",
  "test-evidence": "checkTestEvidence",
};
const TECH_AUTO_REASON = "技術來源為沿用現有，只記錄不需確認";

/** 角色 done（交件檢查已全部通過）後，把掛在它後面、由程式檢查的 content／evidence 關卡記為 passed（by:"agent"）。尚未到達的多角色關卡留待最後一個角色。 */
function passProgramGates(status: TicketStatus, def: WorkflowDefinition, roleId: string): TicketStatus {
  const gates = resolveWorkflow(def, buildWhenContext(status)).gates.filter((g) => (Array.isArray(g.after) ? g.after : [g.after]).includes(roleId) && (g.id === TECH_CONFIRM_GATE ? isTechConfirmAuto(g.id, status) : isProgramCheckGate(g.type, g.effectiveConfirm.mode)));
  return gates.reduce((s, g) => {
    const input = g.id === TECH_CONFIRM_GATE
      ? { decision: "confirmed" as const, by: "agent" as const, reason: TECH_AUTO_REASON }
      : { decision: "passed" as const, by: "agent" as const, reason: `程式檢查（${CHECK_NAMES[g.id] ?? "交件檢查"}）通過` };
    const r = applyGateDecision(s, g.id, input, { def });
    return r.ok ? r.status : s;
  }, status);
}

function assertAvailable(status: TicketStatus, def: WorkflowDefinition, overrideApplied: boolean, roleId: string): void {
  if (!def.roles.some((r) => r.id === roleId)) throw new WorkItemActionError(`找不到角色：${roleId}`);
  const v = viewFor(status, def, overrideApplied);
  if (v.next.doneRoles.includes(roleId)) throw new WorkItemActionError(`角色「${roleId}」已經完成，不需重複交件。`);
  if (!v.next.available.some((a) => a.roleId === roleId)) {
    const now = v.next.available.map((a) => a.roleId).join("、") || "（無）";
    throw new WorkItemActionError(`角色「${roleId}」目前還不能交件：尚未輪到它、在目前範圍下被略過，或前一道關卡還沒通過。目前可進行的角色：${now}。`, { summary: v.summary });
  }
}

export async function handleDone(a: WorkItemArgs): Promise<ToolReply> {
  const { workItemId, roleId } = need("done", a, ["workItemId", "roleId"]);
  const ctx = await loadWorkItem(workItemId);
  const { def, overrideApplied } = await loadEffectiveDef(ctx.status);
  assertAvailable(ctx.status, def, overrideApplied, roleId);
  const basic = await checkDeliverables(ctx.dir, roleId, def, { techSource: ctx.status.tech_source });
  const problems = basic.length > 0 ? basic : await checkDuplicatesOnDone(ctx.dir, ctx.status.project_dir, roleId, def);
  if (problems.length > 0) throw new WorkItemActionError(`交件檢查未通過，角色「${roleId}」未標記完成：${problems.join("；")}`, { problems });
  const updated = await updateStatus(ctx.id, (s) => {
    assertAvailable(s, def, overrideApplied, roleId);
    const r = applyRoleDone(s, roleId, { def });
    if (!r.ok) throw new WorkItemActionError(r.error);
    return passProgramGates(r.status, def, roleId);
  });
  return okReply({ workItemId: ctx.id, roleId, done: true, ...nextBlock(viewFor(updated, def, overrideApplied)) });
}
