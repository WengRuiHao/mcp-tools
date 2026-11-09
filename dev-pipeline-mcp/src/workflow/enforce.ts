import { HARD_STOP_IDS, type HardStopId, type WorkflowDefinition } from "./schema.js";
import { resolveConfirmMode, type ConfirmDecision } from "./resolve.js";

/** 審查者申報（breaks-existing／reviewer-uncertain／scope-split 無法由程式偵測，只能靠申報）。 */
export interface ReviewerDeclaration {
  breaksExisting: boolean;
  reviewerUncertain: boolean;
  scopeSplit: boolean;
}

export interface GateSignals {
  consecutiveFailCount: number;
  /** 本關卡相關的 SQL 產出物全文；沒有 SQL 就不傳。 */
  sqlArtifactText?: string;
  sensitiveDataHit?: boolean;
  /** 缺漏、欄位缺少或型別不對 → 視為申報不完整（auto 時 fail-closed 為 manual）。 */
  reviewerDeclaration?: Partial<Record<keyof ReviewerDeclaration, unknown>>;
}

export interface GateDecision {
  mode: "manual" | "auto";
  reason: ConfirmDecision["reason"] | "asana-confirmation" | "declaration-incomplete";
  hardStop?: HardStopId;
}

export const CONSECUTIVE_FAIL_LIMIT = 3;
const ASANA_WORKFLOW_ID = "asana-ticket";

/**
 * destructive-db 判定規則（先移除 `--` 行註解與區塊註解，不分大小寫，以 `;` 切成語句逐句判斷）：
 * - DROP 任何物件、TRUNCATE：一律觸發。
 * - ALTER ... TYPE／MODIFY（改欄位型別）：觸發。
 * - DELETE FROM 且同一語句沒有 WHERE：觸發；有 WHERE 不觸發。
 * - 純 SELECT、註解內的關鍵字、`ON DELETE CASCADE` 等外鍵子句不觸發。
 */
export function isDestructiveSql(sql: string): boolean {
  const stripped = sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
  return stripped.split(";").some((stmt) => {
    const s = stmt.toUpperCase();
    if (/\bDROP\b/.test(s) || /\bTRUNCATE\b/.test(s)) return true;
    if (/\bALTER\b[\s\S]*\b(TYPE|MODIFY)\b/.test(s)) return true;
    return /\bDELETE\s+FROM\b/.test(s) && !/\bWHERE\b/.test(s);
  });
}

function parseDeclaration(raw: unknown): ReviewerDeclaration | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.breaksExisting !== "boolean" || typeof r.reviewerUncertain !== "boolean" || typeof r.scopeSplit !== "boolean") return undefined;
  return { breaksExisting: r.breaksExisting, reviewerUncertain: r.reviewerUncertain, scopeSplit: r.scopeSplit };
}

function triggeredHardStops(signals: GateSignals, decl: ReviewerDeclaration | undefined): HardStopId[] {
  const hit = new Set<HardStopId>();
  if (typeof signals.sqlArtifactText === "string" && isDestructiveSql(signals.sqlArtifactText)) hit.add("destructive-db");
  // 非數字（NaN／undefined）視為無法確認，fail-closed 當作已達上限。
  if (!(signals.consecutiveFailCount < CONSECUTIVE_FAIL_LIMIT)) hit.add("consecutive-fail-3");
  if (signals.sensitiveDataHit === true) hit.add("sensitive-data");
  if (decl?.breaksExisting) hit.add("breaks-existing");
  if (decl?.reviewerUncertain) hit.add("reviewer-uncertain");
  if (decl?.scopeSplit) hit.add("scope-split");
  return HARD_STOP_IDS.filter((h) => hit.has(h));
}

/**
 * 執行期判斷某關卡這次該 manual 還是 auto（純函式，不改傳入物件）。
 * 順序：locked → 硬停點（由 signals 推得）→ 關卡／預設；auto 結果再經兩道 fail-closed：
 * asana-ticket 的確認類關卡一律 manual；審查者申報不完整一律 manual。
 * status 目前保留給後續階段（依票單狀態判斷），尚未使用。
 */
export function decideGate(def: WorkflowDefinition, gateId: string, status: unknown, signals: GateSignals): GateDecision {
  void status;
  const gate = def.gates.find((g) => g.id === gateId);
  if (!gate) throw new Error(`找不到關卡：${gateId}（workflow ${def.id}）`);
  const decl = parseDeclaration(signals.reviewerDeclaration);
  const decision = resolveConfirmMode(def, gateId, triggeredHardStops(signals, decl));
  if (decision.mode === "manual") return { ...decision };
  if (def.id === ASANA_WORKFLOW_ID && gate.type === "confirmation") return { mode: "manual", reason: "asana-confirmation" };
  if (!decl) return { mode: "manual", reason: "declaration-incomplete" };
  return { ...decision };
}
