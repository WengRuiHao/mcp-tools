import { updateWorkItemScope } from "../work-item-store.js";
import { isMultiModuleProject, overlapFieldsFor } from "../work-item-modules.js";
import { WorkItemActionError, errorMessage, need, okReply, type ToolReply } from "./common.js";
import { loadWorkItem } from "./context.js";
import type { WorkItemArgs } from "./schema.js";

export async function handleSetScope(a: WorkItemArgs): Promise<ToolReply> {
  const { workItemId } = need("set_scope", a, ["workItemId"]);
  if (a.scope === undefined && a.hasDb === undefined && a.highRisk === undefined && a.modules === undefined && a.styleSource === undefined && a.techSource === undefined) {
    throw new WorkItemActionError("action=set_scope 的 scope、hasDb、highRisk、modules、styleSource、techSource 至少要給一個");
  }
  const ctx = await loadWorkItem(workItemId);
  try {
    // 只有要改 modules 時才讀專案 flow.json 的 multiModule，其他欄位的行為不受影響
    const multiModule = a.modules !== undefined && a.modules.length > 0 && !!ctx.status.project_dir ? await isMultiModuleProject(ctx.status.project_dir) : false;
    const s = await updateWorkItemScope(ctx.id, { scope: a.scope, hasDb: a.hasDb, highRisk: a.highRisk, ...(a.modules !== undefined ? { modules: a.modules, multiModule } : {}), styleSource: a.styleSource, techSource: a.techSource });
    return okReply({ workItemId: ctx.id, scope: s.scope, hasDb: s.has_db, ...(s.high_risk === true ? { highRisk: true } : {}), ...(await overlapFieldsFor(ctx.id, s)), styleSource: s.style_source ?? null, techSource: s.tech_source ?? null });
  } catch (e) {
    throw new WorkItemActionError(errorMessage(e));
  }
}
