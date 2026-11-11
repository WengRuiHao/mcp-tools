// 步驟 C：mockup 可操作性檢查（mockup 設計師 done 時）。純靜態檢查，不執行頁面。
// sa-mockup/ 內至少一個 html；每個 html 要有 script 且含事件處理、不可連外網、要有 data-demo-states 標記、大小有上限。
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const MOCKUP_DIR = "sa-mockup";
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

const stripComments = (text: string): string => text.replace(/<!--[\s\S]*?-->/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

function listHtml(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
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
  const states = DEMO_STATES_VALUE_RE.exec(body);
  if (states) {
    const missing = missingDemoStates(states[1] ?? states[2] ?? "");
    if (missing.length > 0) out.push(`${name} 的 ${DEMO_STATES_ATTR} 缺少必備狀態：${missing.join("、")}（五種都要有：${REQUIRED_DEMO_STATES.map((r) => `${r.label}＝${r.names.join("／")}`).join("；")}）`);
  } else if (!new RegExp(`${DEMO_STATES_ATTR}\\s*=`, "i").test(body)) out.push(`${name} 缺少 ${DEMO_STATES_ATTR} 標記（例如 <body ${DEMO_STATES_ATTR}="normal,loading,success,failed,empty">，列出可用網址 #狀態名稱 切換的狀態）`);
  return out;
}

/** 檢查工作項目目錄下的 sa-mockup/；資料夾不存在由一般交件檢查回報，這裡回空陣列。 */
export function checkMockupDir(workItemDir: string): string[] {
  const root = path.join(workItemDir, MOCKUP_DIR);
  try {
    if (!statSync(root).isDirectory()) return [];
  } catch {
    return [];
  }
  const files = listHtml(root);
  if (files.length === 0) return [`${MOCKUP_DIR}/ 內至少要有一個 html 檔`];
  return files.flatMap((f) => {
    const rel = path.relative(workItemDir, f).split(path.sep).join("/");
    const html = readFileSync(f, "utf-8");
    return checkMockupHtml(html, rel, { htmlPath: f, root });
  });
}
