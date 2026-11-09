import type { TicketStatus } from "../pipeline-store.js";
import { textResult } from "../shared.js";

/** 舊 Asana 工具所屬的流程 id；workflow_id 缺省視為此流程。 */
const ASANA_WORKFLOW_ID = "asana-ticket";

/**
 * 非 Asana 工作項目的守門：舊 Asana 工具只處理 Asana 票單，
 * status.workflow_id 存在且不是 asana-ticket 時回標準錯誤結果，呼叫端須在任何寫入之前呼叫並直接 return；否則回 null。
 */
export function rejectIfNonAsana(status: Pick<TicketStatus, "workflow_id">, toolName: string) {
  const workflowId = status.workflow_id;
  if (!workflowId || workflowId === ASANA_WORKFLOW_ID) return null;
  return textResult(
    {
      success: false,
      message: `這是非 Asana 的工作項目（流程「${workflowId}」），${toolName} 只處理 Asana 票單，請改用 work_item 工具。`,
    },
    true
  );
}
