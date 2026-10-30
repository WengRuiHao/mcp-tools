// list_pending_tickets 的 reportOnly 精簡回傳：只留路徑與各類數量；等使用者確認的兩份清單有項目時仍附完整明細。
// 純函式，方便測試；呼叫端（ticket-lifecycle-tools.ts）負責在 reportOnly 時改用這裡組出的物件。

export interface ReportOnlyInput {
  projectGid: string;
  pendingActionsReportPath: string;
  pendingCount: number;
  awaitingConfirmation: unknown[];
  awaitingSpecConfirmation: unknown[];
  needsHumanReviewCount: number;
  contentChangedCount: number;
  manualActionsCount: number;
  uncommittedChanges: { registered: boolean; roots: { ticketGroups: { files: string[] }[] }[] } | null;
}

export function countUncommittedFiles(
  summary: ReportOnlyInput["uncommittedChanges"]
): { registered: boolean; fileCount: number } | null {
  if (!summary) return null;
  const fileCount = summary.roots.reduce((n, r) => n + r.ticketGroups.reduce((m, g) => m + g.files.length, 0), 0);
  return { registered: summary.registered, fileCount };
}

export function buildReportOnlyBody(input: ReportOnlyInput): Record<string, unknown> {
  const uncommitted = countUncommittedFiles(input.uncommittedChanges);
  return {
    success: true,
    reportOnly: true,
    projectGid: input.projectGid,
    pendingActionsReportPath: input.pendingActionsReportPath,
    totalMatched: input.pendingCount,
    awaitingConfirmationCount: input.awaitingConfirmation.length,
    awaitingSpecConfirmationCount: input.awaitingSpecConfirmation.length,
    needsHumanReviewCount: input.needsHumanReviewCount,
    contentChangedCount: input.contentChangedCount,
    manualActionsCount: input.manualActionsCount,
    ...(uncommitted ? { uncommittedChanges: uncommitted } : {}),
    // 這兩項規則是「每次呼叫都要完整秀給使用者」，不能因為精簡而吞掉。
    ...(input.awaitingConfirmation.length > 0 ? { awaitingConfirmation: input.awaitingConfirmation } : {}),
    ...(input.awaitingSpecConfirmation.length > 0 ? { awaitingSpecConfirmation: input.awaitingSpecConfirmation } : {}),
  };
}
