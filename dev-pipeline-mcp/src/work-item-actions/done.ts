import path from "node:path";
import { updateStatus, type TicketStatus } from "../pipeline-store.js";
import { buildWhenContext } from "../work-item-store.js";
import { resolveWorkflow } from "../workflow/resolve.js";
import { TECH_CONFIRM_GATE } from "../work-item-sources.js";
import { applyGateDecision, applyRoleDone, isProgramCheckGate, isTechConfirmAuto } from "../workflow/spec-first-engine.js";
import type { WorkflowDefinition } from "../workflow/schema.js";
import { WorkItemActionError, need, okReply, type ToolReply } from "./common.js";
import { loadEffectiveDef, loadWorkItem } from "./context.js";
import { convertSaToDocx } from "../export/sa-docx.js";
import { listLogicalRelations } from "../workflow/table-schema-check.js";
import { checkDeliverables } from "./deliverables.js";
import { checkDuplicatesOnDone } from "./dup-check.js";
import { refreshIndexDoc } from "./index-doc.js";
import { sdImplWarnings } from "./sd-impl-warnings.js";
import { hasTechCandidates } from "../workflow/tech-stack-check.js";
import { readOptionalText } from "./sd-impl-warnings.js";
import { stackdumpWarning } from "./stackdump.js";
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

/** 讀 tech-stack.md 判斷是否含候選方案；讀不到回 undefined（不改旗標）。 */
async function detectTechCandidates(dir: string, def: WorkflowDefinition): Promise<boolean | undefined> {
  const file = def.artifacts.find((a) => a.id === "tech-stack")?.file;
  const text = file ? await readOptionalText(path.join(dir, file)) : undefined;
  return text === undefined ? undefined : hasTechCandidates(text);
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
  const basic = await checkDeliverables(ctx.dir, roleId, def, { techSource: ctx.status.tech_source, projectDir: ctx.status.project_dir, baseline: ctx.status.baseline });
  const problems = basic.length > 0 ? basic : await checkDuplicatesOnDone(ctx.dir, ctx.status.project_dir, roleId, def);
  if (problems.length > 0) throw new WorkItemActionError(`交件檢查未通過，角色「${roleId}」未標記完成：${problems.join("；")}`, { problems });
  const warnings: string[] = [];
  if (roleId === "sa-analyst") {
    const docx = await convertSaToDocx(ctx.dir);
    if (docx.status === "failed") throw new WorkItemActionError(`交件檢查未通過，角色「${roleId}」未標記完成：${docx.message}`, { problems: [docx.message] });
    if (docx.status === "unavailable") warnings.push(`未產生 01-sa.docx：${docx.hint}`);
  }
  if (roleId === "db-designer") {
    const logical = listLogicalRelations(ctx.dir);
    if (logical.length > 0) warnings.push(`邏輯關聯清單（程式無法驗證真偽，規格驗證師須對照程式碼確認）：${logical.join("；")}`);
  }
  const techCandidates = roleId === "tech-selector" ? await detectTechCandidates(ctx.dir, def) : undefined;
  const updated = await updateStatus(ctx.id, (s) => {
    assertAvailable(s, def, overrideApplied, roleId);
    const r = applyRoleDone(techCandidates === undefined ? s : { ...s, tech_has_candidates: techCandidates }, roleId, { def });
    if (!r.ok) throw new WorkItemActionError(r.error);
    return passProgramGates(r.status, def, roleId);
  });
  warnings.push(...(await sdImplWarnings(ctx.dir, roleId, def)));
  const techNote = techCandidates && updated.tech_source === "existing" ? { techConfirmNote: "tech-stack.md 含「候選方案」（需要使用者做技術決定），即使技術來源為沿用現有，tech-confirm 也必須由使用者本人確認。" } : {};
  const dump = await stackdumpWarning(ctx.dir, ctx.status.project_dir);
  if (dump) warnings.push(dump);
  const indexWarning = await refreshIndexDoc({ dir: ctx.dir, status: updated }, { def, overrideApplied });
  if (indexWarning) warnings.push(indexWarning);
  return okReply({ workItemId: ctx.id, roleId, done: true, ...techNote, ...(warnings.length > 0 ? { warnings } : {}), ...nextBlock(viewFor(updated, def, overrideApplied)) });
}
