import type { TicketStatus } from "../pipeline-store.js";
import { buildWhenContext } from "../work-item-store.js";
import { CONSECUTIVE_FAIL_LIMIT } from "./enforce.js";
import { resolveWorkflow } from "./resolve.js";
import type { GateDef, WorkflowDefinition } from "./schema.js";
import { getBuiltinWorkflow } from "./stage-order.js";
import { describeRootCauses } from "./builtin/spec-first.js";
import { EMPTY_PROGRESS, isRoleDone, roleAndDownstream, type GateDecider, type GateDecisionValue, type WorkItemProgress } from "./work-item-progress.js";

/** spec-first 的狀態轉移（純函式、不改傳入物件）。錯誤以 { ok:false } 回傳，不拋例外。 */

export type ApplyResult<T = object> = ({ ok: true; status: TicketStatus } & T) | { ok: false; error: string };
export interface GateDecisionInput {
  decision: GateDecisionValue;
  by: GateDecider;
  reason?: string;
  /** 打回時一併退回的角色（只能是該關卡之前的角色；與其下游一起退回）。只有 rejected／failed 可用。 */
  alsoRewind?: readonly string[];
}
/** now：時間戳（測試可注入）；def：自訂 workflow 定義（預設內建 spec-first）；by：applyVerdictFail 的判定者，預設 agent。 */
export interface ApplyOptions {
  now?: string;
  def?: WorkflowDefinition;
  by?: GateDecider;
  /** applyVerdictFail 記錄在關卡紀錄的理由。 */
  reason?: string;
}

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
const progressOf = (s: TicketStatus): WorkItemProgress => s.work_item_progress ?? EMPTY_PROGRESS;
const afterIds = (g: GateDef): string[] => (Array.isArray(g.after) ? g.after : [g.after]);
const withProgress = (s: TicketStatus, p: WorkItemProgress): TicketStatus => ({ ...s, work_item_progress: p });
const defOf = (o: ApplyOptions): WorkflowDefinition => o.def ?? (getBuiltinWorkflow("spec-first") as WorkflowDefinition);
const nowOf = (o: ApplyOptions): string => o.now ?? new Date().toISOString();
const activeIds = (s: TicketStatus, d: WorkflowDefinition): Set<string> => new Set(resolveWorkflow(d, buildWhenContext(s)).roles.map((r) => r.id));

/** 倒回：清掉 roleIds 的 done，以及 after 與其有交集的關卡決定（上游角色與其關卡保留）。 */
function rewind(p: WorkItemProgress, def: WorkflowDefinition, roleIds: ReadonlySet<string>): WorkItemProgress {
  const roles = Object.fromEntries(Object.entries(p.roles).filter(([id]) => !roleIds.has(id)));
  const stale = new Set(def.gates.filter((g) => afterIds(g).some((a) => roleIds.has(a))).map((g) => g.id));
  const gates = Object.fromEntries(Object.entries(p.gates).filter(([id]) => !stale.has(id)));
  return { roles, gates };
}

/** 關卡是否已到達：它掛的啟用角色全部 done。 */
function gateReached(status: TicketStatus, def: WorkflowDefinition, gate: GateDef): boolean {
  const active = activeIds(status, def);
  const ids = afterIds(gate).filter((a) => active.has(a));
  return ids.length > 0 && ids.every((a) => isRoleDone(progressOf(status), a));
}

/** 某些角色的所有上游（不含自己）：沿 dependsOn 展開。 */
function ancestorsOf(roles: WorkflowDefinition["roles"], ids: readonly string[]): Set<string> {
  const out = new Set<string>();
  const stack = [...ids];
  while (stack.length > 0) {
    const cur = stack.pop();
    const r = roles.find((x) => x.id === cur);
    for (const d of r?.dependsOn ?? []) if (!out.has(d)) { out.add(d); stack.push(d); }
  }
  return out;
}

/** 驗證 alsoRewind：角色必須存在、在目前範圍啟用，且是該關卡之前（上游）的角色。回傳錯誤訊息或 null。 */
export function checkAlsoRewind(status: TicketStatus, d: WorkflowDefinition, gate: GateDef, alsoRewind: readonly string[]): string | null {
  const upstream = ancestorsOf(d.roles, afterIds(gate));
  const active = activeIds(status, d);
  for (const id of alsoRewind) {
    if (!d.roles.some((r) => r.id === id)) return `alsoRewind 的角色「${id}」不存在於流程定義`;
    if (!upstream.has(id)) return `alsoRewind 的角色「${id}」不是關卡「${gate.id}」之前的角色（可指定：${[...upstream].join("、") || "（無）"}）`;
    if (!active.has(id)) return `alsoRewind 的角色「${id}」在目前範圍下被略過，不需要退回`;
  }
  return null;
}

/** 標記角色完成。角色必須存在且在目前範圍內啟用；掛在它後面的關卡舊決定（含 rejected／failed 留痕）一併作廢。 */
export function applyRoleDone(status: TicketStatus, roleId: string, opts: ApplyOptions = {}): ApplyResult {
  const d = defOf(opts);
  if (!d.roles.some((r) => r.id === roleId)) return fail(`找不到角色：${roleId}`);
  if (!activeIds(status, d).has(roleId)) return fail(`角色「${roleId}」在目前的範圍／設定下被略過，不需要做`);
  const p = progressOf(status);
  const stale = new Set(d.gates.filter((g) => afterIds(g).includes(roleId)).map((g) => g.id));
  const gates = Object.fromEntries(Object.entries(p.gates).filter(([id]) => !stale.has(id)));
  return { ok: true, status: withProgress(status, { roles: { ...p.roles, [roleId]: { done: true, at: nowOf(opts) } }, gates }) };
}

const DECISIONS_BY_TYPE: Record<GateDef["type"], readonly GateDecisionValue[]> = {
  confirmation: ["confirmed", "rejected"],
  verdict: ["passed"],
  content: ["passed", "failed"],
  evidence: ["passed", "failed"],
};

/**
 * 記錄關卡決定。關卡必須存在且已到達；locked 只能 human；decision 須符合關卡型別
 * （confirmation：confirmed／rejected；content／evidence：passed／failed；verdict 的 PASS 用 passed，FAIL 請走 applyVerdictFail）。
 * rejected／failed 會把該關卡的角色連同下游倒回；verdict passed 會把連續 FAIL 次數歸零。
 */
export function applyGateDecision(status: TicketStatus, gateId: string, input: GateDecisionInput, opts: ApplyOptions = {}): ApplyResult {
  const d = defOf(opts);
  const gate = d.gates.find((g) => g.id === gateId);
  if (!gate) return fail(`找不到關卡：${gateId}`);
  if (gate.locked && input.by !== "human") return fail(`關卡「${gateId}」是 locked，只能由使用者本人（by: "human"）決定`);
  if (!DECISIONS_BY_TYPE[gate.type].includes(input.decision)) {
    const hint = gate.type === "verdict" && input.decision === "failed" ? "，判定不通過請用 applyVerdictFail 以便退回" : "";
    return fail(`關卡「${gateId}」（${gate.type}）不接受 decision「${input.decision}」${hint}`);
  }
  if (!gateReached(status, d, gate)) return fail(`關卡「${gateId}」尚未到達：它之前的角色還沒全部完成`);
  const record = { decision: input.decision, by: input.by, at: nowOf(opts), ...(input.reason !== undefined ? { reason: input.reason } : {}) };
  const bad = input.decision === "rejected" || input.decision === "failed";
  const p = progressOf(status);
  const extra = input.alsoRewind ?? [];
  if (extra.length > 0) {
    if (!bad) return fail("alsoRewind 只能搭配打回（decision=rejected）使用");
    const err = checkAlsoRewind(status, d, gate, extra);
    if (err) return fail(err);
  }
  const base = bad ? rewind(p, d, new Set([...afterIds(gate), ...extra].flatMap((a) => [...roleAndDownstream(d.roles, a)]))) : p;
  const next = withProgress(status, { ...base, gates: { ...base.gates, [gateId]: record } });
  const resetFail = gate.type === "verdict" && input.decision === "passed";
  return { ok: true, status: resetFail ? { ...next, consecutive_fail_count: 0 } : next };
}

export interface VerdictFailResult {
  routedTo: string;
  rewound: string[];
  consecutiveFailCount: number;
  /** 連續 FAIL 達上限（consecutive-fail-3 硬停點）：後續確認必須由使用者本人做。 */
  requireManual: boolean;
  hardStop?: "consecutive-fail-3";
}

/** 判定不通過：依 routeOnFail 找退回角色，倒回該角色與所有下游；連續 FAIL 次數 +1（寫入既有的 consecutive_fail_count）。 */
export function applyVerdictFail(status: TicketStatus, gateId: string, rootCause: string, opts: ApplyOptions = {}): ApplyResult<VerdictFailResult> {
  const d = defOf(opts);
  const gate = d.gates.find((g) => g.id === gateId);
  if (!gate) return fail(`找不到關卡：${gateId}`);
  if (!gate.routeOnFail) return fail(`關卡「${gateId}」沒有定義 routeOnFail，不是可退回的判定關卡`);
  const target = Object.prototype.hasOwnProperty.call(gate.routeOnFail, rootCause) ? gate.routeOnFail[rootCause] : undefined;
  if (!target) return fail(`rootCause「${rootCause}」不在關卡「${gateId}」的 routeOnFail 中（可用：${describeRootCauses(Object.keys(gate.routeOnFail))}）`);
  if (!activeIds(status, d).has(target)) return fail(`rootCause「${rootCause}」要退回的角色「${target}」在目前範圍下被略過，請改選其他原因`);
  if (!gateReached(status, d, gate)) return fail(`關卡「${gateId}」尚未到達：它之前的角色還沒全部完成`);
  const light = Object.prototype.hasOwnProperty.call(gate.routeRewind ?? {}, rootCause) ? gate.routeRewind?.[rootCause] : undefined;
  const scope = light ? new Set(light) : roleAndDownstream(d.roles, target);
  const base = rewind(progressOf(status), d, scope);
  const count = (Number.isFinite(status.consecutive_fail_count) ? status.consecutive_fail_count : 0) + 1;
  const record = { decision: "failed" as const, by: opts.by ?? ("agent" as const), at: nowOf(opts), rootCause, ...(opts.reason !== undefined ? { reason: opts.reason } : {}) };
  const requireManual = count >= CONSECUTIVE_FAIL_LIMIT;
  return {
    ok: true,
    status: { ...withProgress(status, { ...base, gates: { ...base.gates, [gateId]: record } }), consecutive_fail_count: count },
    routedTo: target,
    rewound: d.roles.map((r) => r.id).filter((id) => scope.has(id)),
    consecutiveFailCount: count,
    requireManual,
    ...(requireManual ? { hardStop: "consecutive-fail-3" as const } : {}),
  };
}
