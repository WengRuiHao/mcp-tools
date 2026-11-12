import type { WorkflowDefinition } from "./schema.js";

/** 語意驗證：schema 通過之後，檢查 id 唯一、引用存在、依賴無環、locked、children 鏈、when 語法。 */

const WHEN_TERM = /^([A-Za-z_][A-Za-z0-9_]*)==([A-Za-z0-9_.-]+)$/;

export type WhenContext = Readonly<Record<string, string | null | undefined>>;

/** when 只支援 `key==value`，以 `&&` 連接；回傳 null 代表語法不合法。 */
export function parseWhen(expr: string): Array<[string, string]> | null {
  const out: Array<[string, string]> = [];
  for (const term of expr.split("&&")) {
    const m = WHEN_TERM.exec(term.trim());
    if (!m) return null;
    out.push([m[1], m[2]]);
  }
  return out;
}

export function evalWhen(expr: string | undefined, ctx: WhenContext): boolean {
  if (expr === undefined) return true;
  const terms = parseWhen(expr);
  if (!terms) throw new Error(`when 語法不合法：${expr}`);
  return terms.every(([key, value]) => ctx[key] === value);
}

function duplicates(ids: string[]): string[] {
  return [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
}

function findCycle(roles: WorkflowDefinition["roles"]): string[] | null {
  const deps = new Map(roles.map((r) => [r.id, r.dependsOn]));
  const state = new Map<string, 1 | 2>();
  const walk = (id: string, trail: string[]): string[] | null => {
    if (state.get(id) === 2) return null;
    if (state.get(id) === 1) return [...trail.slice(trail.indexOf(id)), id];
    state.set(id, 1);
    for (const next of deps.get(id) ?? []) {
      if (!deps.has(next)) continue;
      const cycle = walk(next, [...trail, id]);
      if (cycle) return cycle;
    }
    state.set(id, 2);
    return null;
  };
  for (const r of roles) {
    const cycle = walk(r.id, []);
    if (cycle) return cycle;
  }
  return null;
}

const CHILD_OF: Readonly<Record<string, string | undefined>> = { system: "module", module: "feature" };

/**
 * fromLegacy 實際提供給 when 的 key（含內建 workflow 用到的 baseline）。
 * hasFrontend／hasBackend／hasDb 是由「範圍」衍生的布林 key（值為字串 "true"／"false"），因 when 不支援 OR 而分開提供。
 */
export const KNOWN_WHEN_KEYS: readonly string[] = [
  "sdMode",
  "specOrder",
  "baseline",
  "testCapabilityMode",
  "legacyTestProfile",
  "hasFrontend",
  "hasBackend",
  "hasDb",
];

/** 回傳所有語意錯誤；空陣列代表合法。knownWhenKeys 有給時，when 用到清單外的 key 也算錯。 */
export function validateWorkflow(def: WorkflowDefinition, knownWhenKeys?: readonly string[]): string[] {
  const errors: string[] = [];
  const artifactIds = def.artifacts.map((a) => a.id);
  const roleIds = def.roles.map((r) => r.id);
  for (const [label, ids] of [["artifact", artifactIds], ["role", roleIds], ["gate", def.gates.map((g) => g.id)]] as const) {
    for (const d of duplicates(ids)) errors.push(`${label} id 重複：${d}`);
  }
  const roleSet = new Set(roleIds);
  const artifactSet = new Set(artifactIds);
  for (const r of def.roles) {
    for (const d of [...r.dependsOn, ...(r.parallelWith ?? [])]) {
      if (!roleSet.has(d)) errors.push(`role ${r.id} 引用不存在的角色：${d}`);
    }
    for (const a of [...r.inputs, ...r.outputs]) {
      if (!artifactSet.has(a)) errors.push(`role ${r.id} 引用不存在的產出物：${a}`);
    }
    if (r.when !== undefined && !parseWhen(r.when)) errors.push(`role ${r.id} 的 when 語法不合法（只支援 key==value 以 && 連接）：${r.when}`);
    for (const [key] of knownWhenKeys && r.when !== undefined ? (parseWhen(r.when) ?? []) : []) {
      if (!knownWhenKeys?.includes(key)) errors.push(`role ${r.id} 的 when 使用未知的 key：${key}`);
    }
  }
  const cycle = findCycle(def.roles);
  if (cycle) errors.push(`角色依賴有環：${cycle.join(" -> ")}`);
  for (const g of def.gates) {
    for (const a of Array.isArray(g.after) ? g.after : [g.after]) {
      if (!roleSet.has(a)) errors.push(`gate ${g.id} 的 after 引用不存在的角色：${a}`);
    }
    for (const target of Object.values(g.routeOnFail ?? {})) {
      if (!roleSet.has(target)) errors.push(`gate ${g.id} 的 routeOnFail 引用不存在的角色：${target}`);
    }
    for (const [cause, roles] of Object.entries(g.routeRewind ?? {})) {
      const target = g.routeOnFail?.[cause];
      if (target === undefined) errors.push(`gate ${g.id} 的 routeRewind 根因「${cause}」不在 routeOnFail 中`);
      else if (!roles.includes(target)) errors.push(`gate ${g.id} 的 routeRewind「${cause}」必須包含退回目標角色：${target}`);
      for (const r of roles) if (!roleSet.has(r)) errors.push(`gate ${g.id} 的 routeRewind「${cause}」引用不存在的角色：${r}`);
    }
    if (g.locked && g.confirmMode === "auto") errors.push(`gate ${g.id} 是 locked，不得設為 auto`);
    if (g.checks && g.type !== "content") errors.push(`gate ${g.id} 不是 content 關卡，不可有 checks`);
  }
  if (def.children) {
    if (!CHILD_OF[def.granularity]) errors.push(`granularity ${def.granularity} 不可有 children（只有 system、module 可以）`);
    if (!artifactSet.has(def.children.from)) errors.push(`children.from 引用不存在的產出物：${def.children.from}`);
  }
  return errors;
}

/** children 鏈合法性（system→module→feature）：由呼叫端提供以 id 查 workflow 的函式。 */
export function validateChildrenChain(
  def: WorkflowDefinition,
  lookup: (id: string) => WorkflowDefinition | undefined,
  visited: ReadonlySet<string> = new Set()
): string[] {
  if (!def.children) return [];
  if (visited.has(def.id)) return [`children 鏈有環：${[...visited, def.id].join(" -> ")}`];
  const child = lookup(def.children.workflow);
  if (!child) return [`children.workflow 找不到：${def.children.workflow}`];
  const expected = CHILD_OF[def.granularity];
  if (expected && child.granularity !== expected) {
    return [`${def.granularity} 的 children 必須是 ${expected}，但 ${child.id} 是 ${child.granularity}`];
  }
  return validateChildrenChain(child, lookup, new Set([...visited, def.id]));
}
