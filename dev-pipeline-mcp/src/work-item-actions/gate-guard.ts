import { readFile } from "node:fs/promises";
import path from "node:path";
import { scanLineForSecrets } from "../sensitive-patterns.js";
import type { TicketStatus } from "../pipeline-store.js";
import { evaluateAgentConfirmation } from "../workflow/agent-confirm.js";
import { decideGate, type GateSignals } from "../workflow/enforce.js";
import { resolveConfirmMode } from "../workflow/resolve.js";
import type { WorkflowDefinition } from "../workflow/schema.js";
import { SPEC_FIRST_ID } from "./context.js";
import { WorkItemActionError } from "./common.js";

/**
 * 關卡決定的授權把關。by:"human" 直接放行（使用者本人說了算，MCP 無法驗證身分，靠工具說明約束 AI 不得冒用）。
 * by:"agent" 必須同時通過兩層（任何一層拒絕就丟錯、不寫入）：
 * 1) evaluateAgentConfirmation：locked（final-acceptance）永遠拒絕、未知關卡拒絕、非 auto 拒絕；
 * 2) decideGate 帶完整訊號：02-db.sql 全文（destructive-db）、關卡相關產出檔的敏感資訊掃描（sensitive-data）、連續 FAIL 次數、審查員申報。
 */

const MAX_SCAN_BYTES = 512 * 1024;
const afterIds = (after: string | string[]): string[] => (Array.isArray(after) ? after : [after]);

async function readText(file: string): Promise<string | undefined> {
  try {
    const text = await readFile(file, "utf-8");
    return text.length > MAX_SCAN_BYTES ? text.slice(0, MAX_SCAN_BYTES) : text;
  } catch {
    return undefined;
  }
}

async function gateSignals(dir: string, def: WorkflowDefinition, gateId: string, status: TicketStatus, review: unknown): Promise<GateSignals> {
  const gate = def.gates.find((g) => g.id === gateId);
  const roleIds = new Set(gate ? afterIds(gate.after) : []);
  const files = def.roles
    .filter((r) => roleIds.has(r.id))
    .flatMap((r) => r.outputs)
    .flatMap((o) => def.artifacts.find((a) => a.id === o)?.file ?? [])
    .filter((f) => !f.endsWith("/") && /\.(md|sql|mmd)$/i.test(f));
  const texts = (await Promise.all(files.map((f) => readText(path.join(dir, f))))).filter((t): t is string => t !== undefined);
  const sensitiveDataHit = texts.some((t) => t.split(/\r?\n/).some((line) => scanLineForSecrets(line).length > 0));
  const sqlArtifactText = await readText(path.join(dir, "02-db.sql"));
  return {
    consecutiveFailCount: status.consecutive_fail_count,
    sensitiveDataHit,
    ...(sqlArtifactText !== undefined ? { sqlArtifactText } : {}),
    reviewerDeclaration: typeof review === "object" && review !== null ? (review as Record<string, unknown>) : undefined,
  };
}

export async function authorizeDecision(
  ctx: { dir: string; status: TicketStatus },
  def: WorkflowDefinition,
  gateId: string,
  by: "human" | "agent",
  review: unknown
): Promise<void> {
  if (by === "human") return;
  const ticket = { workflow_id: SPEC_FIRST_ID, project_dir: ctx.status.project_dir, consecutive_fail_count: ctx.status.consecutive_fail_count };
  const first = await evaluateAgentConfirmation(ticket, gateId, review, def);
  if (!first.ok) throw new WorkItemActionError(first.message, { reason: first.reason, hardStop: first.hardStop });
  const d = decideGate(def, gateId, ctx.status, await gateSignals(ctx.dir, def, gateId, ctx.status, review));
  if (d.mode !== "auto") {
    throw new WorkItemActionError(`關卡「${gateId}」此次需人工確認，agent 不可代為決定（reason: ${d.reason}${d.hardStop ? `，hardStop: ${d.hardStop}` : ""}）。請由使用者本人確認。`, {
      reason: d.reason,
      ...(d.hardStop ? { hardStop: d.hardStop } : {}),
    });
  }
}

/** 人工確認附的使用者原話：去除空白後至少幾個字元。 */
export const MIN_HUMAN_QUOTE_CHARS = 4;

/** by:"human" 且該關卡解析結果為 manual（含 locked、被專案設成 manual）時，reason 必須是使用者原話。AI 審查（auto）路徑不受影響。 */
export function requireHumanQuote(def: WorkflowDefinition, gateId: string, by: "human" | "agent", reason: string | undefined): void {
  if (by !== "human" || resolveConfirmMode(def, gateId).mode !== "manual") return;
  if ((reason ?? "").replace(/\s/g, "").length >= MIN_HUMAN_QUOTE_CHARS) return;
  throw new WorkItemActionError(`關卡「${gateId}」是人工確認關卡：reason 必填，且必須附上使用者這次確認的原話（去除空白後至少 ${MIN_HUMAN_QUOTE_CHARS} 個字元），不可自行編寫。`);
}

/** 把審查員申報寫進理由，留下可稽核的紀錄。 */
export function withReviewNote(reason: string | undefined, by: "human" | "agent", review: unknown): string | undefined {
  if (by !== "agent" || typeof review !== "object" || review === null) return reason;
  const r = review as Record<string, unknown>;
  const note = `審查申報 breaksExisting=${String(r.breaksExisting)}、reviewerUncertain=${String(r.reviewerUncertain)}、scopeSplit=${String(r.scopeSplit)}`;
  return reason ? `${reason}（${note}）` : note;
}
