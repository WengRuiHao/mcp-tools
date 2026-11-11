// S6：SA 截圖自動檢查（關卡 sa-content-check／check id sa-mockup-screenshot）。
// 純函式＋檔案讀取，不寫檔。標題約定常數與說明字串供 SA 角色說明（S7）共用。
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { headingMatches } from "./heading-match.js";

export const SA_FILE_NAME = "01-sa.md";
export const SA_IMAGES_DIR = "sa-images";
export const ALLOWED_IMAGE_EXTENSIONS: readonly string[] = ["png", "jpg", "jpeg", "webp"];

/** 給 SA 角色說明引用的約定說明。 */
export const SA_IMAGE_CONVENTION_TEXT = [
  `${SA_FILE_NAME} 至少要有一張畫面圖：\`![說明](${SA_IMAGES_DIR}/<檔名>)\`。`,
  `所有圖片引用都必須有效：圖檔存在於工作項目的 ${SA_IMAGES_DIR}/ 下、副檔名為 ${ALLOWED_IMAGE_EXTENSIONS.join("／")}、檔案大小大於 0。`,
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
  imageCount: number;
}

export const HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
export const IMAGE_RE = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/** 回傳違規原因；合法則回 null（含檔案存在、副檔名、非空檢查）。dirName 預設為 SA 圖目錄，測試證據檢查傳 evidence。 */
export function validateImageRef(rawRef: string, imagesRoot: string, dirName: string = SA_IMAGES_DIR): string | null {
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
  if (segments[0] !== dirName || segments.length < 2 || segments.some((s) => s === "")) {
    return bad(`只認 ${dirName}/ 相對路徑`);
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

export interface Section {
  heading: string;
  line: number;
  refs: { ref: string; line: number }[];
}

/** 圍欄行事件：opening 為開啟或關閉、info 為開啟圍欄後的語言標記文字。 */
export type FenceEvent = (info: string, lineNo: number, opening: boolean) => void;

/** 逐行走訪 markdown，略過程式碼區塊（含圍欄行本身）；可選的 onFence 會收到每個圍欄行（供需要偵測程式碼區塊的檢查使用）。 */
export function eachLine(text: string, visit: (line: string, lineNo: number) => void, onFence?: FenceEvent): void {
  let fence: string | null = null;
  text.split(/\r\n|\r|\n/).forEach((line, idx) => {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fenceMatch) {
      const mark = fenceMatch[1][0];
      if (fence === null) {
        fence = mark;
        onFence?.(fenceMatch[2].trim(), idx + 1, true);
      } else if (fence === mark) {
        fence = null;
        onFence?.("", idx + 1, false);
      }
      return;
    }
    if (fence === null) visit(line, idx + 1);
  });
}

/** 列出所有標題（略過程式碼區塊）。 */
export function listHeadings(text: string): { level: number; title: string; line: number }[] {
  const out: { level: number; title: string; line: number }[] = [];
  eachLine(text, (line, lineNo) => {
    const h = HEADING_RE.exec(line);
    if (h) out.push({ level: h[1].length, title: h[2].trim(), line: lineNo });
  });
  return out;
}

/** 掃描 markdown，切出每個「以 prefix 開頭、層級在 levels 內」的標題範圍並收集範圍內的圖片引用（略過程式碼區塊）。 */
export function collectSections(text: string, prefix: string, levels: readonly number[]): Section[] {
  const sections: Section[] = [];
  let current: { level: number; section: Section } | null = null;
  eachLine(text, (line, lineNo) => {
    const h = HEADING_RE.exec(line);
    if (h) {
      const level = h[1].length;
      const title = h[2].trim();
      if (current && level <= current.level) current = null;
      if (levels.includes(level) && headingMatches(title, prefix)) {
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

/** 全文所有圖片引用（略過程式碼區塊），附上所在的最近標題。 */
function collectImageRefs(text: string): { ref: string; line: number; heading: string }[] {
  const refs: { ref: string; line: number; heading: string }[] = [];
  let heading = "";
  eachLine(text, (line, lineNo) => {
    const h = HEADING_RE.exec(line);
    if (h) heading = h[2].trim();
    for (const m of line.matchAll(IMAGE_RE)) refs.push({ ref: m[1], line: lineNo, heading });
  });
  return refs;
}

/** 至少一張圖（畫面），且所有圖片引用都有效。 */
export function checkSaImages(workItemDir: string): SaImageCheckResult {
  const saPath = path.join(workItemDir, SA_FILE_NAME);
  if (!existsSync(saPath)) {
    throw new Error(`找不到 ${SA_FILE_NAME}（${saPath}），無法檢查 SA 截圖；請先完成 SA 規格。`);
  }
  const refs = collectImageRefs(readFileSync(saPath, "utf-8"));
  if (refs.length === 0) {
    return { ok: false, imageCount: 0, violations: [{ heading: "", line: 0, reason: `至少要有一張圖（畫面）：![說明](${SA_IMAGES_DIR}/<檔名>)` }] };
  }
  const imagesRoot = path.resolve(workItemDir, SA_IMAGES_DIR);
  const violations = refs.flatMap((r) => {
    const reason = validateImageRef(r.ref, imagesRoot);
    return reason ? [{ heading: r.heading, line: r.line, reason }] : [];
  });
  return { ok: violations.length === 0, violations, imageCount: refs.length };
}