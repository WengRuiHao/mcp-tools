import type { TicketStatus } from "../pipeline-store.js";
import { computeNextAction, type NextAction, type NextActionContext } from "../next-action.js";

/** 目前唯一有 next-action 實作的流程。 */
export const SUPPORTED_NEXT_ACTION_WORKFLOW = "asana-ticket";

/** next-action 分流接縫：asana-ticket（或缺省）原樣走 computeNextAction；其他流程回「尚未支援」，不拋例外。 */
export function computeNextActionForWorkflow(
  status: TicketStatus,
  ctx: NextActionContext = {},
  workflowId?: string | null
): NextAction {
  if (workflowId === undefined || workflowId === null || workflowId === SUPPORTED_NEXT_ACTION_WORKFLOW) {
    return computeNextAction(status, ctx);
  }
  return {
    summary: `流程「${workflowId}」的下一步建議尚未支援，請依該流程自己的定義操作，或改用 asana-ticket 流程。`,
    blockedBy: [`此流程尚未支援：next-action 目前只實作 ${SUPPORTED_NEXT_ACTION_WORKFLOW}，無法為「${workflowId}」計算下一步`],
    suggestedTools: [],
  };
}
