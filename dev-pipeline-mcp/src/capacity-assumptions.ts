// 容量假設清單（專案層文件 capacity-assumptions.md，批次 2M-k）：解析與逾期判斷。純文字，不讀檔案。
// 格式：每行「- 假設內容｜到期日：YYYY-MM-DD」。
export const CAPACITY_FILE = "capacity-assumptions.md";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface CapacityAssumption {
  text: string;
  /** YYYY-MM-DD；沒寫或格式不對是 undefined。 */
  date: string | undefined;
  /** 有寫到期日欄位但格式不對時的原文。 */
  rawDate: string | undefined;
}

export function parseCapacityAssumptions(text: string): CapacityAssumption[] {
  const out: CapacityAssumption[] = [];
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const m = /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/.exec(raw);
    if (!m) continue;
    const parts = m[1].split(/[｜|]/).map((p) => p.replace(/[`*]/g, "").trim());
    const body = parts[0];
    if (!body) continue;
    const dateField = parts.slice(1).map((p) => /^到期日\s*[:：]\s*(.*)$/.exec(p)?.[1]?.trim()).find((v) => v !== undefined);
    out.push({ text: body, date: dateField !== undefined && DATE_RE.test(dateField) ? dateField : undefined, rawDate: dateField !== undefined && !DATE_RE.test(dateField) ? dateField : undefined });
  }
  return out;
}

/** 寫入時警告：缺到期日、日期格式不對。 */
export function capacityDocProblems(items: readonly CapacityAssumption[]): string[] {
  return items.flatMap((a) => {
    if (a.rawDate !== undefined) return [`容量假設「${a.text}」的到期日「${a.rawDate}」格式不對，要寫 YYYY-MM-DD`];
    if (a.date === undefined) return [`容量假設「${a.text}」沒有到期日（寫「- ${a.text}｜到期日：YYYY-MM-DD」）`];
    return [];
  });
}

/** 到期日早於 today（YYYY-MM-DD）才算逾期，當天不算。 */
export function overdueCapacityAssumptions(items: readonly CapacityAssumption[], today: string): CapacityAssumption[] {
  return items.filter((a) => a.date !== undefined && a.date < today);
}
