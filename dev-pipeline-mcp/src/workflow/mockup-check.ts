// 步驟 C：mockup 可操作性檢查（mockup 設計師 done 時）。純靜態檢查，不執行頁面。
// sa-mockup/ 內至少一個 html；每個 html 要有 script 且含事件處理、不可連外網、要有 data-demo-states 標記、大小有上限；
// 要有「本次變更說明」區塊，且不可用偽元素／絕對定位／虛線框把新增變更標示疊在元件上。
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const MOCKUP_DIR = "sa-mockup";
/** 落選的風格候選檔移到這個子資料夾（以 _ 開頭的資料夾不納入檢查）。 */
export const CANDIDATES_DIR = "_candidates";
/** 風格候選檔檔名（sa-mockup/ 主目錄內）。 */
export const STYLE_FILE_RE = /^style-[^/\\]+\.html$/i;
export const MOCKUP_MAX_BYTES = 512 * 1024;
export const DEMO_STATES_ATTR = "data-demo-states";
/** 五種必備狀態與容許的名稱寫法（比對時忽略大小寫、底線與連字號）。 */
export const REQUIRED_DEMO_STATES: readonly { label: string; names: readonly string[] }[] = [
  { label: "正常", names: ["正常", "normal"] },
  { label: "載入中", names: ["載入中", "loading"] },
  { label: "成功", names: ["成功", "success"] },
  { label: "失敗", names: ["失敗", "error", "failed", "failure", "fail"] },
  { label: "沒有資料", names: ["沒有資料", "無資料", "empty", "nodata"] },
];
const DEMO_STATES_VALUE_RE = new RegExp(`${DEMO_STATES_ATTR}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i");
const normalizeState = (s: string): string => s.trim().toLowerCase().replace(/[\s_-]/g, "");

/** 缺少的必備狀態（label 清單）；values 是 data-demo-states 的值。 */
export function missingDemoStates(values: string): string[] {
  const have = new Set(values.split(/[,，、;；]/).map(normalizeState).filter(Boolean));
  return REQUIRED_DEMO_STATES.filter((r) => !r.names.some((n) => have.has(normalizeState(n)))).map((r) => r.label);
}

const SCRIPT_TAG_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const SCRIPT_SRC_RE = /\bsrc\s*=\s*["']?([^"'\s>]+)/i;
const ADD_LISTENER_RE = /\.addEventListener\s*\(/;
const INLINE_HANDLER_RE = /<[a-z][^>]*\son[a-z]+\s*=\s*["']/i;
/** 外部網路資源：src／href 屬性、@import、url() 指向 http://、https:// 或 // 開頭。data: 與相對路徑允許。 */
const EXTERNAL_RES: readonly { re: RegExp; label: string }[] = [
  { re: /\b(?:src|href)\s*=\s*["']?\s*(?:https?:)?\/\/[^\s"'>]+/gi, label: "src／href" },
  { re: /@import\s+(?:url\(\s*)?["']?\s*(?:https?:)?\/\/[^\s"')]+/gi, label: "@import" },
  { re: /url\(\s*["']?\s*(?:https?:)?\/\/[^\s"')]+/gi, label: "url()" },
];

/** 移除註解但保留換行，讓後續報的行號與原檔一致。 */
const stripComments = (text: string): string => text.replace(/<!--[\s\S]*?-->|\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ""));

export const CHANGE_NOTES_TITLE = "本次變更說明";
const CHANGE_NOTES_RE = /<h([1-6])\b[^>]*>(?:(?!<\/h\1\s*>)[\s\S])*?本次變更說明/i;
const STYLE_TAG_RE = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;
const CSS_RULE_RE = /([^{}]+)\{([^{}]*)\}/g;
/** 「標示用途」的 class 名稱片語（以 - _ 切開整詞比對；不含 label，避免誤擋表單欄位標籤）。 */
const MARKER_TOKENS = new Set(["badge", "tag", "mark", "marker", "changed", "new", "diff", "annotation", "ribbon"]);
const OVERLAY_HINT = `改成放在頁面卡片外獨立的「${CHANGE_NOTES_TITLE}」區塊，不要疊在正式元件上`;

const lineAt = (text: string, index: number): number => text.slice(0, index).split("\n").length;
const markerClasses = (selector: string): string[] =>
  [...selector.matchAll(/\.(-?[_a-z][\w-]*)/gi)].map((m) => m[1]).filter((c) => c.toLowerCase().split(/[-_]+/).some((t) => MARKER_TOKENS.has(t)));

/** 最明確的「標示疊在正式元件上」寫法：偽元素 content 含新增／變更／修改；或標示用 class 以 absolute／fixed 搭配負偏移，或用虛線框。 */
export function findOverlayMarks(html: string, name: string): string[] {
  const out: string[] = [];
  for (const style of html.matchAll(STYLE_TAG_RE)) {
    const base = (style.index ?? 0) + style[0].indexOf(style[1]);
    for (const rule of style[1].matchAll(CSS_RULE_RE)) {
      const selector = rule[1].trim();
      const decl = rule[2];
      const at = `${name} 第 ${lineAt(html, base + (rule.index ?? 0) + rule[1].search(/\S/))} 行 CSS「${selector.slice(0, 40)}」`;
      if (/::?(?:before|after)\b/i.test(selector) && /\bcontent\s*:\s*(["'])[^"']*(?:新增|變更|修改)/i.test(decl)) {
        out.push(`${at}用偽元素（::before／::after）顯示「新增／變更／修改」標示；${OVERLAY_HINT}`);
        continue;
      }
      const marks = markerClasses(selector);
      if (marks.length === 0) continue;
      if (/\bposition\s*:\s*(?:absolute|fixed)\b/i.test(decl) && /\b(?:top|left|right|bottom)\s*:\s*-/i.test(decl)) out.push(`${at}（class ${marks.join("、")}）用絕對定位加負偏移把標示疊在其他元件上；${OVERLAY_HINT}`);
      else if (/\b(?:outline|border)(?:-[a-z]+)*\s*:[^;]*\bdashed\b/i.test(decl)) out.push(`${at}（class ${marks.join("、")}）用虛線框標示新增或變更；${OVERLAY_HINT}`);
    }
  }
  return out;
}

function listHtml(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!e.name.startsWith("_")) walk(full);
      }
      else if (e.isFile() && /\.html?$/i.test(e.name)) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

/** 這個 html 的全部 script 內容：行內 script 加上相對路徑引用且存在的 js 檔。 */
function scriptText(html: string, htmlPath: string, root: string): { hasScript: boolean; code: string } {
  let hasScript = false;
  let code = "";
  for (const m of html.matchAll(SCRIPT_TAG_RE)) {
    hasScript = true;
    code += `\n${m[2]}`;
    const src = SCRIPT_SRC_RE.exec(m[1])?.[1];
    if (!src || /^[a-z][a-z0-9+.-]*:|^\/\//i.test(src)) continue;
    const file = path.resolve(path.dirname(htmlPath), src.split(/[?#]/)[0]);
    if (path.relative(root, file).startsWith("..")) continue;
    try {
      code += `\n${readFileSync(file, "utf-8")}`;
    } catch {
      /* 引用的檔案不存在：視為沒有內容 */
    }
  }
  return { hasScript, code };
}

/** 檢查單一 html 的內容；name 只用於訊息。 */
export function checkMockupHtml(html: string, name: string, where?: { htmlPath: string; root: string }): string[] {
  const out: string[] = [];
  const bytes = Buffer.byteLength(html, "utf-8");
  if (bytes > MOCKUP_MAX_BYTES) out.push(`${name} 超過大小上限 ${MOCKUP_MAX_BYTES / 1024}KB（目前 ${Math.ceil(bytes / 1024)}KB）`);
  const body = stripComments(html);
  const { hasScript, code: scripts } = scriptText(body, where?.htmlPath ?? name, where?.root ?? path.dirname(name));
  if (!hasScript) out.push(`${name} 沒有 <script>：mockup 必須是可操作的原型，不能只有靜態頁面`);
  else if (!ADD_LISTENER_RE.test(scripts) && !INLINE_HANDLER_RE.test(body)) out.push(`${name} 沒有事件處理（addEventListener 或 onclick 等 on 事件屬性），使用者動作都要能點`);
  for (const r of EXTERNAL_RES) {
    const hit = body.match(r.re);
    if (hit) out.push(`${name} 含外部網路資源（${r.label}）：${hit[0].slice(0, 60)}；不可連外網，只允許 data: 與相對路徑`);
  }
  out.push(...findOverlayMarks(body, name));
  if (!CHANGE_NOTES_RE.test(body)) out.push(`${name} 缺少「${CHANGE_NOTES_TITLE}」區塊（頁面卡片外放一個標題含「${CHANGE_NOTES_TITLE}」的區塊，列出新增與改動的既有行為；沒有變更也要保留並寫「無既有行為變更」）`);
  const states = DEMO_STATES_VALUE_RE.exec(body);
  if (states) {
    const missing = missingDemoStates(states[1] ?? states[2] ?? "");
    if (missing.length > 0) out.push(`${name} 的 ${DEMO_STATES_ATTR} 缺少必備狀態：${missing.join("、")}（五種都要有：${REQUIRED_DEMO_STATES.map((r) => `${r.label}＝${r.names.join("／")}`).join("；")}）`);
  } else if (!new RegExp(`${DEMO_STATES_ATTR}\\s*=`, "i").test(body)) out.push(`${name} 缺少 ${DEMO_STATES_ATTR} 標記（例如 <body ${DEMO_STATES_ATTR}="normal,loading,success,failed,empty">，列出可用網址 #狀態名稱 切換的狀態）`);
  return out;
}

export interface MockupDirOptions {
  /** 全新待選風格已選定時的檔名：主目錄只能留下這個風格檔（其他畫面檔不受限）。 */
  selectedStyle?: string | undefined;
}

/** 已選定風格後的主目錄規則：style-*.html 只能是被選中的那個。 */
function checkSelectedStyle(root: string, selected: string): string[] {
  const styles = readdirSync(root, { withFileTypes: true }).filter((e) => e.isFile() && STYLE_FILE_RE.test(e.name)).map((e) => e.name);
  const out: string[] = [];
  if (!styles.includes(selected)) out.push(`${MOCKUP_DIR}/ 找不到使用者已選定的風格檔 ${selected}`);
  const extra = styles.filter((n) => n !== selected);
  if (extra.length > 0) out.push(`${MOCKUP_DIR}/ 已選定風格 ${selected}，主目錄不可再有其他風格候選檔（${extra.join("、")}）；落選的請移到 ${MOCKUP_DIR}/${CANDIDATES_DIR}/`);
  return out;
}

/** 檢查工作項目目錄下的 sa-mockup/（略過 _ 開頭的子資料夾）；資料夾不存在由一般交件檢查回報，這裡回空陣列。 */
export function checkMockupDir(workItemDir: string, opts: MockupDirOptions = {}): string[] {
  const root = path.join(workItemDir, MOCKUP_DIR);
  try {
    if (!statSync(root).isDirectory()) return [];
  } catch {
    return [];
  }
  const files = listHtml(root);
  if (files.length === 0) return [`${MOCKUP_DIR}/ 內至少要有一個 html 檔`];
  const selectedProblems = opts.selectedStyle ? checkSelectedStyle(root, opts.selectedStyle) : [];
  return [...selectedProblems, ...files.flatMap((f) => {
    const rel = path.relative(workItemDir, f).split(path.sep).join("/");
    const html = readFileSync(f, "utf-8");
    return checkMockupHtml(html, rel, { htmlPath: f, root });
  })];
}
