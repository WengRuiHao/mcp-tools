import type { TicketStatus } from "../pipeline-store.js";
import { buildWhenContext } from "../work-item-store.js";
import { resolveWorkflow } from "../workflow/resolve.js";
import type { WorkflowDefinition } from "../workflow/schema.js";
import { computeSpecFirstNext, type PendingGate, type SpecFirstNext } from "../workflow/spec-first-engine.js";
import { loadEffectiveDef, type WorkItemContext } from "./context.js";

/** get／create／各推進動作共用的「下一步」檢視：引擎結果加白話說明。 */

const ROLE_LABELS: Readonly<Record<string, string>> = {
  "baseline-survey": "現況盤點／影響分析師",
  "mockup-designer": "mockup 設計師",
  "sa-analyst": "SA 分析師",
  "db-designer": "DB 設計師",
  "flow-analyst": "流程分析師",
  "sd-analyst": "SD 分析師",
  "spec-verifier": "規格驗證師",
  "frontend-engineer": "前端工程師",
  "backend-engineer": "後端工程師",
  verifier: "驗證師",
  tester: "測試工程師",
};

export type WaitingFor = "user" | "ai-review" | "program-check";

export interface GateView {
  gateId: string;
  type: PendingGate["type"];
  waitingFor: WaitingFor;
  howTo: string;
  hardStop?: string;
  lastRejection?: PendingGate["lastRejection"];
}

const roleLabel = (id: string): string => `${ROLE_LABELS[id] ?? id}（${id}）`;

export function describeGate(g: PendingGate): GateView {
  const base = { gateId: g.gateId, type: g.type, ...(g.hardStop ? { hardStop: g.hardStop } : {}), ...(g.lastRejection ? { lastRejection: g.lastRejection } : {}) };
  if (g.waitingFor === "program-check") return { ...base, waitingFor: "program-check", howTo: "由程式檢查：所屬角色 done 且交件檢查全部通過時自動記為通過，不需要 confirm；不合格會列出問題，修正後重新 done。" };
  if (g.locked) return { ...base, waitingFor: "user", howTo: `最終驗收只能由使用者本人確認：使用者說確認後，用 confirm（gateId="${g.gateId}"、by="human"）；AI 不可代為確認。` };
  if (g.mode === "manual") {
    const why = g.hardStop ? `（觸發硬停點 ${g.hardStop}，必須由使用者處理）` : "";
    return { ...base, waitingFor: "user", howTo: `等使用者本人確認${why}：使用者說確認或打回後，用 confirm（gateId="${g.gateId}"、by="human"）。` };
  }
  if (g.type === "verdict") return { ...base, waitingFor: "ai-review", howTo: `由獨立審查員（不是作者）審查，再用 verdict（gateId="${g.gateId}"、result、by="agent"、review）裁決；不通過要帶 rootCause。` };
  if (g.type === "confirmation") return { ...base, waitingFor: "ai-review", howTo: `由獨立審查員（不是作者）審查，再用 confirm（gateId="${g.gateId}"、by="agent"、review）代為確認；硬停點命中時會被拒絕，改由使用者確認。` };
  return { ...base, waitingFor: "ai-review", howTo: `由獨立審查員（不是作者）審查，再用 confirm（gateId="${g.gateId}"、by="agent"、review）代為確認。` };
}

const WAIT_TEXT: Record<WaitingFor, string> = { user: "等使用者確認", "ai-review": "要由 AI 審查員審查", "program-check": "要由程式檢查" };

/** 白話摘要：下一步誰做、交哪些檔、卡在哪道關卡、關卡是等使用者還是 AI 審查。 */
export function summarize(next: SpecFirstNext, gates: readonly GateView[]): string {
  if (next.complete) return "這個工作項目的所有角色與關卡都已完成。";
  const parts: string[] = [];
  if (next.available.length > 0) {
    const who = next.available.map((a) => `${roleLabel(a.roleId)}，要交 ${a.files.join("、") || "（無檔案）"}`).join("；");
    parts.push(`下一步由 ${who}${next.available.length > 1 ? "（可同時進行）" : ""}。`);
  }
  if (gates.length > 0) {
    const g = gates.map((x) => `「${x.gateId}」（${WAIT_TEXT[x.waitingFor]}${x.lastRejection ? `；上次被退回：${x.lastRejection.rootCause ?? x.lastRejection.decision}` : ""}）`).join("、");
    parts.push(`卡在關卡：${g}。`);
  }
  if (parts.length === 0) parts.push("目前沒有可進行的角色，也沒有待處理的關卡，請檢查進度紀錄是否一致。");
  return parts.join("");
}

export interface NextView {
  def: WorkflowDefinition;
  overrideApplied: boolean;
  next: SpecFirstNext;
  gates: GateView[];
  summary: string;
}

/** 解析流程（套用專案 flow.json 後的定義）並計算下一步；定義傳給引擎 opts.def 的缺口在這裡補上。 */
export function viewFor(status: TicketStatus, def: WorkflowDefinition, overrideApplied: boolean): NextView {
  const next = computeSpecFirstNext(status, resolveWorkflow(def, buildWhenContext(status)), def.artifacts);
  const gates = next.pendingGates.map(describeGate);
  return { def, overrideApplied, next, gates, summary: summarize(next, gates) };
}

export async function buildView(ctx: Pick<WorkItemContext, "status">): Promise<NextView> {
  const { def, overrideApplied } = await loadEffectiveDef(ctx.status);
  return viewFor(ctx.status, def, overrideApplied);
}

/** 動作回覆裡附的下一步精簡區塊。 */
export function nextBlock(v: NextView): Record<string, unknown> {
  return { summary: v.summary, nextRoles: v.next.available, waitingGates: v.gates, complete: v.next.complete };
}
