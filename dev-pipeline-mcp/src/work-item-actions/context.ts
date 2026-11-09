import { TicketDirNotFoundError, readStatus, resolveTicketDir, type TicketStatus } from "../pipeline-store.js";
import { loadProjectFlowOverride } from "../workflow/load.js";
import { mergeProjectOverride } from "../workflow/resolve.js";
import type { WorkflowDefinition } from "../workflow/schema.js";
import { getBuiltinWorkflow } from "../workflow/stage-order.js";
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

export function builtinDefinition(): WorkflowDefinition {
  const def = getBuiltinWorkflow(SPEC_FIRST_ID);
  if (!def) throw new WorkItemActionError(`找不到內建 workflow「${SPEC_FIRST_ID}」`);
  return def;
}

/** 內建 spec-first 定義套用專案 flow.json 覆寫（沒有檔案就是內建）；flow.json 壞掉或越權時丟錯，不悄悄退回預設。 */
export async function loadEffectiveDef(status: Pick<TicketStatus, "project_dir">): Promise<{ def: WorkflowDefinition; overrideApplied: boolean }> {
  const base = builtinDefinition();
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
