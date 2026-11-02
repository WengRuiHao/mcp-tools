import { STAGE_ORDER, advanceStage, readStatus, type TicketStatus } from "./pipeline-store.js";

/**
 * 「確認程式碼目錄」（stage = project_dir_confirmed）的共用邏輯：
 * advance_ticket_stage({ stage: "project_dir_confirmed" }) 與
 * get_ticket_snapshot({ confirmProjectDir: true }) 都走這裡，檢查與狀態寫入完全相同，不各寫一份。
 */

export type ConfirmProjectDirResult =
  | { ok: true; status: TicketStatus }
  | { ok: false; message: string };

/** 前置條件：project_dir 這次有帶、或這張票先前已設定過，不能是空值。回傳 null 代表通過，否則回傳拒絕訊息。 */
export function checkProjectDirConfirmable(current: TicketStatus, projectDirParam: string | null | undefined): string | null {
  const resolvedProjectDir = projectDirParam ?? current.project_dir;
  if (!resolvedProjectDir) {
    return `推進到 "project_dir_confirmed" 階段時必須確定 project_dir（可以這次呼叫時一併帶入，或這張票先前已經設定過），不能是空值。`;
  }
  return null;
}

/** 檢查前置條件後，把 stage 推進到 project_dir_confirmed（project_dir 有帶才一併更新）。 */
export async function confirmProjectDirStage(
  taskGid: string,
  projectDirParam: string | null | undefined
): Promise<ConfirmProjectDirResult> {
  const rejection = checkProjectDirConfirmable(await readStatus(taskGid), projectDirParam);
  if (rejection) return { ok: false, message: rejection };
  const patch: Partial<TicketStatus> = {};
  if (projectDirParam !== undefined) patch.project_dir = projectDirParam;
  return { ok: true, status: await advanceStage(taskGid, "project_dir_confirmed", patch) };
}

export type SnapshotConfirmOutcome =
  | { projectDirConfirmed: true; stageAdvanced: boolean }
  | { projectDirConfirmed: false; message: string };

/**
 * get_ticket_snapshot({ confirmProjectDir: true }) 專用：只在 stage 還沒到 project_dir_confirmed 時才推進；
 * 已在該階段或更後面（例如重抓一張已 analyzed／verified 的票）就什麼都不寫，避免把進度倒退
 * （advance_ticket_stage 的 advanceStage 不做 forward-only 保護，這裡刻意不沿用那個倒退行為）。
 * 要推進時走 confirmProjectDirStage，檢查與寫入跟 advance_ticket_stage project_dir_confirmed 完全相同。
 */
export async function confirmProjectDirAfterSnapshot(taskGid: string, projectDir: string): Promise<SnapshotConfirmOutcome> {
  const current = await readStatus(taskGid);
  if (STAGE_ORDER.indexOf(current.stage) >= STAGE_ORDER.indexOf("project_dir_confirmed")) {
    return { projectDirConfirmed: true, stageAdvanced: false };
  }
  const result = await confirmProjectDirStage(taskGid, projectDir);
  return result.ok ? { projectDirConfirmed: true, stageAdvanced: true } : { projectDirConfirmed: false, message: result.message };
}
