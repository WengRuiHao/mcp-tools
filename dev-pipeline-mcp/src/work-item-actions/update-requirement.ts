import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { updateStatus } from "../pipeline-store.js";
import { WorkItemActionError, errorMessage, need, okReply, type ToolReply } from "./common.js";
import { doneRoleIds } from "./confirm.js";
import { loadEffectiveDef, loadWorkItem } from "./context.js";
import { requireReasonQuote } from "./gate-guard.js";
import { refreshIndexDoc } from "./index-doc.js";
import type { WorkItemArgs } from "./schema.js";
import { ROLE_LABELS } from "./view.js";

const MAX_REQUIREMENT_BYTES = 512 * 1024;
const PREVIOUS_SUMMARY_CHARS = 200;
const REQUIREMENT_FILE = "item.md";

/** 修改需求：只能 by human；更新 item.md、在 status 記錄修改歷程；不自動退回任何角色，只列出已完成角色並建議用 confirm 打回搭配 alsoRewind。 */
export async function handleUpdateRequirement(a: WorkItemArgs): Promise<ToolReply> {
  const { workItemId, requirement } = need("update_requirement", a, ["workItemId", "requirement"]);
  if (a.by !== "human") throw new WorkItemActionError('update_requirement 只能由使用者本人要求修改：必須帶 by:"human"，AI 不可自行修改需求。');
  requireReasonQuote("修改需求", a.reason);
  if (Buffer.byteLength(requirement, "utf-8") > MAX_REQUIREMENT_BYTES) throw new WorkItemActionError(`requirement 超過 ${MAX_REQUIREMENT_BYTES / 1024}KB 上限`);
  const ctx = await loadWorkItem(workItemId);
  const file = path.join(ctx.dir, REQUIREMENT_FILE);
  const previous = await readFile(file, "utf-8").catch(() => "");
  if (previous.trim() === requirement.trim()) throw new WorkItemActionError("新的需求全文與目前的需求原文相同，沒有需要更新的內容。");
  const quote = (a.reason ?? "").trim();
  try {
    await writeFile(file, requirement, "utf-8");
  } catch (e) {
    throw new WorkItemActionError(`寫入 ${REQUIREMENT_FILE} 失敗：${errorMessage(e)}`);
  }
  const record = { at: new Date().toISOString(), quote, previous_summary: previous.replace(/\s+/g, " ").trim().slice(0, PREVIOUS_SUMMARY_CHARS) };
  const updated = await updateStatus(ctx.id, (s) => ({ ...s, requirement_history: [...(s.requirement_history ?? []), record] }));
  const { def, overrideApplied } = await loadEffectiveDef(updated);
  const done = doneRoleIds(updated);
  const indexWarning = await refreshIndexDoc({ dir: ctx.dir, status: updated }, { def, overrideApplied });
  return okReply({
    workItemId: ctx.id,
    updated: true,
    historyCount: updated.requirement_history?.length ?? 1,
    completedRoles: done.map((id) => ({ roleId: id, label: ROLE_LABELS[id] ?? id })),
    suggestion: done.length === 0
      ? "尚無已完成的角色，後續角色會直接依新需求進行。"
      : "需求已更新，但沒有自動退回任何角色。已完成的角色可能還依據舊需求：請與使用者確認哪些要重做，再用 confirm（decision=\"rejected\"、by=\"human\"、reason 附使用者原話）打回對應關卡，並用 alsoRewind 指定要一併退回的前面角色（例如 baseline-survey 以更新 impact.md）。",
    ...(indexWarning ? { indexWarning } : {}),
  });
}
