import type { RoleDef, WorkflowDefinition } from "./schema.js";
import { evalWhen, parseWhen, type WhenContext } from "./validate.js";

/**
 * 只在高風險才啟用的角色（when 含 highRisk）與它們獨有的產出物：沒啟用時，一般需求的任何回覆、清單、錯誤訊息都不可出現它們，
 * 讓簡單需求的行為與輸出和加入高風險機制之前完全相同。
 */

const isHighRiskOnly = (r: RoleDef): boolean => r.when !== undefined && (parseWhen(r.when) ?? []).some(([key]) => key === "highRisk");

/** 目前沒啟用的高風險專屬角色 id。 */
export function hiddenHighRiskRoleIds(def: WorkflowDefinition, ctx: WhenContext): Set<string> {
  return new Set(def.roles.filter((r) => isHighRiskOnly(r) && !evalWhen(r.when, ctx)).map((r) => r.id));
}

/** 只有高風險專屬角色會產出的產出物 id（至少一個產出者，且每個產出者都是高風險專屬）。 */
export function highRiskOnlyArtifactIds(def: WorkflowDefinition): Set<string> {
  return new Set(
    def.artifacts
      .filter((a) => {
        const producers = def.roles.filter((r) => r.outputs.includes(a.id));
        return producers.length > 0 && producers.every(isHighRiskOnly);
      })
      .map((a) => a.id)
  );
}

/** 高風險專屬產出物的檔名（含附屬檔）。 */
export function highRiskOnlyFiles(def: WorkflowDefinition): Set<string> {
  const ids = highRiskOnlyArtifactIds(def);
  return new Set(def.artifacts.filter((a) => ids.has(a.id)).flatMap((a) => [a.file, ...(a.attachments ?? [])]));
}

/** 拿掉目前不啟用的高風險專屬產出物（其他一律保留，包含沿用既有行為的未啟用角色產出物）。只用在檔案清單類的輸出。 */
export function withoutHiddenHighRiskArtifacts(def: WorkflowDefinition, ctx: WhenContext): WorkflowDefinition {
  const only = highRiskOnlyArtifactIds(def);
  const active = new Set(def.roles.filter((r) => evalWhen(r.when, ctx)).flatMap((r) => r.outputs));
  return { ...def, artifacts: def.artifacts.filter((a) => !only.has(a.id) || active.has(a.id)) };
}
