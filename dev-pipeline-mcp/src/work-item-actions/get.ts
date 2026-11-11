import { isSaConfirmed } from "../work-item-store.js";
import { isStyleSourceLocked, isTechSourceLocked } from "../work-item-sources.js";
import { need, okReply, type ToolReply } from "./common.js";
import { loadWorkItem } from "./context.js";
import { listDeliverables } from "./deliverable-list.js";
import { existingSummaryFile } from "./final-summary-io.js";
import type { WorkItemArgs } from "./schema.js";
import { buildView, nextBlock } from "./view.js";

export async function handleGet(a: WorkItemArgs): Promise<ToolReply> {
  const { workItemId } = need("get", a, ["workItemId"]);
  const ctx = await loadWorkItem(workItemId);
  const v = await buildView(ctx);
  const s = ctx.status;
  const summaryFile = await existingSummaryFile(ctx.dir, s);
  return okReply({
    workItemId: ctx.id,
    dir: ctx.dir,
    title: s.name,
    baseline: s.baseline,
    scope: s.scope,
    hasDb: s.has_db,
    styleSource: s.style_source ?? null,
    styleSourceLocked: isStyleSourceLocked(s),
    techSource: s.tech_source ?? null,
    techSourceLocked: isTechSourceLocked(s),
    saConfirmed: isSaConfirmed(s),
    flowOverrideApplied: v.overrideApplied,
    doneRoles: v.next.doneRoles,
    consecutiveFailCount: v.next.consecutiveFailCount,
    ...(summaryFile ? { summaryFile } : {}),
    ...(await listDeliverables(ctx.dir, v.def)),
    ...nextBlock(v),
  });
}
