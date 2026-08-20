import path from "node:path";
import { readFile, writeFile, mkdir, readdir, stat, realpath } from "node:fs/promises";
import { getWriteRecord, recordFileWrite, backupConflictingContent, hashContent } from "./file-write-state.js";

export class PathEscapeError extends Error {}

/** Resolves the real (symlink-following) path of `p`'s nearest existing ancestor — walking up the directory tree if `p` itself (or a suffix of it) doesn't exist yet, e.g. a file that's about to be created. Falls back to `p` unresolved only if we walk all the way to the filesystem root without finding anything real (shouldn't normally happen). */
async function realpathOfNearestExisting(p: string): Promise<string> {
  let current = p;
  while (true) {
    try {
      return await realpath(current);
    } catch (err: any) {
      if (err.code !== "ENOENT" && err.code !== "ENOTDIR") throw err;
      const parent = path.dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

/**
 * Resolve `relPath` against `root` and reject any attempt to escape the sandbox root.
 *
 * Two independent checks:
 * 1. A plain string-prefix check on the resolved (but NOT symlink-followed) path — catches naive
 *    escapes like `../../etc/passwd`.
 * 2. A realpath-based check on the nearest existing ancestor — catches a symlink/junction that sits
 *    *inside* the sandbox but points somewhere outside it. `path.resolve` never follows links, so check
 *    (1) alone would consider `<root>/shortcut-to-outside/secret.txt` safely inside the sandbox even
 *    though reading/writing through it actually touches a location outside `root`.
 */
async function resolveSafe(root: string, relPath: string): Promise<string> {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relPath);
  const rootWithSep = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
  if (target !== resolvedRoot && !target.startsWith(rootWithSep)) {
    throw new PathEscapeError(`路徑 "${relPath}" 逃出了專案目錄範圍（${root}），已拒絕。`);
  }

  const realRoot = await realpathOfNearestExisting(resolvedRoot);
  const realTargetAncestor = await realpathOfNearestExisting(target);
  const realRootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  if (realTargetAncestor !== realRoot && !realTargetAncestor.startsWith(realRootWithSep)) {
    throw new PathEscapeError(`路徑 "${relPath}" 透過連結（symlink/junction）指向專案目錄範圍外（${root}），已拒絕。`);
  }

  return target;
}

export interface FileReadOutcome {
  content: string;
  /** true 代表這個檔案自從這個 MCP 上次寫入之後，已經被別的東西（GUI 工具、使用者手動編輯、別的 AI……）改過。不會阻擋讀取，純粹提早示警。 */
  externallyModifiedSinceLastWrite: boolean;
  lastWrittenAt: string | null;
}

export async function fsReadFile(root: string, relPath: string): Promise<FileReadOutcome> {
  const target = await resolveSafe(root, relPath);
  const content = await readFile(target, "utf-8");
  const record = await getWriteRecord(target);
  if (!record) return { content, externallyModifiedSinceLastWrite: false, lastWrittenAt: null };
  return {
    content,
    externallyModifiedSinceLastWrite: hashContent(content) !== record.hash,
    lastWrittenAt: record.writtenAt,
  };
}

export interface FileWriteBlocked {
  blocked: true;
  currentContent: string;
  lastWrittenAt: string;
  backupPath: string | null;
}
export interface FileWriteOk {
  blocked: false;
}
export type FileWriteOutcome = FileWriteBlocked | FileWriteOk;

/**
 * 覆寫（或建立）一個專案檔案。如果這個 MCP 之前寫過這個路徑，且磁碟上現在的內容雜湊跟上次寫入時不一致
 * （代表被外部工具/使用者/別的 AI 改過），預設會擋下這次寫入並回傳 blocked:true（附上目前磁碟內容 + 備份路徑），
 * 除非 `acknowledgeExternalChange: true`——這種情況下仍然會先把即將被蓋掉的內容備份起來，才真的覆寫。
 * 第一次寫某個路徑（沒有既有記錄）不做任何比對，直接寫入。
 */
export async function fsWriteFile(
  root: string,
  relPath: string,
  content: string,
  opts: { taskGid?: string | null; acknowledgeExternalChange?: boolean } = {}
): Promise<FileWriteOutcome> {
  const target = await resolveSafe(root, relPath);
  const record = await getWriteRecord(target);

  if (record) {
    let currentContent: string | null;
    try {
      currentContent = await readFile(target, "utf-8");
    } catch {
      currentContent = null;
    }
    const externallyModified = currentContent === null || hashContent(currentContent) !== record.hash;

    if (externallyModified) {
      const backupPath = currentContent !== null ? await backupConflictingContent(target, currentContent) : null;
      if (!opts.acknowledgeExternalChange) {
        return { blocked: true, currentContent: currentContent ?? "", lastWrittenAt: record.writtenAt, backupPath };
      }
      // 確認要覆蓋：備份已經留了一份，繼續往下正常寫入。
    }
  }

  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf-8");
  await recordFileWrite(target, content, opts.taskGid ?? null);
  return { blocked: false };
}

interface DirEntry {
  name: string;
  type: "file" | "dir";
}

export async function fsListDir(root: string, relPath: string): Promise<DirEntry[]> {
  const target = await resolveSafe(root, relPath || ".");
  const entries = await readdir(target, { withFileTypes: true });
  return entries
    .filter((e) => e.name !== "node_modules" && e.name !== ".git")
    .map((e) => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" }));
}

const SEARCHABLE_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".java", ".py", ".go", ".rs", ".rb", ".php",
  ".md", ".json", ".yml", ".yaml", ".xml", ".html", ".css", ".sql", ".txt", ".c", ".cpp", ".h",
]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "target", ".idea", ".vscode"]);
const MAX_SEARCH_FILES = 2000;
const MAX_MATCHES = 200;
const MAX_REGEX_PATTERN_LENGTH = 200;
const SEARCH_TIME_BUDGET_MS = 5000;

/**
 * Very rough heuristic for the most common catastrophic-backtracking shapes — nested/overlapping
 * quantifiers like `(a+)+`, `(a*)*`, `(a+)*` — NOT an exhaustive ReDoS detector (that's a much harder,
 * open-ended problem; genuinely robust protection would mean running the regex in a worker thread with a
 * hard timeout/terminate). This just rejects the shapes an AI is actually likely to accidentally produce,
 * combined with the length cap and the per-batch time budget below, as a proportionate (not perfect)
 * mitigation for a single-threaded Node process where one bad pattern can otherwise wedge every other
 * tool call.
 */
const REDOS_SHAPE = /\([^()]*[+*][^()]*\)[+*]/;

interface SearchMatch {
  file: string;
  line: number;
  text: string;
}

/** Simple recursive text/regex search scoped to the sandbox root, bounded to avoid runaway scans. */
export async function fsSearchText(root: string, pattern: string, useRegex: boolean): Promise<SearchMatch[]> {
  const resolvedRoot = path.resolve(root);
  const matches: SearchMatch[] = [];
  let filesScanned = 0;
  let truncatedByTimeout = false;

  let regex: RegExp | null = null;
  if (useRegex) {
    if (pattern.length > MAX_REGEX_PATTERN_LENGTH) {
      throw new Error(`搜尋的正規表示式太長（${pattern.length} 字元，上限 ${MAX_REGEX_PATTERN_LENGTH}），已拒絕，避免執行時間失控。`);
    }
    if (REDOS_SHAPE.test(pattern)) {
      throw new Error("這個正規表示式看起來有巢狀量詞（例如 (a+)+ 這種形狀），可能導致災難性回溯讓搜尋整個卡死，已拒絕。請改寫成更明確、不巢狀的模式。");
    }
    regex = new RegExp(pattern, "i");
  }

  const deadline = Date.now() + SEARCH_TIME_BUDGET_MS;

  async function walk(dir: string): Promise<void> {
    if (matches.length >= MAX_MATCHES || filesScanned >= MAX_SEARCH_FILES || truncatedByTimeout) return;
    if (Date.now() > deadline) {
      truncatedByTimeout = true;
      return;
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (matches.length >= MAX_MATCHES || filesScanned >= MAX_SEARCH_FILES || truncatedByTimeout) return;
      if (Date.now() > deadline) {
        truncatedByTimeout = true;
        return;
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(path.join(dir, entry.name));
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (!SEARCHABLE_EXT.has(ext)) continue;
      filesScanned++;
      const filePath = path.join(dir, entry.name);
      let content: string;
      try {
        content = await readFile(filePath, "utf-8");
      } catch {
        continue;
      }
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const hit = regex ? regex.test(lines[i]) : lines[i].toLowerCase().includes(pattern.toLowerCase());
        if (hit) {
          matches.push({ file: path.relative(resolvedRoot, filePath), line: i + 1, text: lines[i].trim().slice(0, 300) });
          if (matches.length >= MAX_MATCHES) return;
        }
      }
    }
  }

  await walk(resolvedRoot);
  if (truncatedByTimeout) {
    matches.push({ file: "(搜尋逾時)", line: 0, text: `已達 ${SEARCH_TIME_BUDGET_MS}ms 時間預算，搜尋提前中止，以上結果可能不完整。` });
  }
  return matches;
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
