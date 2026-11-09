import type { TicketStatus } from "../pipeline-store.js";
import { computeNextAction, type NextAction, type NextActionContext } from "../next-action.js";
import { buildWhenContext } from "../work-item-store.js";
import { resolveWorkflow } from "./resolve.js";
import { computeSpecFirstNext, type PendingGate, type SpecFirstNext } from "./spec-first-engine.js";
import { SPEC_FIRST_WORKFLOW_ID, buildSpecFirstWorkflow } from "./builtin/spec-first.js";

/** 目前唯一有 next-action 實作的 Asana 流程。 */
export const SUPPORTED_NEXT_ACTION_WORKFLOW = "asana-ticket";

function gateWaitText(g: PendingGate): string {
  if (g.locked) return `「${g.gateId}」（最終驗收，只能由使用者本人確認）`;
  if (g.mode === "manual") return `「${g.gateId}」（等使用者確認${g.hardStop ? "，連續判定不通過達上限，必須由使用者處理" : ""}）`;
  return g.type === "confirmation" || g.type === "verdict"
    ? `「${g.gateId}」（需要獨立審查員審查，再由程式裁決）`
    : `「${g.gateId}」（由程式檢查產出是否合格）`;
}

/** 把引擎結果轉成與 computeNextAction 相同結構的建議（work_item 工具由之後的階段新增，suggestedTools 先留空）。 */
export function specFirstNextToAction(next: SpecFirstNext): NextAction {
  if (next.complete) return { summary: "這個工作項目的所有角色與關卡都已完成。", blockedBy: [], suggestedTools: [] };
  const parts: string[] = [];
  if (next.available.length > 0) {
    const who = next.available.map((a) => `${a.roleId}（產出：${a.files.join("、") || "無"}）`).join("；");
    parts.push(`下一步由 ${who} 進行${next.available.length > 1 ? "，這些角色可以同時做" : ""}。`);
  }
  const blockedBy = next.pendingGates.map((g) => `等待關卡${gateWaitText(g)}${g.lastRejection ? `；上次被退回（${g.lastRejection.rootCause ?? g.lastRejection.decision}）` : ""}`);
  if (blockedBy.length > 0) parts.push(`目前要等：${next.pendingGates.map(gateWaitText).join("、")}。`);
  if (parts.length === 0) parts.push("目前沒有可進行的角色，也沒有待處理的關卡，請檢查進度紀錄是否一致。");
  return { summary: parts.join(""), blockedBy, suggestedTools: [] };
}

/** next-action 分流接縫：asana-ticket（或缺省）原樣走 computeNextAction；spec-first 走推進引擎；其他流程回「尚未支援」，不拋例外。 */
export function computeNextActionForWorkflow(
  status: TicketStatus,
  ctx: NextActionContext = {},
  workflowId?: string | null
): NextAction {
  if (workflowId === undefined || workflowId === null || workflowId === SUPPORTED_NEXT_ACTION_WORKFLOW) {
    return computeNextAction(status, ctx);
  }
  if (workflowId === SPEC_FIRST_WORKFLOW_ID) {
    const def = buildSpecFirstWorkflow();
    return specFirstNextToAction(computeSpecFirstNext(status, resolveWorkflow(def, buildWhenContext(status)), def.artifacts));
  }
  return {
    summary: `流程「${workflowId}」的下一步建議尚未支援，請依該流程自己的定義操作，或改用 asana-ticket 流程。`,
    blockedBy: [`此流程尚未支援：next-action 目前只實作 ${SUPPORTED_NEXT_ACTION_WORKFLOW}，無法為「${workflowId}」計算下一步`],
    suggestedTools: [],
  };
}
