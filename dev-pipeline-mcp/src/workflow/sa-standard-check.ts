// SA 新標準檢查（客戶版 SA，格式以 docs/sasd-standard/SA-範本.md 為準）。純文字檢查，回傳違規逐項說明（空陣列＝合格）。
// 與 sa-image-check（圖片引用有效性）、sa-no-code-check（程式碼與 SQL）並行；圖檔是否存在由 sa-image-check 負責，這裡只看提示狀態標籤後面有沒有圖片引用。
import { headingMatches, stripHeadingNumber } from "./heading-match.js";
import { parseTable } from "./md-table.js";
import { extractSection } from "./reuse-record-check.js";
import { eachLine, HEADING_RE, IMAGE_RE, listHeadings, SA_FILE_NAME } from "./sa-image-check.js";
import { checkVersionHistory, VERSION_HISTORY_HEADER } from "./version-history-check.js";

export const REQUIRED_SECTIONS: readonly string[] = ["功能目的", "畫面", "操作說明"];
export const TIP_HEADING_WORD = "提示";
/** 基本資料表至少要有的項目。 */
export const BASIC_INFO_ITEMS: readonly string[] = ["功能名稱", "文件版次"];

/** 客戶版 SA 的禁用詞；ASCII 詞以不連著其他英文字母為準（避免 RAPID 命中 API）。 */
export const FORBIDDEN_TERMS: readonly string[] = ["已確認的決定", "依據附錄", "純後端", "共用畫面元件", "mockup", "API", "SQL", "前端工程師", "後端工程師", "交給前端", "通知前端"];
/** 內部過程檔名，不可出現在正式交付物。 */
export const INTERNAL_FILE_TERMS: readonly string[] = ["01-sa", "02-db", "03-sd", "spec-check", "sa-notes", ".dev-pipeline"];
/** 說明「這段文字為什麼存在」的後設句。 */
const META_SENTENCES: readonly { re: RegExp; label: string }[] = [
  { re: /本節說明[^。\n]*為什麼/, label: "本節說明…為什麼" },
  { re: /(?:這裡|此處)只列/, label: "這裡只列…" },
  { re: /本(?:文件|節|段)(?:的)?(?:目的|用途)(?:是|為)/, label: "說明本文件或本節的用途" },
  { re: /這(?:段|節)文字(?:是為了|為什麼|存在)/, label: "說明這段文字為什麼存在" },
];

const isAscii = (t: string): boolean => /^[\x20-\x7e]+$/.test(t);
const termRe = (t: string): RegExp => (isAscii(t) ? new RegExp(`(?<![A-Za-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`, "i") : new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
const FORBIDDEN_RES = FORBIDDEN_TERMS.map((t) => ({ term: t, re: termRe(t), kind: "禁用詞" }));
const INTERNAL_RES = INTERNAL_FILE_TERMS.map((t) => ({ term: t, re: termRe(t), kind: "內部檔名" }));

const shorten = (t: string): string => (t.trim().length <= 40 ? t.trim() : `${t.trim().slice(0, 39)}…`);

function checkSections(text: string): string[] {
  const out: string[] = [];
  const heads = listHeadings(text);
  const lines: number[] = [];
  for (const name of REQUIRED_SECTIONS) {
    const h = heads.find((x) => x.level === 2 && headingMatches(x.title, name));
    const body = extractSection(text, name);
    if (!h || body === null) out.push(`${SA_FILE_NAME} 缺少必備章節「## ${name}」（章節順序：${REQUIRED_SECTIONS.join("→")}→各種規則→匯出內容→提示）`);
    else if (body.trim() === "") out.push(`${SA_FILE_NAME}「${name}」章節是空的，不可有空洞章節`);
    else lines.push(h.line);
  }
  if (lines.length === REQUIRED_SECTIONS.length && lines.some((l, i) => i > 0 && l < lines[i - 1])) out.push(`${SA_FILE_NAME} 章節順序不對，必備章節要依序是：${REQUIRED_SECTIONS.join("→")}`);
  return out;
}

function checkBasicInfo(text: string): string[] {
  const firstH2 = listHeadings(text).find((h) => h.level === 2);
  const head = text.split(/\r\n|\r|\n/).slice(0, firstH2 ? firstH2.line - 1 : undefined).join("\n");
  const table = parseTable(head);
  if (table === null) return [`${SA_FILE_NAME} 開頭缺少基本資料表（項目｜內容：${BASIC_INFO_ITEMS.join("、")}、系統分析者、審查者）`];
  const items = table.rows.map((r) => (r[0] ?? "").replace(/[`*_\s]/g, ""));
  const missing = BASIC_INFO_ITEMS.filter((i) => !items.includes(i));
  return missing.length > 0 ? [`${SA_FILE_NAME} 基本資料表缺少項目：${missing.join("、")}`] : [];
}

/** 版本管控歷程以外、第一個二級標題之後的表格數（規則、欄位、格式類內容的表格）。 */
function countRuleTables(text: string): number {
  const firstH2 = listHeadings(text).find((h) => h.level === 2);
  const blocks: { start: number; rows: string[] }[] = [];
  let cur: { start: number; rows: string[] } | null = null;
  eachLine(text, (line, lineNo) => {
    if (line.trim().startsWith("|")) {
      if (!cur) blocks.push((cur = { start: lineNo, rows: [] }));
      cur.rows.push(line);
    } else cur = null;
  });
  return blocks.filter((b) => firstH2 !== undefined && b.start > firstH2.line && (parseTable(b.rows.join("\n"))?.header ?? []).map((c) => c.trim()).join("|") !== VERSION_HISTORY_HEADER.join("|")).length;
}

function checkWording(text: string): string[] {
  const out: string[] = [];
  eachLine(text, (line, lineNo) => {
    for (const t of [...FORBIDDEN_RES, ...INTERNAL_RES]) if (t.re.test(line)) out.push(`${SA_FILE_NAME} 第 ${lineNo} 行出現${t.kind}「${t.term}」（SA 是客戶版，不可有工程用語與內部檔名）：${shorten(line)}`);
    for (const m of META_SENTENCES) if (m.re.test(line)) out.push(`${SA_FILE_NAME} 第 ${lineNo} 行有後設句（${m.label}），客戶版不寫說明文件用途的句子：${shorten(line)}`);
  });
  return out;
}

const BOLD_LABEL_RE = /^\s*\*\*([^*]+)\*\*(.*)$/;
/** 標籤後面直接用冒號接說明文字者（例如導向其他頁面），沒有畫面訊息可截圖，不要求附圖。 */
const INLINE_EXPLANATION_RE = /^\s*[：:]\s*\S/;

interface TipLabel {
  label: string;
  line: number;
  hasImage: boolean;
}

/** 收集每個「提示」章節底下的粗體狀態標籤，以及各標籤到下一個標籤之前有沒有圖片引用。 */
function tipLabels(text: string): { tips: number; labels: TipLabel[]; emptyTips: string[] } {
  const heads = listHeadings(text);
  const tipHeads = heads.filter((h) => h.level >= 2 && h.level <= 4 && stripHeadingNumber(h.title).includes(TIP_HEADING_WORD));
  const lines = text.split(/\r\n|\r|\n/);
  const labels: TipLabel[] = [];
  const emptyTips: string[] = [];
  for (const h of tipHeads) {
    const end = heads.slice(heads.indexOf(h) + 1).find((x) => x.level <= h.level);
    const found: TipLabel[] = [];
    let current: TipLabel | null = null;
    eachLine(lines.slice(h.line, end ? end.line - 1 : lines.length).join("\n"), (line, rel) => {
      if (HEADING_RE.test(line)) return;
      const m = BOLD_LABEL_RE.exec(line);
      if (m) {
        current = { label: m[1].trim(), line: h.line + rel, hasImage: INLINE_EXPLANATION_RE.test(m[2]) };
        found.push(current);
      }
      if (current && [...line.matchAll(IMAGE_RE)].length > 0) current.hasImage = true;
    });
    if (found.length === 0) emptyTips.push(h.title);
    labels.push(...found);
  }
  return { tips: tipHeads.length, labels, emptyTips };
}

function checkTips(text: string): string[] {
  const { labels, emptyTips } = tipLabels(text);
  return [
    ...emptyTips.map((t) => `${SA_FILE_NAME}「${t}」章節沒有用粗體標籤列出任何提示狀態（每個狀態一行 **標籤**，下面附該狀態的畫面截圖）`),
    ...labels.filter((l) => !l.hasImage).map((l) => `${SA_FILE_NAME} 第 ${l.line} 行提示狀態「${l.label}」後面沒有畫面截圖（警告訊息要用 mockup 截的實際畫面，不可用文字表格代替）`),
  ];
}

/** 檢查 01-sa.md 全文是否符合 SA 新標準。 */
export function checkSaStandard(text: string): string[] {
  const problems = [...checkSections(text), ...checkBasicInfo(text), ...checkVersionHistory(text, SA_FILE_NAME)];
  if (countRuleTables(text) === 0) problems.push(`${SA_FILE_NAME} 沒有任何規則表格（規則、欄位、格式類內容一律用表格）`);
  problems.push(...checkWording(text), ...checkTips(text));
  return problems;
}
