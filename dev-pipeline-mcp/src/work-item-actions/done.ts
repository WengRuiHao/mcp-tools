import { updateStatus, type TicketStatus } from "../pipeline-store.js";
import { applyGateDecision, applyRoleDone } from "../workflow/spec-first-engine.js";
import type { WorkflowDefinition } from "../workflow/schema.js";
import { WorkItemActionError, need, okReply, type ToolReply } from "./common.js";
import { loadEffectiveDef, loadWorkItem } from "./context.js";
import { checkDeliverables } from "./deliverables.js";
import type { WorkItemArgs } from "./schema.js";
import { nextBlock, viewFor } from "./view.js";

/** SA 交件通過 checkSaImages 後，程式直接通過的內容關卡。 */
const SA_CONTENT_GATE = "sa-content-check";

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
  const problems = await checkDeliverables(ctx.dir, roleId, def);
  if (problems.length > 0) throw new WorkItemActionError(`交件檢查未通過，角色「${roleId}」未標記完成：${problems.join("；")}`, { problems });
  const updated = await updateStatus(ctx.id, (s) => {
    assertAvailable(s, def, overrideApplied, roleId);
    const r = applyRoleDone(s, roleId, { def });
    if (!r.ok) throw new WorkItemActionError(r.error);
    if (roleId !== "sa-analyst" || !def.gates.some((g) => g.id === SA_CONTENT_GATE)) return r.status;
    const g = applyGateDecision(r.status, SA_CONTENT_GATE, { decision: "passed", by: "agent", reason: "程式檢查（checkSaImages）通過" }, { def });
    return g.ok ? g.status : r.status;
  });
  return okReply({ workItemId: ctx.id, roleId, done: true, ...nextBlock(viewFor(updated, def, overrideApplied)) });
}
