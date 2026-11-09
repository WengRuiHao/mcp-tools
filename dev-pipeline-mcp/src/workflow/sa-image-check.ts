// S6：SA 截圖自動檢查（關卡 sa-content-check／check id sa-mockup-screenshot）。
// 純函式＋檔案讀取，不寫檔。標題約定常數與說明字串供 SA 角色說明（S7）共用。
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const SA_FILE_NAME = "01-sa.md";
export const SA_IMAGES_DIR = "sa-images";
/** 功能標題：`##` 或 `###` 開頭，標題文字以此前綴開頭。 */
export const FUNCTION_HEADING_PREFIX = "功能";
export const FUNCTION_HEADING_LEVELS: readonly number[] = [2, 3];
/** 標題文字含此標記者免附圖。 */
export const BACKEND_ONLY_MARKER = "（純後端）";
export const ALLOWED_IMAGE_EXTENSIONS: readonly string[] = ["png", "jpg", "jpeg", "webp"];

/** 給 SA 角色說明引用的約定說明。 */
export const SA_IMAGE_CONVENTION_TEXT = [
  `功能標題＝${SA_FILE_NAME} 中以 \`##\` 或 \`###\` 開頭、且標題文字以「${FUNCTION_HEADING_PREFIX}」開頭的標題（例如「## 功能：會員匯出訂單 Excel」）。`,
  `標題文字含「${BACKEND_ONLY_MARKER}」者免附圖。`,
  `每個功能標題底下（到下一個同級或更高級標題之前）至少要有一個圖片引用 \`![說明](${SA_IMAGES_DIR}/<檔名>)\`。`,
  `圖檔必須存在於工作項目的 ${SA_IMAGES_DIR}/ 下、副檔名為 ${ALLOWED_IMAGE_EXTENSIONS.join("／")}、檔案大小大於 0。`,
  `圖片路徑只認 ${SA_IMAGES_DIR}/ 相對路徑，不可含 \`..\`、不可是絕對路徑或外部網址。`,
].join("\n");

export interface SaImageViolation {
  heading: string;
  line: number;
  reason: string;
}
export interface SaImageCheckResult {
  ok: boolean;
  violations: SaImageViolation[];
  functionCount: number;
}

const HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const IMAGE_RE = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/** 回傳違規原因；合法則回 null（含檔案存在、副檔名、非空檢查）。 */
function validateImageRef(rawRef: string, imagesRoot: string): string | null {
  let ref = rawRef;
  try {
    ref = decodeURIComponent(rawRef);
  } catch {
    return `路徑不合法：${rawRef}`;
  }
  const bad = (m: string) => `路徑不合法（${m}）：${rawRef}`;
  if (SCHEME_RE.test(ref) || ref.startsWith("//")) return bad("不可為外部網址");
  if (ref.startsWith("/") || ref.startsWith("\\") || /^[a-z]:/i.test(ref)) return bad("不可為絕對路徑");
  if (ref.includes("\\")) return bad("不可含反斜線");
  const segments = ref.split("/");
  if (segments.includes("..")) return bad("不可含 ..");
  if (segments[0] !== SA_IMAGES_DIR || segments.length < 2 || segments.some((s) => s === "")) {
    return bad(`只認 ${SA_IMAGES_DIR}/ 相對路徑`);
  }
  const full = path.resolve(imagesRoot, ...segments.slice(1));
  const rel = path.relative(imagesRoot, full);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return bad("超出圖片目錄");
  const ext = path.extname(full).slice(1).toLowerCase();
  if (!ALLOWED_IMAGE_EXTENSIONS.includes(ext)) {
    return `副檔名不允許（僅限 ${ALLOWED_IMAGE_EXTENSIONS.join("／")}）：${rawRef}`;
  }
  if (!existsSync(full)) return `圖檔不存在：${rawRef}`;
  const st = statSync(full);
  if (!st.isFile()) return `圖檔不存在：${rawRef}`;
  if (st.size === 0) return `空檔案：${rawRef}`;
  return null;
}

interface Section {
  heading: string;
  line: number;
  refs: { ref: string; line: number }[];
}

/** 掃描 01-sa.md，切出每個功能標題的範圍並收集範圍內的圖片引用（略過程式碼區塊）。 */
function collectSections(text: string): Section[] {
  const sections: Section[] = [];
  let current: { level: number; section: Section } | null = null;
  let fence: string | null = null;
  text.split(/\r\n|\r|\n/).forEach((line, idx) => {
    const lineNo = idx + 1;
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const mark = fenceMatch[1][0];
      if (fence === null) fence = mark;
      else if (fence === mark) fence = null;
      return;
    }
    if (fence !== null) return;
    const h = HEADING_RE.exec(line);
    if (h) {
      const level = h[1].length;
      const title = h[2].trim();
      if (current && level <= current.level) current = null;
      if (FUNCTION_HEADING_LEVELS.includes(level) && title.startsWith(FUNCTION_HEADING_PREFIX)) {
        const section: Section = { heading: title, line: lineNo, refs: [] };
        sections.push(section);
        current = { level, section };
      }
      return;
    }
    if (!current) return;
    for (const m of line.matchAll(IMAGE_RE)) current.section.refs.push({ ref: m[1], line: lineNo });
  });
  return sections;
}

export function checkSaImages(workItemDir: string): SaImageCheckResult {
  const saPath = path.join(workItemDir, SA_FILE_NAME);
  if (!existsSync(saPath)) {
    throw new Error(`找不到 ${SA_FILE_NAME}（${saPath}），無法檢查 SA 截圖；請先完成 SA 規格。`);
  }
  const sections = collectSections(readFileSync(saPath, "utf-8"));
  if (sections.length === 0) {
    return {
      ok: false,
      functionCount: 0,
      violations: [{ heading: "", line: 0, reason: `找不到任何功能標題（需以「${FUNCTION_HEADING_PREFIX}」開頭）` }],
    };
  }
  const imagesRoot = path.resolve(workItemDir, SA_IMAGES_DIR);
  const violations: SaImageViolation[] = [];
  for (const s of sections) {
    if (s.heading.includes(BACKEND_ONLY_MARKER)) continue;
    if (s.refs.length === 0) {
      violations.push({ heading: s.heading, line: s.line, reason: `缺圖引用：功能標題底下沒有 ![說明](${SA_IMAGES_DIR}/<檔名>)` });
      continue;
    }
    for (const r of s.refs) {
      const reason = validateImageRef(r.ref, imagesRoot);
      if (reason) violations.push({ heading: s.heading, line: r.line, reason });
    }
  }
  return { ok: violations.length === 0, violations, functionCount: sections.length };
}
