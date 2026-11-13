import { stat } from "node:fs/promises";
import path from "node:path";
import type { TicketStatus } from "../pipeline-store.js";

const IMPACT_FILE = "impact.md";

/** 使用者最後一次做決定或修改需求的時間（ms）；都沒有回 undefined。 */
export function latestUserChangeAt(status: TicketStatus): number | undefined {
  const times = [...(status.decisions ?? []).map((d) => d.at), ...(status.requirement_history ?? []).map((r) => r.at)].map((t) => Date.parse(t)).filter((t) => Number.isFinite(t));
  return times.length > 0 ? Math.max(...times) : undefined;
}

/**
 * 使用者中途改決定或改需求後，impact.md 若比最後一次變更還舊，上游文件可能沒跟著更新：回提示字串，否則 undefined。
 * 只看檔案修改時間；impact.md 不存在（全新系統）不提示。
 */
export async function staleUpstreamNote(dir: string, status: TicketStatus): Promise<string | undefined> {
  const changedAt = latestUserChangeAt(status);
  if (changedAt === undefined) return undefined;
  const st = await stat(path.join(dir, IMPACT_FILE)).catch(() => null);
  if (!st || st.mtimeMs >= changedAt) return undefined;
  return `使用者在 ${IMPACT_FILE} 最後修改之後又有決定記錄或修改過需求，SD 與後續文件可能已依新決定重做，${IMPACT_FILE} 可能是過期的：交件前請核對並用 write 更新 ${IMPACT_FILE}，使它與 SD 一致。`;
}
