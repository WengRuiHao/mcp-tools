import { closeSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { SUPPORTED_EXTENSIONS } from "./normalize.js";
import { DupPathError, MAX_FILE_BYTES, type DupOptions } from "./types.js";

const GENERATED_HEADER = /\bgenerated\b|auto-generated|自動產生|自动生成/i;
const HEADER_LINES = 5;
const BINARY_PROBE_BYTES = 8000;

export function toPosix(p: string): string {
  return p.split(sep).join("/");
}

function isInside(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function effectiveExcludes(options: DupOptions): string[] {
  return [...options.excludeGlobs, ...options.extraExcludes];
}

/** 簡單比對：`*.ext` 比檔名後綴、含 `/` 比路徑前綴、其餘比任一層目錄或檔名。 */
export function isExcluded(relPath: string, patterns: readonly string[]): boolean {
  const posix = toPosix(relPath);
  const segments = posix.split("/");
  const base = segments[segments.length - 1];
  return patterns.some((raw) => {
    const p = raw.replace(/^\*\*\//, "").replace(/\/(\*\*)?$/, "");
    if (!p) return false;
    if (p.startsWith("*")) return base.toLowerCase().endsWith(p.slice(1).toLowerCase());
    if (p.includes("/")) return posix === p || posix.startsWith(`${p}/`);
    return segments.includes(p);
  });
}

export function isSupportedFile(relPath: string): boolean {
  return SUPPORTED_EXTENSIONS.has(extname(relPath).slice(1).toLowerCase());
}

/** 驗證相對路徑確實落在 projectDir 內（含符號連結），回傳 realBase 與絕對路徑；不存在回傳 null。 */
export function resolveInside(realBase: string, file: string): string | null {
  const lexical = resolve(realBase, file);
  if (!isInside(realBase, lexical)) throw new DupPathError(`路徑超出專案目錄：${file}`);
  let real: string;
  try {
    real = realpathSync.native(lexical);
  } catch {
    return null;
  }
  if (!isInside(realBase, real)) throw new DupPathError(`路徑經符號連結逃出專案目錄：${file}`);
  return real;
}

export function realProjectDir(projectDir: string): string {
  try {
    return realpathSync.native(resolve(projectDir));
  } catch {
    throw new DupPathError(`專案目錄不存在：${projectDir}`);
  }
}

function looksBinary(abs: string): boolean {
  const fd = openSync(abs, "r");
  try {
    const buf = Buffer.alloc(BINARY_PROBE_BYTES);
    const n = readSync(fd, buf, 0, BINARY_PROBE_BYTES, 0);
    return buf.subarray(0, n).includes(0);
  } finally {
    closeSync(fd);
  }
}

export type ReadOutcome = { text: string } | { skip: string };

/** 讀取文字檔；二進位、過大、自動產生都回傳 skip 原因。 */
export function readSourceText(abs: string): ReadOutcome {
  try {
    const st = statSync(abs);
    if (!st.isFile()) return { skip: "不是檔案" };
    if (st.size > MAX_FILE_BYTES) return { skip: "超過單檔大小上限" };
    if (looksBinary(abs)) return { skip: "二進位檔" };
    const text = readFileSync(abs, "utf8");
    const head = text.split(/\r\n|\r|\n/, HEADER_LINES).join("\n");
    if (GENERATED_HEADER.test(head)) return { skip: "自動產生檔案" };
    return { text };
  } catch {
    return { skip: "無法讀取" };
  }
}

export interface FileListing {
  files: string[];
  truncated: boolean;
  truncatedReason?: string;
}

/** 走訪專案目錄，收集支援語言的候選檔（相對路徑，POSIX 分隔）；不跟隨符號連結。 */
export function listProjectFiles(
  realBase: string,
  options: DupOptions,
  deadline: number,
  startDir = "",
): FileListing {
  const patterns = effectiveExcludes(options);
  const files: string[] = [];
  let truncatedReason: string | undefined;
  const stack = [startDir];
  while (stack.length > 0 && !truncatedReason) {
    const dir = stack.pop() as string;
    let entries;
    try {
      entries = readdirSync(resolve(realBase, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink() || isExcluded(rel, patterns)) continue;
      if (entry.isDirectory()) { stack.push(rel); continue; }
      if (!entry.isFile() || !isSupportedFile(rel)) continue;
      if (files.length >= options.maxFiles) { truncatedReason = `檔案數超過上限 ${options.maxFiles}`; break; }
      if (Date.now() > deadline) { truncatedReason = `掃描時間超過上限 ${options.timeoutMs} 毫秒`; break; }
      files.push(rel);
    }
  }
  return { files, truncated: truncatedReason !== undefined, truncatedReason };
}
