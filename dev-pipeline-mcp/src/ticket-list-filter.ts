export type DueOnFilter = "today" | "overdue" | "today_or_overdue" | string;

export interface TicketListFilterOptions {
  dueOn?: DueOnFilter | null;
  limit?: number | null;
  /** 注入「今天」（YYYY-MM-DD）以便測試；呼叫端平常帶執行機器的本地日期。 */
  today: string;
}

export interface TicketListFilterResult<T> {
  tickets: T[];
  /** 套用 dueOn 之後、limit 截斷之前的筆數。 */
  totalMatched: number;
  truncated: boolean;
  truncatedNote?: string;
}

export const DUE_ON_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function localDateString(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function matchesDueOn(due: string | null | undefined, dueOn: DueOnFilter, today: string): boolean {
  // 沒有到期日的票，只有不帶 dueOn 時才會出現
  if (!due) return false;
  switch (dueOn) {
    case "today":
      return due === today;
    case "overdue":
      return due < today;
    case "today_or_overdue":
      return due <= today;
    default:
      return due === dueOn;
  }
}

/** 純函式：依 dueOn 過濾、再依 dueOn 由早到晚（無到期日排最後、同日期維持原順序）排序並以 limit 截斷。沒帶任何參數時原樣回傳。 */
export function filterAndLimitTickets<T extends { dueOn?: string | null }>(
  tickets: T[],
  { dueOn, limit, today }: TicketListFilterOptions
): TicketListFilterResult<T> {
  const hasDueOn = dueOn !== undefined && dueOn !== null;
  const hasLimit = limit !== undefined && limit !== null;
  if (!hasDueOn && !hasLimit) {
    return { tickets, totalMatched: tickets.length, truncated: false };
  }

  const matched = hasDueOn ? tickets.filter((t) => matchesDueOn(t.dueOn, dueOn, today)) : tickets;
  const sorted = matched
    .map((ticket, index) => ({ ticket, index }))
    .sort((a, b) => {
      const da = a.ticket.dueOn || null;
      const db = b.ticket.dueOn || null;
      if (da !== db) {
        if (da === null) return 1;
        if (db === null) return -1;
        return da < db ? -1 : 1;
      }
      return a.index - b.index;
    })
    .map((x) => x.ticket);

  if (hasLimit && sorted.length > limit) {
    return {
      tickets: sorted.slice(0, limit),
      totalMatched: sorted.length,
      truncated: true,
      truncatedNote: `符合條件共 ${sorted.length} 筆，只回傳前 ${limit} 筆（已被截斷 ${sorted.length - limit} 筆）；可用 dueOn 縮小範圍或調大 limit 取得其餘。`,
    };
  }
  return { tickets: sorted, totalMatched: sorted.length, truncated: false };
}
