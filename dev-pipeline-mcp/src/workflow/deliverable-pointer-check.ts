// 正式交付物引用檢查：所有 deliverable=true 的 markdown 不可連結或提及內部過程檔／目錄，圖片只能引用 sa-images/ 或 flow.png。
// 回傳違規逐項說明（空陣列＝合格）。SA／SD 標準檢查已回報過的內部檔名，可由 suppress 抑制，避免同一次交件重複判定。
import { readFileSync } from "node:fs";
import path from "node:path";
import { expandMarkdownFiles, deliverablePaths } from "./deliverable-files.js";
import { INTERNAL_POINTER_TERMS } from "./internal-files.js";
import { eachLine, IMAGE_RE, SA_IMAGES_DIR } from "./sa-image-check.js";
import { termRe } from "./sa-standard-check.js";
import type { WorkflowDefinition } from "./schema.js";

const FLOW_IMAGE = "flow.png";
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const TERM_RES = INTERNAL_POINTER_TERMS.map((t) => ({ term: t, re: termRe(t) }));
const shorten = (t: string): string => (t.trim().length <= 40 ? t.trim() : `${t.trim().slice(0, 39)}…`);

export interface PointerCheckOptions {
  /** 只檢查這些產出物 id（預設全部 deliverable 產出物）。 */
  only?: readonly string[];
  /** 依檔名指定要略過的內部檔名（該檔的標準檢查已回報）。 */
  suppress?: Readonly<Record<string, readonly string[]>>;
}

/** 圖片引用是否為允許的正式交付物：解析成相對工作項目根目錄後必須在 sa-images/ 底下，或就是 flow.png。回傳違規原因，合法回 null。 */
function imageProblem(mdRel: string, ref: string): string | null {
  if (SCHEME_RE.test(ref)) return "外部網址";
  let decoded = ref;
  try {
    decoded = decodeURIComponent(ref);
  } catch {
    return "路徑不合法";
  }
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(mdRel), decoded.split(String.fromCharCode(92)).join("/")));
  if (resolved.startsWith("..") || path.posix.isAbsolute(resolved)) return "超出工作項目目錄";
  return resolved === FLOW_IMAGE || resolved.startsWith(`${SA_IMAGES_DIR}/`) ? null : "不是正式交付物";
}

function checkOneFile(dir: string, rel: string, skipTerms: readonly string[]): string[] {
  const out: string[] = [];
  const text = readFileSync(path.join(dir, rel), "utf-8");
  eachLine(text, (line, lineNo) => {
    let rest = line;
    for (const m of line.matchAll(IMAGE_RE)) {
      const why = imageProblem(rel, m[1]);
      if (why) {
        out.push(`${rel} 第 ${lineNo} 行圖片「${m[1]}」${why}（圖片只能引用 ${SA_IMAGES_DIR}/ 或 ${FLOW_IMAGE} 等正式交付物）`);
        rest = rest.replace(m[0], "");
      }
    }
    for (const t of TERM_RES) {
      if (skipTerms.includes(t.term) || !t.re.test(rest)) continue;
      out.push(`${rel} 第 ${lineNo} 行引用了內部檔「${t.term}」（內部過程檔不交付，正式交付物不可連結或提及）：${shorten(line)}`);
    }
  });
  return out;
}

export function checkDeliverablePointers(dir: string, def: WorkflowDefinition, opts: PointerCheckOptions = {}): string[] {
  return expandMarkdownFiles(dir, deliverablePaths(def, opts.only)).flatMap((rel) => checkOneFile(dir, rel, opts.suppress?.[path.posix.basename(rel)] ?? []));
}
