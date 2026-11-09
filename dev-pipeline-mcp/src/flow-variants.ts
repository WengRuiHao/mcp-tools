import { describeFlowVariants } from "./project-flow-settings.js";
import { usableProjectDirFor, type SdMode, type SpecOrder } from "./project-registry.js";
import { buildStepPlan } from "./step-plan.js";

export const DEFAULT_VALUE_NOTICE =
  "這是預設值（settings.json 裡沒有 ticketNamePattern 的那筆 profile），這個專案有依票名切換的其他 profile，實際以每張票自己的為準（get_ticket_status 的 stepPlan／get_role_prompt 帶 taskGid）。";

/**
 * 專案層級呼叫（沒有票名）用：這個專案有依票名分流的 profile 時，回傳預設值標示與全部 profile 摘要；
 * 沒有任何 ticketNamePattern 時回傳 null（輸出維持舊格式，不多任何欄位）。
 */
export async function describeTicketNameProfiles(projectGid: string): Promise<Record<string, unknown> | null> {
  const dir = await usableProjectDirFor(projectGid);
  const found = dir ? await describeFlowVariants(dir, projectGid) : null;
  if (!found) return null;
  return {
    notice: DEFAULT_VALUE_NOTICE,
    hasDefaultProfile: found.hasDefault,
    profiles: found.variants.map((v) => ({
      ticketNamePattern: v.ticketNamePattern,
      isDefault: v.ticketNamePattern === null,
      sdMode: v.sdMode,
      specOrder: v.specOrder,
      testCapabilityMode: v.testCapabilityMode,
      stepPlanSteps: v.sdMode ? (buildStepPlan({ sdMode: v.sdMode as SdMode, specOrder: v.specOrder as SpecOrder | null })?.steps ?? null) : null,
    })),
  };
}
