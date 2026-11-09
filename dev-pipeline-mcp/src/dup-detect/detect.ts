import { setImmediate as yieldToLoop } from "node:timers/promises";
import {
  LineInterner, addToIndex, mergeHits, sameWindow, windowKeys,
  type IndexedFile, type WindowIndex,
} from "./match.js";
import { normalizeSource } from "./normalize.js";
import {
  effectiveExcludes, isExcluded, isSupportedFile, listProjectFiles, readSourceText, realProjectDir, resolveInside,
  toPosix,
} from "./scan.js";
import { applyWaivers } from "./waivers.js";
import {
  DEFAULT_DUP_OPTIONS, type DupBlock, type DupOptions, type DupReport, type DupWaiver,
} from "./types.js";

export interface DetectInput {
  projectDir: string;
  /** 相對於 projectDir 的改動檔案清單。 */
  changedFiles: string[];
  options?: Partial<DupOptions>;
  waivers?: DupWaiver[];
}

const YIELD_EVERY = 200;
const TEST_PATH = /(^|[\\/._-])(tests?|__tests__|specs?)([\\/._-]|$)/i;
const CAMEL_TEST = /[a-z0-9](Tests?|Spec)\.[A-Za-z]+$/;

export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path) || CAMEL_TEST.test(path);
}

export function resolveOptions(partial?: Partial<DupOptions>): DupOptions {
  const merged: DupOptions = { ...DEFAULT_DUP_OPTIONS, excludeGlobs: [...DEFAULT_DUP_OPTIONS.excludeGlobs], extraExcludes: [] };
  for (const [key, value] of Object.entries(partial ?? {})) {
    if (value !== undefined) (merged as unknown as Record<string, unknown>)[key] = value;
  }
  merged.minRun = Math.max(1, Math.floor(merged.minRun));
  merged.testMinRun = Math.max(1, Math.floor(merged.testMinRun));
  return merged;
}

function extOf(path: string): string {
  return path.slice(path.lastIndexOf(".") + 1);
}

function toIndexed(path: string, text: string, interner: LineInterner, isChanged: boolean): IndexedFile {
  const lines = normalizeSource(text, extOf(path));
  return { path, lines, ids: lines.map((l) => interner.id(l.text)), isChanged };
}

function blockChars(file: IndexedFile, start: number, length: number): number {
  let sum = 0;
  for (let k = 0; k < length; k++) sum += file.lines[start + k].text.length + 1;
  return sum - 1;
}

function findBlocks(
  file: IndexedFile, fileIdx: number, files: IndexedFile[], index: WindowIndex, size: number, options: DupOptions,
): DupBlock[] {
  const hits: Array<[number, number, number]> = [];
  windowKeys(file.ids, size).forEach((key, start) => {
    for (const ref of index.get(key) ?? []) {
      if (ref.fileIdx === fileIdx && ref.start === start) continue;
      if (sameWindow(file, start, files[ref.fileIdx], ref.start, size)) hits.push([start, ref.fileIdx, ref.start]);
    }
  });
  const blocks: DupBlock[] = [];
  for (const run of mergeHits(hits, size)) {
    const other = files[run.otherIdx];
    const sameFile = run.otherIdx === fileIdx;
    if (sameFile && (run.start >= run.otherStart || run.start + run.length > run.otherStart)) continue;
    if (!sameFile && other.isChanged && other.path < file.path) continue;
    const needed = isTestPath(file.path) || isTestPath(other.path) ? options.testMinRun : options.minRun;
    if (run.length < needed || blockChars(file, run.start, run.length) < options.minChars) continue;
    const last = run.length - 1;
    blocks.push({
      file: file.path,
      startLine: file.lines[run.start].line,
      endLine: file.lines[run.start + last].line,
      otherFile: other.path,
      otherStartLine: other.lines[run.otherStart].line,
      otherEndLine: other.lines[run.otherStart + last].line,
      matchedLines: run.length,
      kind: other.isChanged ? "within-change" : "existing",
    });
  }
  return blocks;
}

export async function detectDuplicates(input: DetectInput): Promise<DupReport> {
  const options = resolveOptions(input.options);
  const deadline = Date.now() + options.timeoutMs;
  const realBase = realProjectDir(input.projectDir);
  const patterns = effectiveExcludes(options);
  const interner = new LineInterner();
  const files: IndexedFile[] = [];
  const skippedChanged: string[] = [];
  const changedPaths = new Set<string>();

  for (const raw of input.changedFiles) {
    const path = toPosix(raw).replace(/^\.\//, "");
    if (changedPaths.has(path)) continue;
    const abs = resolveInside(realBase, path);
    const outcome = abs && isSupportedFile(path) && !isExcluded(path, patterns) ? readSourceText(abs) : { skip: "略過" };
    if ("skip" in outcome) { skippedChanged.push(path); continue; }
    changedPaths.add(path);
    files.push(toIndexed(path, outcome.text, interner, true));
  }
  const changedCount = files.length;

  const listing = listProjectFiles(realBase, options, deadline);
  let truncated = listing.truncated;
  let truncatedReason = listing.truncatedReason;
  for (const [n, path] of listing.files.entries()) {
    if (changedPaths.has(path)) continue;
    if (n % YIELD_EVERY === 0) await yieldToLoop();
    if (Date.now() > deadline) {
      truncated = true;
      truncatedReason = `掃描時間超過上限 ${options.timeoutMs} 毫秒`;
      break;
    }
    const abs = resolveInside(realBase, path);
    const outcome = abs ? readSourceText(abs) : { skip: "不存在" };
    if (!("skip" in outcome)) files.push(toIndexed(path, outcome.text, interner, false));
  }

  const size = Math.min(options.minRun, options.testMinRun);
  const index: WindowIndex = new Map();
  files.forEach((f, i) => addToIndex(index, i, windowKeys(f.ids, size)));
  const duplicates: DupBlock[] = [];
  for (let i = 0; i < changedCount; i++) {
    duplicates.push(...findBlocks(files[i], i, files, index, size, options));
  }
  duplicates.sort((a, b) => a.file.localeCompare(b.file) || a.startLine - b.startLine);

  const { active, waived, invalidWaivers } = applyWaivers(duplicates, input.waivers ?? []);
  return {
    blocking: active.length > 0,
    duplicates: active,
    waived,
    invalidWaivers,
    scannedFiles: files.length,
    truncated,
    ...(truncatedReason ? { truncatedReason } : {}),
    skippedChanged,
    options,
  };
}
