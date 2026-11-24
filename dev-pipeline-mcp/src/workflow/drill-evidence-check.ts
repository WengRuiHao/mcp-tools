// 高風險需求的「回滾演練證據」檢查（批次 2M-a）：test.md 要有「## 回滾演練」節，
// 含演練日期（YYYY-MM-DD）、演練結果（通過）、演練耗時（含數字），並至少一張證據圖（規則同測試證據）。
// 純文字檢查，圖片驗證由呼叫端注入；缺證據擋住交件。
import { extractSection } from "./reuse-record-check.js";
import { IMAGE_RE } from "./sa-image-check.js";

export const DRILL_SECTION = "回滾演練";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const strip = (s: string): string => s.replace(/[`*_\s]/g, "");

function itemContent(body: string, label: string): string | null {
  for (const raw of body.split(/\r\n|\r|\n/)) {
    const line = raw.replace(/^\s*(?:[-*+]|\d+[.)])\s*/, "");
    const m = /^(.{1,20}?)\s*[:：]\s*(.*)$/.exec(line);
    if (m && strip(m[1]) === label) return m[2].replace(/^\*+\s*/, "").trim();
  }
  return null;
}

export function checkDrillEvidenceText(text: string, opts: { validateImage: (ref: string) => string | null }): string[] {
  const body = extractSection(text, DRILL_SECTION);
  if (body === null) {
    return [`缺少「## ${DRILL_SECTION}」章節：高風險需求上線前要附回滾演練證據（演練日期、演練結果、演練耗時，加至少一張證據圖 ![說明](evidence/<檔名>)）`];
  }
  const out: string[] = [];
  const need = (label: string, hint: string): string | null => {
    const v = itemContent(body, label);
    if (v === null || v === "") {
      out.push(`「${DRILL_SECTION}」缺少「${label}」或沒有寫內容（${hint}）；格式「- ${label}：內容」`);
      return null;
    }
    return v;
  };
  const date = need("演練日期", "例如 2026-11-20");
  if (date !== null && !DATE_RE.test(date)) out.push(`「${DRILL_SECTION}」的「演練日期」格式要 YYYY-MM-DD：${date.slice(0, 20)}`);
  const result = need("演練結果", "寫「通過」");
  if (result !== null && !/^通過/.test(strip(result))) out.push(`「${DRILL_SECTION}」的「演練結果」必須是通過才能交件（目前：${result.slice(0, 20)}）；演練沒過要先修好再重演`);
  const cost = need("演練耗時", "例如 12 分鐘");
  if (cost !== null && !/\d/.test(cost)) out.push(`「${DRILL_SECTION}」的「演練耗時」要寫數字（例如 12 分鐘）：${cost.slice(0, 20)}`);
  const refs = [...body.matchAll(IMAGE_RE)].map((m) => m[1]);
  if (refs.length === 0) out.push(`「${DRILL_SECTION}」缺證據圖：底下沒有 ![說明](evidence/<檔名>)`);
  for (const r of refs) {
    const reason = opts.validateImage(r);
    if (reason) out.push(`「${DRILL_SECTION}」證據圖不合格：${reason}`);
  }
  return out;
}
