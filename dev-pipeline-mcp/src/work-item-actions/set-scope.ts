import { updateWorkItemScope } from "../work-item-store.js";
import { WorkItemActionError, errorMessage, need, okReply, type ToolReply } from "./common.js";
import { loadWorkItem } from "./context.js";
import type { WorkItemArgs } from "./schema.js";

export async function handleSetScope(a: WorkItemArgs): Promise<ToolReply> {
  const { workItemId } = need("set_scope", a, ["workItemId"]);
  if (a.scope === undefined && a.hasDb === undefined) throw new WorkItemActionError("action=set_scope 的 scope 與 hasDb 至少要給一個");
  const ctx = await loadWorkItem(workItemId);
  try {
    const s = await updateWorkItemScope(ctx.id, { scope: a.scope, hasDb: a.hasDb });
    return okReply({ workItemId: ctx.id, scope: s.scope, hasDb: s.has_db });
  } catch (e) {
    throw new WorkItemActionError(errorMessage(e));
  }
}
