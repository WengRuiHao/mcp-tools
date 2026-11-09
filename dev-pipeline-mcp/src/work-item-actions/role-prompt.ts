import { getSpecFirstRolePrompt } from "../prompts-spec-first.js";
import { loadProjectFlowOverride } from "../workflow/load.js";
import { WorkItemActionError, errorMessage, need, okReply, type ToolReply } from "./common.js";
import { loadWorkItem } from "./context.js";
import type { WorkItemArgs } from "./schema.js";

export async function handleRolePrompt(a: WorkItemArgs): Promise<ToolReply> {
  const { workItemId, roleId } = need("role_prompt", a, ["workItemId", "roleId"]);
  const ctx = await loadWorkItem(workItemId);
  let projectNotes: string | undefined;
  let projectGuide: { title: string; text: string } | undefined;
  if (ctx.status.project_dir) {
    try {
      const override = await loadProjectFlowOverride(ctx.status.project_dir);
      projectNotes = override?.roles?.[roleId]?.roleNotes;
      if (roleId === "mockup-designer" && override?.styleGuide) projectGuide = { title: "專案畫面風格規範（styleGuide）", text: override.styleGuide };
      if (roleId === "tech-selector" && override?.techGuide) projectGuide = { title: "專案技術規範（techGuide）", text: override.techGuide };
    } catch (e) {
      throw new WorkItemActionError(`專案 flow.json 無法使用：${errorMessage(e)}`);
    }
  }
  let prompt: string;
  try {
    prompt = getSpecFirstRolePrompt(roleId, { workItemDir: ctx.dir, ...(projectNotes ? { roleNotes: projectNotes } : {}), ...(projectGuide ? { projectGuide } : {}) });
  } catch (e) {
    throw new WorkItemActionError(errorMessage(e));
  }
  return okReply({ workItemId: ctx.id, roleId, hasProjectRoleNotes: projectNotes !== undefined, hasProjectGuide: projectGuide !== undefined, prompt });
}
