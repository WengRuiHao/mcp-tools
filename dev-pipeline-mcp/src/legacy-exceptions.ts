// 歷史例外清單（專案層文件 legacy-exceptions.md，批次 1M）：既有系統裡多個模組直接寫同一張表之類的舊做法，登記後不判違規，但要有預計補齊日期。
// 格式與容量假設清單相同：每行「- 例外內容｜到期日：YYYY-MM-DD」，逾期只提醒、不擋。純文字，不讀檔案。
import { overdueCapacityAssumptions, parseCapacityAssumptions } from "./capacity-assumptions.js";

export const LEGACY_EXCEPTIONS_FILE = "legacy-exceptions.md";

/** 寫入時警告：缺到期日、日期格式不對。 */
export function legacyExceptionProblems(text: string): string[] {
  return parseCapacityAssumptions(text).flatMap((a) => {
    if (a.rawDate !== undefined) return [`歷史例外「${a.text}」的到期日「${a.rawDate}」格式不對，要寫 YYYY-MM-DD`];
    if (a.date === undefined) return [`歷史例外「${a.text}」沒有到期日（寫「- ${a.text}｜到期日：YYYY-MM-DD」）`];
    return [];
  });
}

/** 到期日早於 today（YYYY-MM-DD）的例外提醒；當天不算逾期。 */
export function overdueLegacyExceptions(text: string, today: string): string[] {
  return overdueCapacityAssumptions(parseCapacityAssumptions(text), today).map((a) => `歷史例外「${a.text}」已逾期（到期日 ${a.date}）；請補齊或更新 ${LEGACY_EXCEPTIONS_FILE}`);
}
