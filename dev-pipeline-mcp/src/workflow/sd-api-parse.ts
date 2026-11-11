// SD 的「API 說明」解析與逐支檢查（sd-structure-check 與 sd-layer-check 共用）。格式以 docs/sasd-standard/SD-範本.md 為準。
import { headingMatches } from "./heading-match.js";
import { parseTable } from "./md-table.js";
import { listHeadings } from "./sa-image-check.js";

export const API_SECTION_NAME = "API說明";
export const LAYER_NAMES = ["Controller", "Service", "Repository"] as const;
export type LayerName = (typeof LAYER_NAMES)[number];
/** 分層標籤的中文對照（寫在角色說明，SD 文件裡標籤沿用英文）。 */
export const LAYER_ZH: Readonly<Record<LayerName, string>> = { Controller: "控制層", Service: "服務層", Repository: "查詢層" };
export const HTTP_METHODS: readonly string[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
export const NO_COMMON_METHOD = "無";

export interface LayerDecl {
  /** 宣告的檔案路徑（相對於專案目錄）。 */
  file: string;
  /** 宣告的方法名稱（不含括號）。 */
  methods: string[];
}

export interface SdApi {
  title: string;
  line: number;
  url: string | null;
  method: string | null;
  layers: Partial<Record<LayerName, LayerDecl | "invalid">>;
  /** 「使用的共用方法」欄原文；沒有這一行為 null。 */
  commonMethods: string | null;
  /** 各子章節（INPUT、業務邏輯、OUTPUT）的內容；沒有該小節為 null。 */
  subsections: { input: string | null; logic: string | null; output: string | null };
}

const noSpace = (s: string): string => s.replace(/\s+/g, "");
const clean = (s: string): string => s.replace(/[`*]/g, "").trim();
const LABEL_RE = /^\s*\*\*([^*:：]+?)[:：]?\*\*\s*[:：]?\s*(.*)$/;
const LAYER_VALUE_RE = /^(.+?)\s*──\s*(.+)$/;
const METHOD_NAME_RE = /([A-Za-z_$][\w$]*)\s*\(/g;

function parseLayer(value: string): LayerDecl | "invalid" {
  const m = LAYER_VALUE_RE.exec(clean(value));
  if (!m) return "invalid";
  const file = m[1].trim();
  const methods = [...m[2].matchAll(METHOD_NAME_RE)].map((x) => x[1]);
  return /\.[A-Za-z0-9]+$/.test(file) && !/\s/.test(file) && methods.length > 0 ? { file, methods } : "invalid";
}

type Head = { level: number; title: string; line: number };

/** 取出某個小節（#### 標題以 name 開頭）到下一個 #### 以上標題之前的內容。 */
function subsection(lines: string[], heads: Head[], from: number, to: number, name: string): string | null {
  const at = heads.findIndex((h) => h.line > from && h.line < to && h.level === 4 && headingMatches(h.title, name));
  if (at < 0) return null;
  const end = heads.slice(at + 1).find((h) => h.level <= 4);
  return lines.slice(heads[at].line, end && end.line < to ? end.line - 1 : to - 1).join("\n");
}

/** 解析「## API 說明」底下每一支 API（### 標題）；沒有 API 說明章節回 null。 */
export function parseSdApis(text: string): SdApi[] | null {
  const heads = listHeadings(text);
  const at = heads.findIndex((h) => h.level === 2 && headingMatches(noSpace(h.title), API_SECTION_NAME));
  if (at < 0) return null;
  const lines = text.split(/\r\n|\r|\n/);
  const endH2 = heads.slice(at + 1).find((h) => h.level <= 2);
  const sectionEnd = endH2 ? endH2.line : lines.length + 1;
  const apiHeads = heads.filter((h) => h.level === 3 && h.line > heads[at].line && h.line < sectionEnd);
  return apiHeads.map((h, i) => {
    const end = apiHeads[i + 1]?.line ?? sectionEnd;
    const api: SdApi = { title: h.title, line: h.line, url: null, method: null, layers: {}, commonMethods: null, subsections: { input: null, logic: null, output: null } };
    for (const raw of lines.slice(h.line, end - 1)) {
      if (/^#{1,6}\s/.test(raw)) break;
      const m = LABEL_RE.exec(raw);
      if (!m) continue;
      const [label, value] = [m[1].trim().toUpperCase(), m[2].trim()];
      if (label === "URL") api.url = clean(value);
      else if (label === "METHOD") api.method = clean(value);
      else if (label === "使用的共用方法") api.commonMethods = clean(value);
      else {
        const layer = LAYER_NAMES.find((n) => n.toUpperCase() === label);
        if (layer) api.layers[layer] = parseLayer(value);
      }
    }
    api.subsections = { input: subsection(lines, heads, h.line, end, "INPUT"), logic: subsection(lines, heads, h.line, end, "業務邏輯"), output: subsection(lines, heads, h.line, end, "OUTPUT") };
    return api;
  });
}

/** 「使用的共用方法」欄拆成方法名稱：括號內的補充說明略過，以頓號、逗號分隔。 */
export function splitCommonMethods(value: string): string[] {
  return value.replace(/[（(][^）)]*[）)]/g, "").split(/[、,，;；]/).map((s) => s.trim()).filter(Boolean);
}

const INPUT_HEADER: readonly string[] = ["ElementName", "ElementType", "必填", "對應 DB 欄位", "註解"];

/** 逐支 API 的必備項目檢查；knownCommon 是共用方法清單裡的方法名稱。 */
export function checkSdApis(apis: readonly SdApi[], knownCommon: ReadonlySet<string>, file: string): string[] {
  if (apis.length === 0) return [`${file}「API 說明」底下沒有任何 API（每支 API 一個 ### 標題）`];
  const out: string[] = [];
  for (const a of apis) {
    const w = `${file} API「${a.title}」`;
    if (!a.url || !a.url.startsWith("/")) out.push(`${w}缺少 **URL:**（要以 / 開頭的路徑）`);
    if (!a.method || !HTTP_METHODS.includes(a.method)) out.push(`${w}缺少 **METHOD:**（${HTTP_METHODS.join("／")}）`);
    for (const l of LAYER_NAMES) {
      const d = a.layers[l];
      if (d === undefined) out.push(`${w}缺少 **${l}:**（${LAYER_ZH[l]}的檔案與方法）`);
      else if (d === "invalid") out.push(`${w}的 **${l}:** 格式不對，要寫「檔案路徑 ── 方法名稱()」（例如 src/controllers/x.js ── listX()）`);
    }
    if (a.commonMethods === null || a.commonMethods === "") out.push(`${w}缺少 **使用的共用方法:**（沒有就寫「${NO_COMMON_METHOD}」）`);
    else if (a.commonMethods !== NO_COMMON_METHOD) {
      const unknown = splitCommonMethods(a.commonMethods).filter((n) => !knownCommon.has(n));
      if (unknown.length > 0) out.push(`${w}使用的共用方法不在「共用方法清單」裡：${unknown.join("、")}`);
    }
    for (const [key, name] of [["input", "INPUT"], ["logic", "業務邏輯"], ["output", "OUTPUT"]] as const) {
      const body = a.subsections[key];
      if (body === null) out.push(`${w}缺少「#### ${name}」小節`);
      else if (body.trim() === "") out.push(`${w}的「${name}」小節是空的`);
    }
    const table = a.subsections.input === null ? null : parseTable(a.subsections.input);
    if (table && table.header.map(clean).join("|") !== INPUT_HEADER.join("|")) out.push(`${w}的 INPUT 表頭必須是：${INPUT_HEADER.join("｜")}`);
  }
  return out;
}
