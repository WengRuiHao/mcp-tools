import { z } from "zod";
import { computeSyncFlags, detectExternalChanges, needsHumanReview, type TicketStatus } from "./pipeline-store.js";
import { computeNextAction } from "./next-action.js";
import { textResult } from "./shared.js";

/** 狀態推進／記錄類工具共用的選填參數：帶 true 才回傳完整 status.json（含 history、summaries、sync 雜湊）。 */
export const verboseParam = z
  .boolean()
  .nullable()
  .optional()
  .describe("true=回傳完整票單狀態（舊格式）；預設只回精簡狀態＋nextAction，省上下文");

/** 預設回傳：只放呼叫端決策需要的欄位，完整狀態改由 get_ticket_status 或 verbose 取得。 */
export async function buildCompactStatus(taskGid: string, status: TicketStatus): Promise<Record<string, unknown>> {
  const externalChanges = await detectExternalChanges(taskGid, status);
  const syncFlags = computeSyncFlags(status);
  return {
    taskGid,
    stage: status.stage,
    verdict: status.verdict,
    needs_human_review: needsHumanReview(status),
    consecutive_fail_count: status.consecutive_fail_count,
    ...(status.verifier_root_cause ? { verifier_root_cause: status.verifier_root_cause } : {}),
    ...(status.confirmation ? { confirmation: { confirmed: status.confirmation.confirmed } } : {}),
    ...(status.spec_confirmation ? { spec_confirmation: { confirmed: status.spec_confirmation.confirmed } } : {}),
    nextAction: computeNextAction(status, { syncFlags, externalChanges }),
  };
}

/** verbose 時維持各工具原本的完整格式（`extra` 為該工具原本在 status 之外附帶的欄位）。 */
export async function statusResponse(
  taskGid: string,
  status: TicketStatus,
  verbose: boolean | null | undefined,
  extra: Record<string, unknown> = {}
) {
  if (verbose) return textResult({ success: true, status, ...extra });
  return textResult({ success: true, ...(await buildCompactStatus(taskGid, status)) });
}
