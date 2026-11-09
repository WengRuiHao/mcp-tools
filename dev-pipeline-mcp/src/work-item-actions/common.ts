import { textResult } from "../shared.js";

/** 動作層的預期錯誤（參數缺漏、守門拒絕、交件不合格等）：由分派層統一轉成 isError 結果。 */
export class WorkItemActionError extends Error {
  constructor(
    message: string,
    readonly extra: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "WorkItemActionError";
  }
}

export type ToolReply = ReturnType<typeof textResult>;

export const okReply = (payload: Record<string, unknown>): ToolReply => textResult({ success: true, ...payload });
export const errorReply = (message: string, extra: Record<string, unknown> = {}): ToolReply => textResult({ success: false, message, ...extra }, true);

/** 取出動作必填欄位（空字串與純空白視為缺漏）；缺漏時丟出列出全部缺項的錯誤。 */
export function need<T extends object, K extends keyof T>(action: string, args: T, keys: readonly K[]): { [P in K]-?: NonNullable<T[P]> } {
  const missing = keys.filter((k) => {
    const v = args[k];
    return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
  });
  if (missing.length > 0) throw new WorkItemActionError(`action=${action} 缺少必填參數：${missing.map(String).join("、")}`);
  return args as { [P in K]-?: NonNullable<T[P]> };
}

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
