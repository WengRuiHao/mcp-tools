import { TicketDirNotFoundError, readStatus, resolveTicketDir, type TicketStatus } from "../pipeline-store.js";
import { loadProjectFlowOverride } from "../workflow/load.js";
import { mergeProjectOverride } from "../workflow/resolve.js";
import type { WorkflowDefinition } from "../workflow/schema.js";
import { getBuiltinWorkflow, type WorkflowSnapshot } from "../workflow/stage-order.js";
import { WorkItemActionError, errorMessage } from "./common.js";

export const SPEC_FIRST_ID = "spec-first";

export interface WorkItemContext {
  id: string;
  dir: string;
  status: TicketStatus;
}

/** 讀取工作項目；找不到或不是規格先行工作項目（例如 Asana 票單）一律拒絕並轉介。 */
export async function loadWorkItem(rawId: string): Promise<WorkItemContext> {
  const id = rawId.trim();
  let status: TicketStatus;
  try {
    status = await readStatus(id);
  } catch (e) {
    if (e instanceof TicketDirNotFoundError) throw new WorkItemActionError(`找不到工作項目「${id}」，請確認編號（create 會回傳 workItemId）。`);
    throw new WorkItemActionError(`讀取工作項目「${id}」的狀態失敗：${errorMessage(e)}`);
  }
  if (!status.workflow_snapshot || status.workflow_id !== SPEC_FIRST_ID) {
    throw new WorkItemActionError(`「${id}」不是規格先行工作項目（可能是 Asana 票單），work_item 不處理；Asana 票單請改用既有 Asana 工具（get_ticket_status、advance_ticket_stage、record_confirmation 等）。`);
  }
  return { id, dir: await resolveTicketDir(id), status };
}

/**
 * 舊快照相容：建立時快照沒有的角色（例如 tech-selector 加入之前建立的工作項目）視為不存在——
 * 從定義移除該角色、依賴它的 dependsOn、只掛在它後面的關卡，以及只被它產出的產出物。沒有快照時原樣回傳。
 */
export function pruneToSnapshot(def: WorkflowDefinition, snapshot: Pick<WorkflowSnapshot, "roles"> | undefined): WorkflowDefinition {
  if (!snapshot || !Array.isArray(snapshot.roles)) return def;
  const known = new Set(snapshot.roles.map((r) => r.id));
  const removed = new Set(def.roles.filter((r) => !known.has(r.id)).map((r) => r.id));
  if (removed.size === 0) return def;
  const afterIds = (a: string | string[]): string[] => (Array.isArray(a) ? a : [a]);
  const roles = def.roles.filter((r) => !removed.has(r.id)).map((r) => ({ ...r, dependsOn: r.dependsOn.filter((d) => !removed.has(d)), ...(r.parallelWith ? { parallelWith: r.parallelWith.filter((d) => !removed.has(d)) } : {}) }));
  const gates = def.gates.filter((g) => afterIds(g.after).some((a) => !removed.has(a))).map((g) => ({ ...g, after: Array.isArray(g.after) ? g.after.filter((a) => !removed.has(a)) : g.after }));
  const usedOutputs = new Set(roles.flatMap((r) => r.outputs));
  const removedOutputs = new Set(def.roles.filter((r) => removed.has(r.id)).flatMap((r) => r.outputs));
  const artifacts = def.artifacts.filter((a) => usedOutputs.has(a.id) || !removedOutputs.has(a.id));
  return { ...def, roles, gates, artifacts };
}

export function builtinDefinition(): WorkflowDefinition {
  const def = getBuiltinWorkflow(SPEC_FIRST_ID);
  if (!def) throw new WorkItemActionError(`找不到內建 workflow「${SPEC_FIRST_ID}」`);
  return def;
}

/** 內建 spec-first 定義套用專案 flow.json 覆寫（沒有檔案就是內建）；flow.json 壞掉或越權時丟錯，不悄悄退回預設。 */
export async function loadEffectiveDef(status: Pick<TicketStatus, "project_dir" | "workflow_snapshot">): Promise<{ def: WorkflowDefinition; overrideApplied: boolean }> {
  const base = pruneToSnapshot(builtinDefinition(), status.workflow_snapshot);
  if (!status.project_dir) return { def: base, overrideApplied: false };
  let override;
  try {
    override = await loadProjectFlowOverride(status.project_dir);
  } catch (e) {
    throw new WorkItemActionError(`專案 flow.json 無法使用：${errorMessage(e)}`);
  }
  if (!override) return { def: base, overrideApplied: false };
  const merged = mergeProjectOverride(base, override);
  if (!merged.ok) throw new WorkItemActionError(`專案 flow.json 覆寫被拒絕：${merged.errors.join("；")}`);
  return { def: merged.workflow, overrideApplied: true };
}
