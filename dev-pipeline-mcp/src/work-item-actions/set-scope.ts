import { updateWorkItemScope } from "../work-item-store.js";
import { WorkItemActionError, errorMessage, need, okReply, type ToolReply } from "./common.js";
import { loadWorkItem } from "./context.js";
import type { WorkItemArgs } from "./schema.js";

export async function handleSetScope(a: WorkItemArgs): Promise<ToolReply> {
  const { workItemId } = need("set_scope", a, ["workItemId"]);
  if (a.scope === undefined && a.hasDb === undefined && a.styleSource === undefined && a.techSource === undefined) {
    throw new WorkItemActionError("action=set_scope 的 scope、hasDb、styleSource、techSource 至少要給一個");
  }
  const ctx = await loadWorkItem(workItemId);
  try {
    const s = await updateWorkItemScope(ctx.id, { scope: a.scope, hasDb: a.hasDb, styleSource: a.styleSource, techSource: a.techSource });
    return okReply({ workItemId: ctx.id, scope: s.scope, hasDb: s.has_db, styleSource: s.style_source ?? null, techSource: s.tech_source ?? null });
  } catch (e) {
    throw new WorkItemActionError(errorMessage(e));
  }
}
