// 專案層文件段落式寫入（批次 1M）：以「## 標題」為段落單位的切段、取代、新增與段落雜湊。純文字，不讀檔案。
// 段落＝一行以「## 」開頭的標題，到下一個「## 」標題之前（### 以下屬於該段）；程式碼區塊（```）內的 ## 不算標題。
import { createHash } from "node:crypto";

export interface DocSection {
  key: string;
  /** 段落在原文中的範圍（含標題行，到下一段標題之前，包含收尾空白）。 */
  start: number;
  end: number;
}

const HEADING_RE = /^## (?!#)(.+?)\s*$/;

export function parseSections(text: string): DocSection[] {
  const heads: Array<{ key: string; start: number }> = [];
  let inFence = false;
  let offset = 0;
  for (const line of text.split(/(?<=\n)/)) {
    const bare = line.replace(/\r?\n$/, "");
    if (/^\s*(```|~~~)/.test(bare)) inFence = !inFence;
    else if (!inFence) {
      const m = HEADING_RE.exec(bare);
      if (m) heads.push({ key: m[1], start: offset });
    }
    offset += line.length;
  }
  return heads.map((h, i) => ({ key: h.key, start: h.start, end: i + 1 < heads.length ? heads[i + 1].start : text.length }));
}

/** 段落全文（含標題，去掉收尾空白）；不存在回 undefined。 */
export function getSection(text: string, key: string): string | undefined {
  const s = parseSections(text).find((x) => x.key === key);
  return s ? text.slice(s.start, s.end).trimEnd() : undefined;
}

/** 段落雜湊：寫入時帶回 expectedSectionSha256 做版本比對；只受該段內容影響。 */
export function sectionSha256(section: string): string {
  return createHash("sha256").update(section.trimEnd().replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

/** 內容必須剛好是一個段落、且標題等於 key；回傳 key，否則丟錯。 */
export function singleSectionKey(content: string, expectedKey: string): string {
  const secs = parseSections(content);
  if (secs.length !== 1 || content.slice(0, secs[0].start).trim() !== "") throw new Error(`section 寫入的內容必須剛好一個「## 標題」段落（不可有前言或多個段落），實際找到 ${secs.length} 個`);
  if (secs[0].key !== expectedKey) throw new Error(`內容的標題「## ${secs[0].key}」與 section「${expectedKey}」不符`);
  return secs[0].key;
}

/** 取代既有段落（保留原本的收尾空白，其他段落與前言逐字不變）；key 不存在就接在最後。 */
export function replaceSection(text: string, key: string, newSection: string): string {
  const body = newSection.trimEnd();
  const found = parseSections(text).find((x) => x.key === key);
  if (!found) return text.trim() === "" ? `${body}\n` : `${text.trimEnd()}\n\n${body}\n`;
  const old = text.slice(found.start, found.end);
  const trailing = old.slice(old.trimEnd().length);
  return text.slice(0, found.start) + body + trailing + text.slice(found.end);
}
