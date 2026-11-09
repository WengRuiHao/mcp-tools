import type { RoleDef } from "./schema.js";

/** 手動來源（work item）的逐角色／逐關卡進度，存在 status.json 的 work_item_progress（選填，Asana 票單不會有）。 */

export type GateDecisionValue = "confirmed" | "rejected" | "passed" | "failed";
export type GateDecider = "human" | "agent";

export interface RoleProgress {
  done: boolean;
  at: string;
}

export interface GateRecord {
  decision: GateDecisionValue;
  by: GateDecider;
  at: string;
  reason?: string;
  rootCause?: string;
}

export interface WorkItemProgress {
  roles: Record<string, RoleProgress>;
  gates: Record<string, GateRecord>;
}

export const EMPTY_PROGRESS: WorkItemProgress = { roles: {}, gates: {} };

/** 關卡是否已通過（只有 confirmed／passed 算數；rejected／failed 是留痕，不算通過）。 */
export function isGatePassed(progress: WorkItemProgress | undefined, gateId: string): boolean {
  const d = progress?.gates[gateId]?.decision;
  return d === "confirmed" || d === "passed";
}

export function isRoleDone(progress: WorkItemProgress | undefined, roleId: string): boolean {
  return progress?.roles[roleId]?.done === true;
}

/** 某角色的所有下游（含自己）：沿完整定義的 dependsOn 反向展開。上游不受影響。 */
export function roleAndDownstream(roles: readonly RoleDef[], roleId: string): Set<string> {
  const out = new Set<string>([roleId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of roles) {
      if (!out.has(r.id) && r.dependsOn.some((d) => out.has(d))) {
        out.add(r.id);
        grew = true;
      }
    }
  }
  return out;
}
