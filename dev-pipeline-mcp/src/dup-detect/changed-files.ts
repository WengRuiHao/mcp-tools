import { execFile } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { isExcluded, listProjectFiles, readSourceText, realProjectDir, resolveInside, toPosix } from "./scan.js";
import { DEFAULT_DUP_OPTIONS, DupPathError } from "./types.js";

const VCS_TIMEOUT_MS = 15000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** failOnWarning：svn 在非工作副本只印警告（結束碼 0），此時也視為失敗。 */
function run(cmd: string, args: string[], cwd: string, failOnWarning = false): Promise<string | null> {
  return new Promise((done) => {
    execFile(
      cmd, args,
      { cwd, timeout: VCS_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true, encoding: "utf8" },
      (err, stdout, stderr) => done(err || (failOnWarning && /W?E?155007|not a working copy/i.test(stderr)) ? null : stdout),
    );
  });
}

/** 把版本控制回報的路徑（相對於 baseAbs）轉成相對 projectDir 的路徑；在目錄外、已刪除、二進位者丟棄。 */
function acceptPaths(realBase: string, baseAbs: string, paths: Iterable<string>): string[] {
  const result = new Set<string>();
  for (const p of paths) {
    if (!p) continue;
    const rel = toPosix(relative(realBase, resolve(baseAbs, p)));
    if (rel === "" || rel.startsWith("..") || /^[A-Za-z]:/.test(rel)) continue;
    if (isExcluded(rel, DEFAULT_DUP_OPTIONS.excludeGlobs)) continue;
    let abs: string | null;
    try {
      abs = resolveInside(realBase, rel);
    } catch (err) {
      if (err instanceof DupPathError) continue;
      throw err;
    }
    if (!abs) continue;
    try {
      if (!statSync(abs).isFile()) continue;
    } catch {
      continue;
    }
    const outcome = readSourceText(abs);
    if ("skip" in outcome && outcome.skip === "二進位檔") continue;
    result.add(rel);
  }
  return [...result].sort();
}

async function gitChanged(realBase: string): Promise<string[] | null> {
  const top = await run("git", ["rev-parse", "--show-toplevel"], realBase);
  if (top === null || top.trim() === "") return null;
  const topDir = realpathSync.native(top.trim());
  const status = await run("git", ["status", "--porcelain", "-z", "--untracked-files=all"], realBase);
  if (status === null) return null;
  const found: string[] = [];
  const entries = status.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    if (xy.includes("D")) continue;
    found.push(entry.slice(3));
    if (xy.includes("R") || xy.includes("C")) i++;
  }
  const diff = await run("git", ["diff", "--name-only", "-z", "HEAD"], realBase);
  if (diff !== null) found.push(...diff.split("\0"));
  return acceptPaths(realBase, topDir, found);
}

async function svnChanged(realBase: string): Promise<string[] | null> {
  const out = await run("svn", ["status"], realBase, true);
  if (out === null) return null;
  const found: string[] = [];
  for (const line of out.split(/\r?\n/)) {
    if (line.length < 9 || !"AM?".includes(line[0])) continue;
    const path = line.slice(8).trim();
    const abs = resolve(realBase, path);
    let isDir = false;
    try { isDir = statSync(abs).isDirectory(); } catch { continue; }
    if (isDir) {
      if (line[0] === "?") {
        const listing = listProjectFiles(realBase, DEFAULT_DUP_OPTIONS, Date.now() + VCS_TIMEOUT_MS, toPosix(path));
        found.push(...listing.files);
      }
      continue;
    }
    found.push(path);
  }
  return acceptPaths(realBase, realBase, found);
}

/**
 * 取得改動檔案（相對於 projectDir）：先判斷 git 工作樹（含未追蹤檔案），再判斷 SVN 工作副本（A/M/?）。
 * 皆不是時回傳 null，由呼叫端提供清單。只用 execFile 帶參數陣列與逾時，不經 shell。
 */
export async function getChangedFiles(projectDir: string): Promise<string[] | null> {
  const realBase = realProjectDir(projectDir);
  const git = await gitChanged(realBase);
  if (git !== null) return git;
  return svnChanged(realBase);
}
