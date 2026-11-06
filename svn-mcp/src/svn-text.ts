/**
 * 解碼 svn 指令輸出的「人類可讀文字」（非 --xml）。
 *
 * Windows 上的 svn.exe 會把訊息、日期、路徑轉成系統內碼頁（繁中系統是 cp950／Big5），
 * 但 `svn diff` 的內文是檔案原始位元組（通常是 UTF-8）——同一份輸出可能兩種編碼混在一起。
 * 直接當 UTF-8 解會讓 cp950 的行變成亂碼（�）。
 *
 * 做法：逐行判斷，該行是合法 UTF-8 就照用，否則用 Big5 解。換行位元組 0x0A 不會出現在
 * UTF-8 多位元組序列、也不會出現在 Big5 的第二位元組（0x40–0x7E、0xA1–0xFE），所以用它切行是安全的。
 * `--xml` 的輸出一律是 UTF-8，不需要經過這裡。
 */

import iconv from "iconv-lite";

// 用純 JS 的 iconv-lite 解 Big5：pkg 打包的 Node 是 small-icu，`new TextDecoder("big5")` 會丟
// 「The "big5" encoding is not supported」。
function decodeLine(line: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(line);
  } catch {
    return iconv.decode(Buffer.from(line), "big5");
  }
}

export function decodeSvnText(buf: Buffer): string {
  // 純 ASCII 或整段都是合法 UTF-8（最常見的情況）直接回傳，省掉逐行處理。
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    // 有非 UTF-8 的位元組，往下逐行處理
  }
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      parts.push(decodeLine(buf.subarray(start, i)), "\n");
      start = i + 1;
    }
  }
  if (start < buf.length) parts.push(decodeLine(buf.subarray(start)));
  return parts.join("");
}
