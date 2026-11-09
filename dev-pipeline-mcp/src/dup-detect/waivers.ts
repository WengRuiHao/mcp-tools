import type { DupBlock, DupWaiver } from "./types.js";

/** 豁免理由去空白後的最少字元數。 */
export const MIN_WAIVER_REASON_CHARS = 4;

function norm(path: string): string {
  return path.split("\\").join("/").replace(/^\.\//, "");
}

export function isValidWaiver(w: DupWaiver): boolean {
  return typeof w.file === "string" && w.file.trim() !== "" && typeof w.reason === "string" &&
    w.reason.replace(/\s+/g, "").length >= MIN_WAIVER_REASON_CHARS;
}

function covers(w: DupWaiver, a: string, b: string): boolean {
  return norm(w.file) === a && (w.otherFile === undefined || norm(w.otherFile) === b);
}

/** 豁免可從任一側指定（file 為區塊的任一檔案，otherFile 為另一檔案）。 */
export function applyWaivers(blocks: DupBlock[], waivers: DupWaiver[]) {
  const valid = waivers.filter(isValidWaiver);
  const invalidWaivers = waivers.filter((w) => !isValidWaiver(w));
  const active: DupBlock[] = [];
  const waived: Array<DupBlock & { reason: string }> = [];
  for (const block of blocks) {
    const hit = valid.find((w) => covers(w, block.file, block.otherFile) || covers(w, block.otherFile, block.file));
    if (hit) waived.push({ ...block, reason: hit.reason.trim() });
    else active.push(block);
  }
  return { active, waived, invalidWaivers };
}
