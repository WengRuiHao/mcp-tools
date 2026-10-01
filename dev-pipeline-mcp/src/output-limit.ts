export interface HeadTailResult {
  text: string;
  truncated: boolean;
  originalChars: number;
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** 取前 n 個 UTF-16 單元，切點落在代理對中間就少取一個，避免產生亂碼。 */
export function safeHead(text: string, n: number): string {
  if (n <= 0) return "";
  if (n >= text.length) return text;
  const end = isHighSurrogate(text.charCodeAt(n - 1)) ? n - 1 : n;
  return text.slice(0, end);
}

function safeTail(text: string, n: number): string {
  if (n <= 0) return "";
  if (n >= text.length) return text;
  let start = text.length - n;
  if (isLowSurrogate(text.charCodeAt(start))) start += 1;
  return text.slice(start);
}

/** 超過 head+tail 時保留頭尾並插入標記；錯誤訊息通常在結尾，所以呼叫端應讓 tail 大於 head。 */
export function truncateHeadTail(text: string, opts: { head: number; tail: number }): HeadTailResult {
  const originalChars = text.length;
  if (originalChars <= opts.head + opts.tail) return { text, truncated: false, originalChars };
  const head = safeHead(text, opts.head);
  const tail = safeTail(text, opts.tail);
  const omitted = originalChars - head.length - tail.length;
  const marker = `\n…（輸出共 ${originalChars} 字，省略中間 ${omitted} 字）…\n`;
  return { text: head + marker + tail, truncated: true, originalChars };
}

export const READ_FILE_MAX_CHARS = 40000;

export type LineSliceResult =
  | { ok: false; message: string }
  | {
      ok: true;
      content: string;
      totalLines: number;
      totalChars: number;
      startLine: number;
      endLine: number;
      returnedLines: number;
      truncated: boolean;
      ranged: boolean;
    };

const isPositiveInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n > 0;

/** 依行範圍／字數上限切檔案內容；字數超限時只在行尾切，不切在行中間（單行本身超限才硬切）。 */
export function sliceFileContent(
  content: string,
  range: { startLine?: number; endLine?: number },
  maxChars = READ_FILE_MAX_CHARS
): LineSliceResult {
  const ranged = range.startLine !== undefined || range.endLine !== undefined;
  const lines = content.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const totalLines = content === "" ? 0 : lines.length;
  const totalChars = content.length;

  if (!ranged && totalChars <= maxChars) {
    return { ok: true, content, totalLines, totalChars, startLine: 1, endLine: totalLines, returnedLines: totalLines, truncated: false, ranged };
  }

  const startLine = range.startLine ?? 1;
  const endLine = range.endLine ?? totalLines;
  if (range.startLine !== undefined && !isPositiveInt(range.startLine)) return { ok: false, message: "startLine 必須是正整數（從 1 起算）" };
  if (range.endLine !== undefined && !isPositiveInt(range.endLine)) return { ok: false, message: "endLine 必須是正整數（從 1 起算）" };
  if (startLine > totalLines) return { ok: false, message: `startLine（${startLine}）超過檔案總行數（${totalLines}）` };
  if (endLine < startLine) return { ok: false, message: `endLine（${endLine}）不可小於 startLine（${startLine}）` };

  const lastWanted = Math.min(endLine, totalLines);
  const picked: string[] = [];
  let used = 0;
  for (let i = startLine - 1; i < lastWanted; i++) {
    const cost = lines[i].length + 1;
    if (used + cost > maxChars && picked.length > 0) break;
    picked.push(lines[i]);
    used += cost;
  }
  let body = picked.join("\n");
  let truncated = startLine - 1 + picked.length < lastWanted;
  if (body.length > maxChars) {
    body = safeHead(body, maxChars);
    truncated = true;
  } else if (picked.length > 0 && (startLine - 1 + picked.length < totalLines || content.endsWith("\n"))) {
    body += "\n";
  }
  return {
    ok: true,
    content: body,
    totalLines,
    totalChars,
    startLine,
    endLine: startLine - 1 + picked.length,
    returnedLines: picked.length,
    truncated,
    ranged,
  };
}
