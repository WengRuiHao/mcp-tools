export type DueOnFilter = "today" | "overdue" | "today_or_overdue" | string;

export interface TicketListFilterOptions {
  dueOn?: DueOnFilter | null;
  /** 不分大小寫：票號完全相等，或標題（name）包含此字串即符合；只過濾傳進來的清單。 */
  search?: string | null;
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

/**
 * 匹配業務單號，例如 "PROJ-1234"，也支援帶數字前綴的格式如 "115PROJ-48"（部分專案的票號慣例）。
 * 前面的 `\d{0,6}` 是刻意加的：純 `\b[A-Za-z]{1,8}-\d{1,8}\b` 對 "115PROJ-48" 抓不到（數字與字母之間沒有 word boundary），
 * 曾因此讓整批新票單偵測失敗、退回用 taskGid 命名。
 */
export const TICKET_NUMBER_PATTERN = /\b\d{0,6}[A-Za-z]{1,8}-\d{1,8}\b/;
const TICKET_NUMBER_FIELD_NAME = "單號";

/** 從 Asana 任務的自訂欄位偵測業務單號：優先「單號」欄位，其次任一符合票號格式的欄位；偵測不到回 null。 */
export function detectTicketNumber(task: any): string | null {
  const fields: any[] = task?.custom_fields ?? [];
  const candidates = [...fields.filter((f) => f?.name === TICKET_NUMBER_FIELD_NAME), ...fields];
  for (const field of candidates) {
    const value = field?.display_value;
    if (typeof value === "string" && TICKET_NUMBER_PATTERN.test(value.trim())) return value.trim();
  }
  return null;
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

function matchesSearch(t: { name?: string | null; ticketNumber?: string | null }, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  if ((t.ticketNumber ?? "").trim().toLowerCase() === needle) return true;
  return (t.name ?? "").toLowerCase().includes(needle);
}

/** 純函式：依 dueOn 過濾、再依 dueOn 由早到晚（無到期日排最後、同日期維持原順序）排序並以 limit 截斷。沒帶任何參數時原樣回傳。 */
export function filterAndLimitTickets<T extends { dueOn?: string | null; name?: string | null; ticketNumber?: string | null }>(
  tickets: T[],
  { dueOn, search, limit, today }: TicketListFilterOptions
): TicketListFilterResult<T> {
  const hasDueOn = dueOn !== undefined && dueOn !== null;
  const hasLimit = limit !== undefined && limit !== null;
  const hasSearch = typeof search === "string" && search.trim() !== "";
  if (!hasDueOn && !hasLimit && !hasSearch) {
    return { tickets, totalMatched: tickets.length, truncated: false };
  }

  const bySearch = hasSearch ? tickets.filter((t) => matchesSearch(t, search as string)) : tickets;
  const matched = hasDueOn ? bySearch.filter((t) => matchesDueOn(t.dueOn, dueOn, today)) : bySearch;
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
