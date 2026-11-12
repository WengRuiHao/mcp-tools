import type { WorkflowDefinition } from "../workflow/schema.js";
import type { TicketStatus } from "../pipeline-store.js";
import { isRoleDone } from "../workflow/work-item-progress.js";
import { checkDeliverables } from "./deliverables.js";

/** 角色已 done 後重寫它的產出檔：重跑與 done 相同的交件內容檢查（checkDeliverables），結果附在 write 回傳。 */

export interface RecheckResult {
  ok: boolean;
  failures: string[];
  /** 被重新檢查的角色。 */
  roles: string[];
}

/** 檔名是否屬於某產出物（主檔、附屬檔；資料夾型以前綴比對）。 */
function belongsTo(filename: string, paths: readonly string[]): boolean {
  return paths.some((p) => (p.endsWith("/") ? filename.startsWith(p) : filename === p));
}

/** 已 done 且產出物涵蓋 filename 的角色 id。 */
export function doneRolesOwning(status: TicketStatus, def: WorkflowDefinition, filename: string): string[] {
  return def.roles
    .filter((r) => isRoleDone(status.work_item_progress, r.id))
    .filter((r) =>
      r.outputs.some((o) => {
        const a = def.artifacts.find((x) => x.id === o);
        return a !== undefined && belongsTo(filename, [a.file, ...(a.attachments ?? [])]);
      })
    )
    .map((r) => r.id);
}

/** 沒有受影響的已完成角色回 undefined（write 行為不變）。檢查本身出錯也視為失敗項，不丟錯。 */
export async function recheckAfterWrite(dir: string, status: TicketStatus, def: WorkflowDefinition, filename: string): Promise<RecheckResult | undefined> {
  const roles = doneRolesOwning(status, def, filename);
  if (roles.length === 0) return undefined;
  const failures: string[] = [];
  for (const roleId of roles) {
    try {
      const problems = await checkDeliverables(dir, roleId, def, { techSource: status.tech_source, projectDir: status.project_dir, baseline: status.baseline });
      failures.push(...problems.map((p) => (roles.length > 1 ? `[${roleId}] ${p}` : p)));
    } catch (e) {
      failures.push(`[${roleId}] 重新檢查時發生錯誤：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { ok: failures.length === 0, failures, roles };
}
