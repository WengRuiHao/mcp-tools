import { RELEASE_FILE, DEFAULT_RELEASE_DAYS, addDays, formatReleaseLine, isIsoDate, overdueReleases, parseReleases } from "../release-register.js";
import { readProjectDoc, writeProjectDoc } from "../project-docs-store.js";
import { LEGACY_EXCEPTIONS_FILE, overdueLegacyExceptions } from "../legacy-exceptions.js";
import { WorkItemActionError, errorMessage } from "./common.js";

export const todayIso = (now: Date): string => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

/** 預計補齊日期：沒給用今天起算的預設天數；給了必須是真實存在的 YYYY-MM-DD 且不早於今天。 */
export function resolveReleaseDue(raw: string | undefined, today: string): string {
  if (raw === undefined || raw.trim() === "") return addDays(today, DEFAULT_RELEASE_DAYS);
  const due = raw.trim();
  if (!isIsoDate(due)) throw new WorkItemActionError(`releaseDue「${due}」格式不對，要寫 YYYY-MM-DD`);
  if (due < today) throw new WorkItemActionError(`releaseDue「${due}」早於今天（${today}），預計補齊日期要在今天或之後`);
  return due;
}

/** 放行成功後登記到專案層 release-register.md；寫入失敗不影響確認，改回 warning。 */
export async function recordRelease(projectDir: string, entry: { workItemId: string; problems: readonly string[]; quote: string; due: string }, now: Date = new Date()): Promise<{ releaseRecorded: { file: string; due: string } } | { releaseWarning: string }> {
  try {
    const doc = await readProjectDoc(projectDir, RELEASE_FILE);
    const line = formatReleaseLine({ ...entry, releasedAt: todayIso(now) });
    const base = doc.exists ? doc.content.replace(/\s*$/, "") + "\n" : "# 放行登記\n\n";
    await writeProjectDoc(projectDir, RELEASE_FILE, base + line + "\n", doc.exists ? { expectedSha256: doc.sha256 ?? undefined } : {});
    return { releaseRecorded: { file: RELEASE_FILE, due: entry.due } };
  } catch (e) {
    return { releaseWarning: `SD 已放行確認，但寫入 ${RELEASE_FILE} 失敗：${errorMessage(e)}；請手動補登（${formatReleaseLine({ ...entry, releasedAt: todayIso(now) })}）` };
  }
}

/** get 用：專案層放行登記有逾期的才回 releaseWarnings；沒有文件、沒有逾期都不多欄位。 */
export async function releaseWarningsField(projectDir: string | null | undefined, now: Date = new Date()): Promise<{ releaseWarnings?: string[] }> {
  if (!projectDir) return {};
  const doc = await readProjectDoc(projectDir, RELEASE_FILE).catch(() => null);
  if (!doc || !doc.exists) return {};
  const over = overdueReleases(parseReleases(doc.content), todayIso(now));
  return over.length > 0 ? { releaseWarnings: over.map((r) => `${r.workItemId} 的放行已逾期（預計補齊 ${r.due}）：${r.reason}；請補齊依賴，並從 ${RELEASE_FILE} 移除或更新到期日`) } : {};
}

/** get 用：專案層歷史例外清單有逾期的才回 legacyExceptionWarnings；沒有文件、沒有逾期都不多欄位。 */
export async function legacyExceptionWarningsField(projectDir: string | null | undefined, now: Date = new Date()): Promise<{ legacyExceptionWarnings?: string[] }> {
  if (!projectDir) return {};
  const doc = await readProjectDoc(projectDir, LEGACY_EXCEPTIONS_FILE).catch(() => null);
  if (!doc || !doc.exists) return {};
  const over = overdueLegacyExceptions(doc.content, todayIso(now));
  return over.length > 0 ? { legacyExceptionWarnings: over } : {};
}
