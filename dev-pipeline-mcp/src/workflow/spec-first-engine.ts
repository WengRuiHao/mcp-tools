import type { TicketStatus } from "../pipeline-store.js";
import { TECH_CONFIRM_GATE } from "../work-item-sources.js";
import { CONSECUTIVE_FAIL_LIMIT } from "./enforce.js";
import type { ResolvedWorkflow } from "./resolve.js";
import type { ArtifactDef, GateDef, HardStopId } from "./schema.js";
import { getBuiltinWorkflow } from "./stage-order.js";
import { isGatePassed, isRoleDone, type WorkItemProgress } from "./work-item-progress.js";

export * from "./spec-first-apply.js";

/** spec-first 推進引擎（純函式）：算出目前可做的角色、卡住的關卡。狀態轉移見 spec-first-apply.ts。 */

export interface AvailableRole {
  roleId: string;
  /** 應交的產出檔案（相對於工作項目目錄）。 */
  files: string[];
}

export interface PendingGate {
  gateId: string;
  type: GateDef["type"];
  locked: boolean;
  /** manual＝等使用者；auto＝需要獨立審查員審查再由程式裁決（content／evidence 關卡由程式檢查）。 */
  mode: "manual" | "auto";
  reason: string;
  hardStop?: HardStopId;
  /** program-check＝content／evidence 關卡由程式檢查：所屬角色 done 且交件檢查通過時自動記為 passed，不等人、也不等 AI 審查。 */
  waitingFor?: "program-check";
  /** 上次被退回（rejected／failed）的留痕，供提示用。 */
  lastRejection?: { decision: string; rootCause?: string; reason?: string };
}

export interface SpecFirstNext {
  workflowId: string;
  /** 所有角色都完成且所有關卡都通過。 */
  complete: boolean;
  doneRoles: string[];
  available: AvailableRole[];
  pendingGates: PendingGate[];
  consecutiveFailCount: number;
}

const afterIds = (g: GateDef): string[] => (Array.isArray(g.after) ? g.after : [g.after]);

function filesOf(outputs: readonly string[], artifacts: readonly ArtifactDef[]): string[] {
  return outputs.flatMap((o) => {
    const a = artifacts.find((x) => x.id === o);
    return a ? [a.file, ...(a.attachments ?? [])] : [];
  });
}

/**
 * 角色可做的條件：自己未完成、依賴角色都完成，且不被「依賴角色後面尚未通過的關卡」擋住
 * （關卡掛在自己身上的不算，避免 db-flow-confirm 這種多角色關卡互卡）。
 */
function isAvailable(role: ResolvedWorkflow["roles"][number], resolved: ResolvedWorkflow, p: WorkItemProgress | undefined): boolean {
  if (isRoleDone(p, role.id) || !role.dependsOn.every((d) => isRoleDone(p, d))) return false;
  return !resolved.gates.some((g) => !isGatePassed(p, g.id) && !afterIds(g).includes(role.id) && afterIds(g).some((a) => role.dependsOn.includes(a)));
}

/** content／evidence 關卡除非被專案 flow.json 覆寫成 manual（解析結果為 auto 才算），一律由程式檢查。 */
export const isProgramCheckGate = (type: GateDef["type"], mode: "manual" | "auto"): boolean => (type === "content" || type === "evidence") && mode === "auto";

/** 技術確認：技術來源為沿用現有時由程式自動記錄（不需確認）；其他來源一律等使用者，不受專案 confirmMode 覆寫影響。 */
export const isTechConfirmAuto = (gateId: string, status: Pick<TicketStatus, "tech_source">): boolean => gateId === TECH_CONFIRM_GATE && status.tech_source === "existing";

function describeGate(g: ResolvedWorkflow["gates"][number], status: TicketStatus): PendingGate {
  const failCount = status.consecutive_fail_count;
  const techGate = g.id === TECH_CONFIRM_GATE;
  const programCheck = !g.locked && (techGate ? isTechConfirmAuto(g.id, status) : isProgramCheckGate(g.type, g.effectiveConfirm.mode));
  const hardStopHit = !g.locked && !programCheck && !(failCount < CONSECUTIVE_FAIL_LIMIT);
  const base = techGate && !programCheck ? { mode: "manual" as const, reason: "tech-source" } : hardStopHit ? { mode: "manual" as const, reason: "hard-stop", hardStop: "consecutive-fail-3" as const } : { mode: g.effectiveConfirm.mode, reason: g.effectiveConfirm.reason };
  const last = status.work_item_progress?.gates[g.id];
  const rejected = last && (last.decision === "rejected" || last.decision === "failed");
  return {
    gateId: g.id,
    type: g.type,
    locked: g.locked === true,
    ...base,
    ...(programCheck ? { waitingFor: "program-check" as const } : {}),
    ...(rejected ? { lastRejection: { decision: last.decision, ...(last.rootCause ? { rootCause: last.rootCause } : {}), ...(last.reason ? { reason: last.reason } : {}) } } : {}),
  };
}

/** 依目前進度算出下一步。resolved 由 resolveWorkflow(def, buildWhenContext(status)) 取得；artifacts 預設用內建 spec-first 的產出定義。 */
export function computeSpecFirstNext(status: TicketStatus, resolved: ResolvedWorkflow, artifacts?: readonly ArtifactDef[]): SpecFirstNext {
  const p = status.work_item_progress;
  const arts = artifacts ?? getBuiltinWorkflow("spec-first")?.artifacts ?? [];
  const available = resolved.roles.filter((r) => isAvailable(r, resolved, p)).map((r) => ({ roleId: r.id, files: filesOf(r.outputs, arts) }));
  const pending = resolved.gates.filter((g) => !isGatePassed(p, g.id) && afterIds(g).filter((a) => resolved.roles.some((r) => r.id === a)).every((a) => isRoleDone(p, a)));
  const doneRoles = resolved.roles.filter((r) => isRoleDone(p, r.id)).map((r) => r.id);
  return {
    workflowId: resolved.workflowId,
    complete: doneRoles.length === resolved.roles.length && resolved.gates.every((g) => isGatePassed(p, g.id)),
    doneRoles,
    available,
    pendingGates: pending.map((g) => describeGate(g, status)),
    consecutiveFailCount: Number.isFinite(status.consecutive_fail_count) ? status.consecutive_fail_count : 0,
  };
}
