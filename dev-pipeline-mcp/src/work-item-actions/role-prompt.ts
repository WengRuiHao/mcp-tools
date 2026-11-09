import { getSpecFirstRolePrompt } from "../prompts-spec-first.js";
import { loadProjectFlowOverride } from "../workflow/load.js";
import { WorkItemActionError, errorMessage, need, okReply, type ToolReply } from "./common.js";
import { loadWorkItem } from "./context.js";
import type { WorkItemArgs } from "./schema.js";

export async function handleRolePrompt(a: WorkItemArgs): Promise<ToolReply> {
  const { workItemId, roleId } = need("role_prompt", a, ["workItemId", "roleId"]);
  const ctx = await loadWorkItem(workItemId);
  let projectNotes: string | undefined;
  if (ctx.status.project_dir) {
    try {
      projectNotes = (await loadProjectFlowOverride(ctx.status.project_dir))?.roles?.[roleId]?.roleNotes;
    } catch (e) {
      throw new WorkItemActionError(`專案 flow.json 無法使用：${errorMessage(e)}`);
    }
  }
  let prompt: string;
  try {
    prompt = getSpecFirstRolePrompt(roleId, { workItemDir: ctx.dir, ...(projectNotes ? { roleNotes: projectNotes } : {}) });
  } catch (e) {
    throw new WorkItemActionError(errorMessage(e));
  }
  return okReply({ workItemId: ctx.id, roleId, hasProjectRoleNotes: projectNotes !== undefined, prompt });
}
