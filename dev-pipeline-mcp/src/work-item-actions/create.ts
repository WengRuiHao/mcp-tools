import { createWorkItem } from "../work-item-store.js";
import { WorkItemActionError, errorMessage, need, okReply, type ToolReply } from "./common.js";
import { loadWorkItem } from "./context.js";
import type { WorkItemArgs } from "./schema.js";
import { buildView, nextBlock } from "./view.js";

export async function handleCreate(a: WorkItemArgs): Promise<ToolReply> {
  const f = need("create", a, ["projectDir", "title", "requirement", "baseline", "scope", "hasDb"]);
  let created;
  try {
    created = await createWorkItem({ ...f, workflow: "spec-first" });
  } catch (e) {
    throw new WorkItemActionError(`建立工作項目失敗：${errorMessage(e)}`);
  }
  const base = { workItemId: created.id, dir: created.dir, baseline: f.baseline, scope: f.scope, hasDb: f.hasDb };
  try {
    const v = await buildView(await loadWorkItem(created.id));
    return okReply({ ...base, ...nextBlock(v) });
  } catch (e) {
    return okReply({ ...base, warning: `已建立，但無法計算第一步建議：${errorMessage(e)}；修正後用 get 重新查詢。` });
  }
}
