// S8：test.md 測試證據檢查（測試工程師 done 時必須通過；對應關卡 test-evidence）。
// 圖片路徑規則與 SA 截圖檢查完全一致，直接重用 sa-image-check 的 validateImageRef／collectSections。
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { collectSections, listHeadings, validateImageRef } from "./sa-image-check.js";

export const TEST_FILE_NAME = "test.md";
export const EVIDENCE_DIR = "evidence";
/** 測試項目標題：`##` 或 `###` 開頭，標題文字以此前綴開頭（例如「## 測試：登入失敗顯示錯誤」）。 */
export const TEST_HEADING_PREFIX = "測試：";
export const TEST_HEADING_LEVELS: readonly number[] = [2, 3];
export const WHITEBOX_HEADING = "白箱";
export const BLACKBOX_HEADING = "黑箱";

/** 給測試工程師角色說明引用的約定說明。 */
export const TEST_EVIDENCE_CONVENTION_TEXT = [
  `測試項目標題＝${TEST_FILE_NAME} 中以 \`##\` 開頭、標題文字以「${TEST_HEADING_PREFIX}」開頭的標題（例如「## 測試：登入失敗顯示錯誤」）。`,
  `${TEST_FILE_NAME} 必須另有「## ${WHITEBOX_HEADING}」與「## ${BLACKBOX_HEADING}」兩節，且白箱在黑箱之前。`,
  `每個測試項目標題底下至少要有一個圖片引用 \`![說明](${EVIDENCE_DIR}/<檔名>)\`，圖檔存在於 ${EVIDENCE_DIR}/、副檔名 png／jpg／jpeg／webp、非空；路徑不可含 \`..\`、不可是絕對路徑或外部網址。`,
].join("\n");

export interface TestEvidenceResult {
  ok: boolean;
  violations: string[];
  testCount: number;
}

function sectionLine(text: string, name: string): number | null {
  const h = listHeadings(text).find((x) => x.level === 2 && x.title.startsWith(name));
  return h ? h.line : null;
}

function orderProblems(text: string): string[] {
  const white = sectionLine(text, WHITEBOX_HEADING);
  const black = sectionLine(text, BLACKBOX_HEADING);
  const missing = [white === null ? `## ${WHITEBOX_HEADING}` : "", black === null ? `## ${BLACKBOX_HEADING}` : ""].filter(Boolean);
  if (missing.length > 0) return [`缺少 ${missing.join("、")} 這一節`];
  return (white as number) < (black as number) ? [] : [`「## ${WHITEBOX_HEADING}」必須在「## ${BLACKBOX_HEADING}」之前（先白箱後黑箱）`];
}

/** 檢查 test.md 全文與 evidence/ 圖檔。 */
export function checkTestEvidenceText(text: string, workItemDir: string): TestEvidenceResult {
  const sections = collectSections(text, TEST_HEADING_PREFIX, TEST_HEADING_LEVELS);
  const violations = orderProblems(text);
  if (sections.length === 0) violations.push(`找不到任何測試項目標題（需以「## ${TEST_HEADING_PREFIX}<名稱>」開頭）`);
  const root = path.resolve(workItemDir, EVIDENCE_DIR);
  for (const s of sections) {
    const where = `測試項目「${s.heading}」（第 ${s.line} 行）`;
    if (s.refs.length === 0) violations.push(`${where}缺證據圖：底下沒有 ![說明](${EVIDENCE_DIR}/<檔名>)`);
    for (const r of s.refs) {
      const reason = validateImageRef(r.ref, root, EVIDENCE_DIR);
      if (reason) violations.push(`${where}第 ${r.line} 行：${reason}`);
    }
  }
  return { ok: violations.length === 0, violations, testCount: sections.length };
}

export function checkTestEvidence(workItemDir: string): TestEvidenceResult {
  const file = path.join(workItemDir, TEST_FILE_NAME);
  if (!existsSync(file)) throw new Error(`找不到 ${TEST_FILE_NAME}（${file}），無法檢查測試證據；請先完成測試報告。`);
  return checkTestEvidenceText(readFileSync(file, "utf-8"), workItemDir);
}
