// 放行登記（專案層文件 release-register.md，批次 1M）：依賴未完成時使用者本人放行，登記放行原因與預計補齊日期。純文字，不讀檔案。
// 格式：每行「- 工作項目編號｜原因｜放行日：YYYY-MM-DD｜到期日：YYYY-MM-DD」，逾期只提醒、不擋。
export const RELEASE_FILE = "release-register.md";
export const DEFAULT_RELEASE_DAYS = 30;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface ReleaseEntry {
  workItemId: string;
  reason: string;
  releasedAt: string | undefined;
  due: string | undefined;
}

const clean = (s: string): string => s.replace(/[｜|]/g, "/").replace(/\s+/g, " ").trim();

export function formatReleaseLine(r: { workItemId: string; problems: readonly string[]; quote: string; releasedAt: string; due: string }): string {
  return `- ${r.workItemId}｜${clean(`${r.problems.join("；")}（使用者原話：${r.quote}）`)}｜放行日：${r.releasedAt}｜到期日：${r.due}`;
}

export function parseReleases(text: string): ReleaseEntry[] {
  const out: ReleaseEntry[] = [];
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const m = /^\s*[-*+]\s+(wi-\d{8}-\d+)\s*[｜|]\s*(.*)$/.exec(raw);
    if (!m) continue;
    const parts = m[2].split(/[｜|]/).map((p) => p.trim());
    const field = (label: string): string | undefined => parts.map((p) => new RegExp(`^${label}\s*[:：]\s*(.*)$`).exec(p)?.[1]?.trim()).find((v) => v !== undefined);
    const releasedAt = field("放行日");
    const due = field("到期日");
    out.push({ workItemId: m[1], reason: parts[0] ?? "", releasedAt: releasedAt && DATE_RE.test(releasedAt) ? releasedAt : undefined, due: due && DATE_RE.test(due) ? due : undefined });
  }
  return out;
}

/** 到期日早於 today（YYYY-MM-DD）才算逾期，當天不算。 */
export function overdueReleases(items: readonly ReleaseEntry[], today: string): ReleaseEntry[] {
  return items.filter((r) => r.due !== undefined && r.due < today);
}
