import type { NormLine } from "./types.js";
import { MAX_BUCKET_SIZE } from "./types.js";

export interface IndexedFile {
  path: string;
  lines: NormLine[];
  /** 每行文字對應的整數編號（同文字同編號）。 */
  ids: number[];
  isChanged: boolean;
}

export interface WindowRef {
  fileIdx: number;
  start: number;
}

/** 對一串行編號做滑動視窗雜湊（雙重 32 位元雜湊合成為數字鍵；命中後會再逐行比對文字，不靠雜湊判定）。 */
export function windowKeys(ids: number[], size: number): number[] {
  const keys: number[] = [];
  for (let i = 0; i + size <= ids.length; i++) {
    let h1 = 17;
    let h2 = 2166136261;
    for (let k = 0; k < size; k++) {
      h1 = (Math.imul(h1, 31) + ids[i + k]) | 0;
      h2 = Math.imul(h2 ^ ids[i + k], 16777619);
    }
    keys.push((h1 >>> 0) + (h2 >>> 0) * 4294967296);
  }
  return keys;
}

export class LineInterner {
  private readonly map = new Map<string, number>();
  id(text: string): number {
    let found = this.map.get(text);
    if (found === undefined) {
      found = this.map.size;
      this.map.set(text, found);
    }
    return found;
  }
}

export type WindowIndex = Map<number, WindowRef[]>;

export function addToIndex(index: WindowIndex, fileIdx: number, keys: number[]): void {
  keys.forEach((key, start) => {
    const bucket = index.get(key);
    if (!bucket) index.set(key, [{ fileIdx, start }]);
    else if (bucket.length < MAX_BUCKET_SIZE) bucket.push({ fileIdx, start });
  });
}

export function sameWindow(a: IndexedFile, i: number, b: IndexedFile, j: number, size: number): boolean {
  for (let k = 0; k < size; k++) if (a.ids[i + k] !== b.ids[j + k]) return false;
  return true;
}

/** 一組連續命中：自己這邊從 start 起 length 行，對方從 otherStart 起同樣長度。 */
export interface Run {
  otherIdx: number;
  start: number;
  otherStart: number;
  length: number;
}

/** 把相鄰（同檔、同偏移）的命中視窗合併成連續區塊。hits 為 [自己視窗起點, 對方檔, 對方視窗起點]。 */
export function mergeHits(hits: Array<[number, number, number]>, size: number): Run[] {
  const sorted = [...hits].sort((a, b) => a[1] - b[1] || a[2] - a[0] - (b[2] - b[0]) || a[0] - b[0]);
  const runs: Run[] = [];
  let current: Run | null = null;
  for (const [start, otherIdx, otherStart] of sorted) {
    if (
      current &&
      current.otherIdx === otherIdx &&
      current.otherStart - current.start === otherStart - start &&
      start <= current.start + current.length - size + 1
    ) {
      current.length = start + size - current.start;
      continue;
    }
    current = { otherIdx, start, otherStart, length: size };
    runs.push(current);
  }
  return runs;
}
