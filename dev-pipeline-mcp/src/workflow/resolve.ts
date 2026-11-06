import { HARD_STOP_IDS, type CheckDef, type GateDef, type HardStopId, type ProjectFlowOverride, type RoleDef, type WorkflowDefinition } from "./schema.js";
import { evalWhen, type WhenContext } from "./validate.js";

export interface ConfirmDecision {
  mode: "manual" | "auto";
  reason: "locked" | "hard-stop" | "gate" | "inherit-default";
  hardStop?: HardStopId;
}

/**
 * 解析某道關卡實際的確認模式：locked 與硬停點優先，其次關卡自己的設定，inherit／未設定則取 workflow 預設。
 * 任何合法的硬停點被觸發都一律 manual（不論 workflow 有沒有宣告）。
 */
export function resolveConfirmMode(def: WorkflowDefinition, gateId: string, triggeredHardStops: readonly HardStopId[] = []): ConfirmDecision {
  const gate = def.gates.find((g) => g.id === gateId);
  if (!gate) throw new Error(`找不到關卡：${gateId}`);
  if (gate.locked) return { mode: "manual", reason: "locked" };
  // fail-closed：只要有任何硬停點被觸發（含未知 id）一律 manual，不因 id 不認得就放行。
  if (triggeredHardStops.length > 0) {
    const hit = triggeredHardStops.find((h) => HARD_STOP_IDS.includes(h)) ?? triggeredHardStops[0];
    return { mode: "manual", reason: "hard-stop", hardStop: hit };
  }
  if (gate.confirmMode === "manual" || gate.confirmMode === "auto") return { mode: gate.confirmMode, reason: "gate" };
  return { mode: def.confirmDefault, reason: "inherit-default" };
}

export type MergeResult = { ok: true; workflow: WorkflowDefinition } | { ok: false; errors: string[] };

function overrideErrors(def: WorkflowDefinition, o: ProjectFlowOverride): string[] {
  const errors: string[] = [];
  for (const [id, patch] of Object.entries(o.gates ?? {})) {
    const gate = def.gates.find((g) => g.id === id);
    if (!gate) {
      errors.push(`flow.json 引用不存在的關卡：${id}`);
      continue;
    }
    if (gate.locked && patch.confirmMode !== undefined) errors.push(`關卡 ${id} 是 locked，不可覆寫 confirmMode`);
    if (patch.checks !== undefined && gate.type !== "content") errors.push(`關卡 ${id} 不是 content 關卡，不可覆寫 checks`);
  }
  for (const id of Object.keys(o.roles ?? {})) {
    if (!def.roles.some((r) => r.id === id)) errors.push(`flow.json 引用不存在的角色：${id}`);
  }
  return errors;
}

/** 追加 checks：以 check id 去重，同 id 以後者（專案版本）取代，其餘既有檢查一律保留。 */
function appendChecks(existing: readonly CheckDef[], added: readonly CheckDef[]): CheckDef[] {
  const out = [...existing];
  for (const c of added) {
    const at = out.findIndex((e) => e.id === c.id);
    if (at >= 0) out[at] = c;
    else out.push(c);
  }
  return out;
}

/** 套用專案覆寫（不修改原物件）。越權（locked、非 content 的 checks、不存在的 id）回傳錯誤。 */
export function mergeProjectOverride(def: WorkflowDefinition, o: ProjectFlowOverride): MergeResult {
  const errors = overrideErrors(def, o);
  if (errors.length > 0) return { ok: false, errors };
  const gates: GateDef[] = def.gates.map((g) => {
    const p = o.gates?.[g.id];
    return p ? { ...g, ...(p.confirmMode !== undefined ? { confirmMode: p.confirmMode } : {}), ...(p.checks !== undefined ? { checks: appendChecks(g.checks ?? [], p.checks) } : {}) } : g;
  });
  const roles: RoleDef[] = def.roles.map((r) => {
    const p = o.roles?.[r.id];
    return p ? { ...r, ...(p.optional !== undefined ? { optional: p.optional } : {}), ...(p.roleNotes !== undefined ? { roleNotes: p.roleNotes } : {}) } : r;
  });
  return { ok: true, workflow: { ...def, confirmDefault: o.confirmDefault ?? def.confirmDefault, gates, roles } };
}

export interface ResolvedWorkflow {
  workflowId: string;
  /** 依依賴順序排列、when 成立的角色。 */
  roles: RoleDef[];
  /** after 至少有一個角色仍啟用的關卡。 */
  gates: Array<GateDef & { effectiveConfirm: ConfirmDecision }>;
}

/** 依 when 條件決定啟用的角色（略過者從 dependsOn 移除），做拓撲排序（同層維持宣告順序），並算出關卡確認模式。 */
export function resolveWorkflow(def: WorkflowDefinition, ctx: WhenContext): ResolvedWorkflow {
  const active = def.roles.filter((r) => evalWhen(r.when, ctx));
  const ids = new Set(active.map((r) => r.id));
  const ordered: RoleDef[] = [];
  const done = new Set<string>();
  while (ordered.length < active.length) {
    const next = active.find((r) => !done.has(r.id) && r.dependsOn.filter((d) => ids.has(d)).every((d) => done.has(d)));
    if (!next) throw new Error("角色依賴有環，無法排序");
    done.add(next.id);
    ordered.push({ ...next, dependsOn: next.dependsOn.filter((d) => ids.has(d)) });
  }
  const gates = def.gates
    .filter((g) => (Array.isArray(g.after) ? g.after : [g.after]).some((a) => ids.has(a)))
    .map((g) => ({ ...g, effectiveConfirm: resolveConfirmMode(def, g.id) }));
  return { workflowId: def.id, roles: ordered, gates };
}
