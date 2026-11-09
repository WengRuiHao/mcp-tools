import type { WorkflowDefinition } from "./schema.js";
import { ASANA_TICKET_WORKFLOW_ID, buildAsanaTicketWorkflow } from "./builtin/asana-ticket.js";
import { SPEC_FIRST_WORKFLOW_ID, buildSpecFirstWorkflow } from "./builtin/spec-first.js";

/**
 * 依 workflow 產生階段順序。
 * 注意：不可 import pipeline-store 的值（pipeline-store 之後會 import 本檔，會造成循環依賴），
 * 因此 asana-ticket 的階段清單在此保留一份，由測試確保與 pipeline-store 的 STAGE_ORDER 一致。
 */
const ASANA_STAGE_ORDER: readonly string[] = ["new", "snapshot", "project_dir_confirmed", "analyzed", "sd_drafted", "implemented", "verified", "tested"];

/** 查內建 workflow 定義（asana-ticket、spec-first）；查不到回 undefined。每次回傳新物件。 */
export function getBuiltinWorkflow(id: string): WorkflowDefinition | undefined {
  if (id === ASANA_TICKET_WORKFLOW_ID) return buildAsanaTicketWorkflow();
  if (id === SPEC_FIRST_WORKFLOW_ID) return buildSpecFirstWorkflow();
  return undefined;
}

/** 建立工作項目時存下的 workflow 快照：階段順序與角色清單（只留決定流程所需的欄位）。 */
export interface WorkflowSnapshot {
  workflow_id: string;
  stage_order: string[];
  roles: Array<{ id: string; dependsOn: string[]; optional: boolean; when?: string }>;
}

/** 由 workflow 定義產生快照（階段順序含所有角色，when 篩選在執行時才做）。 */
export function buildWorkflowSnapshot(def: WorkflowDefinition): WorkflowSnapshot {
  return {
    workflow_id: def.id,
    stage_order: ["new", ...topoRoleIds(def)],
    roles: def.roles.map((r) => ({ id: r.id, dependsOn: [...r.dependsOn], optional: r.optional === true, ...(r.when !== undefined ? { when: r.when } : {}) })),
  };
}

/** 依 dependsOn 做拓撲排序，同層（可平行）的角色依定義順序；optional 角色保留。 */
function topoRoleIds(def: WorkflowDefinition): string[] {
  const ids = def.roles.map((r) => r.id);
  const known = new Set(ids);
  const done = new Set<string>();
  const result: string[] = [];
  while (result.length < ids.length) {
    const next = def.roles.find((r) => !done.has(r.id) && r.dependsOn.every((d) => !known.has(d) || done.has(d)));
    if (!next) {
      const stuck = ids.filter((id) => !done.has(id)).join("、");
      throw new Error(`workflow「${def.id}」的角色依賴有循環，無法決定階段順序：${stuck}`);
    }
    done.add(next.id);
    result.push(next.id);
  }
  return result;
}

/**
 * 取得階段順序。沒有 workflowId 或為 "asana-ticket" → 與 pipeline-store 的 STAGE_ORDER 相同內容的新陣列；
 * 其他 workflow → ["new", ...依拓撲順序的角色 id]；帶 snapshot 時直接用快照的 stage_order。未知 workflow 且沒提供定義時丟錯。
 */
export function getStageOrder(workflowId?: string | null, workflow?: WorkflowDefinition, snapshot?: Pick<WorkflowSnapshot, "stage_order"> | null): string[] {
  // 有快照時以快照為準（自訂／非內建 workflow 也不再因缺定義而丟錯）；沒有快照行為不變。
  if (snapshot && Array.isArray(snapshot.stage_order) && snapshot.stage_order.length > 0) return [...snapshot.stage_order];
  if (!workflowId || workflowId === ASANA_TICKET_WORKFLOW_ID) return [...ASANA_STAGE_ORDER];
  const def = workflow ?? getBuiltinWorkflow(workflowId);
  if (!def) throw new Error(`找不到 workflow「${workflowId}」的定義，無法決定階段順序（內建只有 ${ASANA_TICKET_WORKFLOW_ID}、${SPEC_FIRST_WORKFLOW_ID}）`);
  return ["new", ...topoRoleIds(def)];
}
