// 重複程式碼偵測測試用的小工具：暫存目錄與合成檔案。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const mod = await import("../../dist/dup-detect/index.js");

export function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dup-detect-"));
}

export function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

export function write(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** 產生 n 行彼此不同、足夠長的 js 程式碼行（tag 不同則內容不同）。 */
export function codeLines(n, tag = "a") {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(`  const result_${tag}_${i} = computeSomething(${tag}Input, ${i}) + offsetValue_${i};`);
  }
  return out;
}

export function jsFile(body) {
  return ["function demo() {", ...body, "}", ""].join("\n");
}
