import { REVIEWER_PROMPT, REVIEWER_ROLE_ID } from "../prompts-spec-first/reviewer.js";
import { getSpecFirstRolePrompt } from "../prompts-spec-first.js";
import { loadProjectFlowOverride } from "../workflow/load.js";
import { WorkItemActionError, errorMessage, need, okReply, type ToolReply } from "./common.js";
import { loadWorkItem } from "./context.js";
import type { WorkItemArgs } from "./schema.js";

export async function handleRolePrompt(a: WorkItemArgs): Promise<ToolReply> {
  const { workItemId, roleId } = need("role_prompt", a, ["workItemId", "roleId"]);
  const ctx = await loadWorkItem(workItemId);
  // 審查員不是流程角色（不在角色清單、不計入驗收），只有說明書；不附專案角色補充說明
  if (roleId === REVIEWER_ROLE_ID) return okReply({ workItemId: ctx.id, roleId, hasProjectRoleNotes: false, hasProjectGuide: false, prompt: REVIEWER_PROMPT });
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
