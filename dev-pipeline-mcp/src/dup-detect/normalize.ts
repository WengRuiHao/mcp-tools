import type { NormLine } from "./types.js";

interface LangRules {
  line: string[];
  block: Array<[string, string]>;
  quotes: string;
}

const C_LIKE: LangRules = { line: ["//"], block: [["/*", "*/"]], quotes: "\"'`" };
const HTML_LIKE: LangRules = { line: [], block: [["<!--", "-->"]], quotes: "" };

const RULES: Record<string, LangRules> = {
  java: C_LIKE, kt: C_LIKE, js: C_LIKE, jsx: C_LIKE, ts: C_LIKE, tsx: C_LIKE, cs: C_LIKE, go: C_LIKE,
  scss: C_LIKE,
  vue: { line: ["//"], block: [["/*", "*/"], ["<!--", "-->"]], quotes: "" },
  css: { line: [], block: [["/*", "*/"]], quotes: "" },
  py: { line: ["#"], block: [['"""', '"""'], ["'''", "'''"]], quotes: "\"'" },
  sql: { line: ["--"], block: [["/*", "*/"]], quotes: "'" },
  html: HTML_LIKE, xml: HTML_LIKE,
};

/** 支援的副檔名（不含點）。 */
export const SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set(Object.keys(RULES));

const BRACKETS_ONLY = /^[{}()[\];,]+$/;
const IMPORT_LIKE = /^(import\b|package\b|using\b|#include\b|from\s+\S+\s+import\b|export\s+.*\bfrom\s+['"]|(const|let|var)\s+.*=\s*require\(|require\()/;
const BARE_ANNOTATION = /^@\w+(\.\w+)*(\(\s*\))?$/;
const FIELD_DECL = /^(?:(?:public|private|protected|static|final|readonly)\s+)*(?!return\b|throw\b|break\b|continue\b|else\b)[\w<>[\],.?]+\s+\w+;$/;
const ACCESSOR_BODY = /^(return this\.\w+;|this\.\w+ = \w+;)$/;

const BACKSLASH = String.fromCharCode(92);
const escapeRe = (s: string): string => s.replace(/[^\w\s]/g, (c) => BACKSLASH + c);
const triggerCache = new Map<LangRules, RegExp>();

/** 下一個可能開始註解或字串的位置（較長的標記排在前面）。 */
function triggerOf(rules: LangRules): RegExp {
  let re = triggerCache.get(rules);
  if (!re) {
    const alts = [...rules.block.map(([open]) => open), ...rules.line].map(escapeRe);
    if (rules.quotes) alts.push("[" + rules.quotes.split("").map(escapeRe).join("") + "]");
    re = new RegExp(alts.join("|"), "g");
    triggerCache.set(rules, re);
  }
  return re;
}

/** 從 from 起掃描字串內容，回傳結尾引號之後的位置（未結束則為行尾）。 */
function skipQuoted(raw: string, from: number, quote: string): number {
  let i = from;
  while (i < raw.length) {
    if (raw[i] === BACKSLASH) i += 2;
    else if (raw[i++] === quote) return i;
  }
  return raw.length;
}

/** 去掉註解，回傳每一行剩下的程式碼（行數與輸入相同，註解行變成空字串）。 */
export function stripComments(text: string, ext: string): string[] {
  const rules = RULES[ext.toLowerCase().replace(/^\./, "")];
  const lines = text.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/);
  if (!rules) return lines;
  const trigger = triggerOf(rules);
  let inBlock: [string, string] | null = null;
  return lines.map((raw) => {
    let out = "";
    let i = 0;
    while (i < raw.length) {
      if (inBlock) {
        const end = raw.indexOf(inBlock[1], i);
        if (end < 0) return out;
        i = end + inBlock[1].length;
        inBlock = null;
        continue;
      }
      trigger.lastIndex = i;
      const m = trigger.exec(raw);
      if (!m) return out + raw.slice(i);
      out += raw.slice(i, m.index);
      const token = m[0];
      const opener = rules.block.find(([open]) => open === token);
      if (opener) { inBlock = opener; i = m.index + token.length; continue; }
      if (rules.line.includes(token)) return out;
      const stop = skipQuoted(raw, m.index + 1, token);
      out += raw.slice(m.index, stop);
      i = stop;
    }
    return out;
  });
}

function isBoilerplate(text: string): boolean {
  return (
    BRACKETS_ONLY.test(text) ||
    IMPORT_LIKE.test(text) ||
    BARE_ANNOTATION.test(text) ||
    FIELD_DECL.test(text) ||
    ACCESSOR_BODY.test(text)
  );
}

/**
 * 正規化原始碼：去註解、空白壓成單一空格、去頭尾空白，
 * 並丟棄空行、只有括號的行、import/package/using/require 行、無參數註記、單純欄位宣告與 getter/setter 本體。
 */
export function normalizeSource(text: string, ext: string): NormLine[] {
  const stripped = stripComments(text, ext);
  const result: NormLine[] = [];
  stripped.forEach((code, index) => {
    const normalized = code.replace(/\s+/g, " ").trim();
    if (normalized === "" || isBoilerplate(normalized)) return;
    result.push({ text: normalized, line: index + 1 });
  });
  return result;
}
