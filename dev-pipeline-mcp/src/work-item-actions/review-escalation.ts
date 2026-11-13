import { updateStatus, type TicketStatus } from "../pipeline-store.js";
import { declaredReasons, reviewReasonText } from "./gate-guard.js";

/**
 * AI 審查員核准時申報了 breaksExisting／reviewerUncertain／scopeSplit 而被升級給使用者：核准被拒絕、關卡沒有決定紀錄，
 * 所以把申報與理由記在 status.review_escalations[gateId]，讓 get 與 00-索引.md 能讓使用者看出為何被升級。關卡有了決定就清掉。
 */

export interface ReviewEscalation {
  at: string;
  declared: string[];
  reasons: string;
}

export type EscalationMap = Record<string, ReviewEscalation>;

export const escalationsOf = (s: TicketStatus): EscalationMap => s.review_escalations ?? {};

/** 回傳清掉指定關卡升級紀錄後的 status（沒有紀錄時原樣回傳）。 */
export function withoutEscalation(s: TicketStatus, gateId: string): TicketStatus {
  if (!(gateId in escalationsOf(s))) return s;
  const { [gateId]: _drop, ...rest } = escalationsOf(s);
  void _drop;
  return { ...s, review_escalations: rest };
}

/** 核准被拒絕且審查有申報為 true 的項目時，記下升級原因；失敗不影響原本的錯誤回覆。 */
export async function recordEscalation(workItemId: string, gateId: string, review: unknown): Promise<void> {
  const declared = declaredReasons(review).map((d) => d.key);
  if (declared.length === 0) return;
  const entry: ReviewEscalation = { at: new Date().toISOString(), declared, reasons: reviewReasonText(review) ?? "" };
  try {
    await updateStatus(workItemId, (s) => ({ ...s, review_escalations: { ...escalationsOf(s), [gateId]: entry } }));
  } catch {
    // 記錄失敗不蓋掉原本的拒絕原因
  }
}
