// Mermaid erDiagram 解析：實體、屬性（型別 名稱 PK／FK／UK "註解"）、關聯線與基數符號。只支援本流程用到的寫法。

export interface ErAttribute {
  type: string;
  name: string;
  keys: string[];
  comment: string;
}
export interface ErLine {
  left: string;
  /** 左側（父表側）符號：`||`、`|o`、`o|`、`}|`、`}o`。 */
  leftSym: string;
  right: string;
  /** 右側（子表側）符號：`||`、`o|`、`|o`、`|{`、`o{`。 */
  rightSym: string;
  label: string;
  /** 在圖內的第幾行（從 1 起，含 erDiagram 宣告行），供訊息定位。 */
  line: number;
}
export interface ErDiagram {
  entities: Map<string, ErAttribute[]>;
  lines: ErLine[];
  /** 無法辨識的行（訊息用）。 */
  unknown: { line: number; text: string }[];
}

const LINE_RE = /^("?[\w.-]+"?)\s+(\|\||\|o|o\||\}\||\}o)(?:--|\.\.)(\|\||o\||\|o|\|\{|o\{)\s+("?[\w.-]+"?)\s*(?::\s*(.*))?$/;
const ENTITY_OPEN_RE = /^("?[\w.-]+"?)(?:\s*\[[^\]]*\])?\s*\{\s*$/;
const ATTR_RE = /^(\S+)\s+(\S+)(?:\s+((?:PK|FK|UK)(?:\s*,\s*(?:PK|FK|UK))*))?(?:\s+"([^"]*)")?\s*$/i;
const ENTITY_ONLY_RE = /^("?[\w.-]+"?)$/;
const unq = (s: string): string => s.replace(/^"|"$/g, "");

/** 解析 Mermaid erDiagram 全文。 */
export function parseErDiagram(src: string): ErDiagram {
  const out: ErDiagram = { entities: new Map(), lines: [], unknown: [] };
  let current: ErAttribute[] | null = null;
  src.replace(/^﻿/, "").split(/\r\n|\r|\n/).forEach((raw, i) => {
    const t = raw.trim();
    if (t === "" || t.startsWith("%%") || /^erDiagram\b/.test(t) || t === "---") return;
    if (current) {
      if (t === "}") current = null;
      else {
        const a = ATTR_RE.exec(t);
        if (a) current.push({ type: a[1], name: a[2], keys: (a[3] ?? "").split(",").map((k) => k.trim().toUpperCase()).filter(Boolean), comment: a[4] ?? "" });
        else out.unknown.push({ line: i + 1, text: t });
      }
      return;
    }
    const rel = LINE_RE.exec(t);
    const open = ENTITY_OPEN_RE.exec(t);
    if (rel) {
      out.lines.push({ left: unq(rel[1]), leftSym: rel[2], right: unq(rel[4]), rightSym: rel[3], label: (rel[5] ?? "").trim(), line: i + 1 });
      for (const n of [unq(rel[1]), unq(rel[4])]) if (!out.entities.has(n)) out.entities.set(n, []);
    } else if (open) {
      const name = unq(open[1]);
      current = out.entities.get(name) ?? [];
      out.entities.set(name, current);
    } else if (ENTITY_ONLY_RE.test(t)) {
      if (!out.entities.has(unq(t))) out.entities.set(unq(t), []);
    } else out.unknown.push({ line: i + 1, text: t });
  });
  return out;
}
