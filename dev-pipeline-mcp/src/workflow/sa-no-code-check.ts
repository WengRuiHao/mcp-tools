// S14：SA 不寫程式檢查。01-sa.md 不可有程式碼區塊（mermaid 流程圖除外）與明顯的 SQL 語句。
// 資料表／類別名稱難以自動判斷，交給 SA 提示詞與規格驗證師。「## 依據附錄」內允許檔案路徑與行號，其餘規則相同。
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { eachLine, SA_FILE_NAME } from "./sa-image-check.js";

export const SA_APPENDIX_HEADING = "## 依據附錄";
export const SNIPPET_MAX = 60;
const ALLOWED_FENCE_LANG = "mermaid";

export interface SaNoCodeViolation {
  line: number;
  reason: string;
  snippet: string;
}
export interface SaNoCodeResult {
  ok: boolean;
  violations: SaNoCodeViolation[];
}

const ID = String.raw`[\w.\[\]\`"]+`;
/** 欄位清單：* 或以逗號分隔的識別字（可帶函式呼叫、別名），避免把「select an item from the list」這類英文句子誤判。 */
const COL = String.raw`(?:\*|${ID}(?:\s*\([^)]*\))?(?:\s+AS\s+${ID})?)`;
/** 各語句要求完整的關鍵字組合都出現（不分大小寫），單獨一個 select／update 等字不算。 */
const SQL_PATTERNS: readonly { re: RegExp; label: string }[] = [
  { re: new RegExp(String.raw`\bSELECT\s+(?:DISTINCT\s+)?${COL}(?:\s*,\s*${COL})*\s+FROM\s+${ID}`, "i"), label: "SELECT … FROM" },
  { re: /\bINSERT\s+INTO\s+\S/i, label: "INSERT INTO" },
  { re: new RegExp(String.raw`\bUPDATE\s+${ID}\s+SET\s+${ID}\s*=`, "i"), label: "UPDATE … SET" },
  { re: /\bDELETE\s+FROM\s+\S/i, label: "DELETE FROM" },
  { re: /\b(CREATE|ALTER|DROP|TRUNCATE)\s+TABLE\b/i, label: "CREATE／ALTER／DROP／TRUNCATE TABLE" },
];

const shorten = (text: string): string => {
  const t = text.trim();
  return t.length <= SNIPPET_MAX ? t : `${t.slice(0, SNIPPET_MAX - 1)}…`;
};

export function checkSaNoCode(workItemDir: string): SaNoCodeResult {
  const saPath = path.join(workItemDir, SA_FILE_NAME);
  if (!existsSync(saPath)) {
    return { ok: false, violations: [{ line: 0, reason: `找不到 ${SA_FILE_NAME}，無法檢查 SA 是否含程式碼`, snippet: "" }] };
  }
  const violations: SaNoCodeViolation[] = [];
  eachLine(
    readFileSync(saPath, "utf-8"),
    (line, lineNo) => {
      const hit = SQL_PATTERNS.find((p) => p.re.test(line));
      if (hit) violations.push({ line: lineNo, reason: `出現 SQL 語句（${hit.label}），SQL 屬於 SD 與 DB 設計，SA 請改用業務語言描述`, snippet: shorten(line) });
    },
    (info, lineNo, opening) => {
      if (!opening || info.split(/\s+/)[0].toLowerCase() === ALLOWED_FENCE_LANG) return;
      violations.push({ line: lineNo, reason: "出現程式碼區塊（僅 mermaid 流程圖允許），請改用業務語言描述；依據的檔案位置放「## 依據附錄」", snippet: shorten(`\`\`\`${info}`) });
    },
  );
  return { ok: violations.length === 0, violations };
}
