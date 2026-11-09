import { decideGate, type GateSignals } from "./enforce.js";
import { loadProjectFlowOverride } from "./load.js";
import { mergeProjectOverride } from "./resolve.js";
import { getBuiltinWorkflow } from "./stage-order.js";
import type { WorkflowDefinition } from "./schema.js";

const ASANA_WORKFLOW_ID = "asana-ticket";
/** record_spec_confirmation 對應的規格確認關卡 id（非 asana-ticket workflow 才有）。 */
export const SPEC_CONFIRM_GATE_ID = "sd-confirm";

export type AgentConfirmVerdict = { ok: true } | { ok: false; message: string; reason?: string; hardStop?: string };

export interface AgentConfirmTicket {
  workflow_id?: string;
  project_dir: string | null;
  consecutive_fail_count: number;
}

const reject = (message: string, extra: { reason?: string; hardStop?: string } = {}): AgentConfirmVerdict => ({ ok: false, message, ...extra });

/** 取票單的 workflow 定義並套用專案 flow.json 覆寫（失敗時回 undefined 與原因）。 */
async function loadDefinition(t: AgentConfirmTicket): Promise<{ def?: WorkflowDefinition; error?: string }> {
  const base = getBuiltinWorkflow(t.workflow_id ?? ASANA_WORKFLOW_ID);
  if (!base) return { error: `找不到 workflow「${t.workflow_id}」的定義` };
  if (!t.project_dir) return { def: base };
  try {
    const override = await loadProjectFlowOverride(t.project_dir);
    if (!override) return { def: base };
    const merged = mergeProjectOverride(base, override);
    return merged.ok ? { def: merged.workflow } : { error: `flow.json 覆寫被拒絕：${merged.errors.join("；")}` };
  } catch (err: any) {
    return { error: err?.message ?? String(err) };
  }
}

/**
 * agent 代為確認某關卡前的把關（fail-closed）：
 * asana-ticket 一律拒絕；locked 關卡（final-acceptance）在任何 workflow 都永遠拒絕；其餘交給 decideGate，只有 auto 才放行。
 */
export async function evaluateAgentConfirmation(
  ticket: AgentConfirmTicket,
  gateId: string,
  review: unknown,
  definition?: WorkflowDefinition
): Promise<AgentConfirmVerdict> {
  const wfId = ticket.workflow_id ?? ASANA_WORKFLOW_ID;
  if (wfId === ASANA_WORKFLOW_ID) return reject("Asana 票單的確認類關卡不允許 agent 代為確認（confirmedBy: \"agent\" 被拒絕），請由使用者本人確認。", { reason: "asana-confirmation" });
  const loaded = definition ? { def: definition } : await loadDefinition(ticket);
  if (!loaded.def) return reject(`無法判斷 agent 確認是否放行：${loaded.error}`);
  const gate = loaded.def.gates.find((g) => g.id === gateId);
  if (!gate) return reject(`workflow「${wfId}」沒有關卡「${gateId}」，不允許 agent 確認。`);
  if (gate.locked) return reject(`關卡「${gateId}」是 locked（最終驗收類），永遠只能由使用者人工確認。`, { reason: "locked" });
  const signals: GateSignals = {
    consecutiveFailCount: ticket.consecutive_fail_count,
    reviewerDeclaration: typeof review === "object" && review !== null ? (review as Record<string, unknown>) : undefined,
  };
  const d = decideGate(loaded.def, gateId, ticket, signals);
  if (d.mode === "auto") return { ok: true };
  return reject(`關卡「${gateId}」此次需人工確認，agent 不可代為確認（reason: ${d.reason}${d.hardStop ? `，hardStop: ${d.hardStop}` : ""}）。`, {
    reason: d.reason,
    ...(d.hardStop ? { hardStop: d.hardStop } : {}),
  });
}
