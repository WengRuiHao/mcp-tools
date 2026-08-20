import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

async function runGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  // trimEnd only: porcelain output (e.g. `status --porcelain`) uses a fixed-width
  // leading status prefix on each line; a leading trim() would eat the first line's
  // leading space and misalign every downstream fixed-offset slice.
  return stdout.replace(/\s+$/, "");
}

export interface CommitInfo {
  hash: string;
  author: string;
  date: string;
  message: string;
  changedFiles: string[];
}

export async function getGitTopLevel(dir: string): Promise<string | null> {
  try {
    const top = await runGit(["rev-parse", "--show-toplevel"], dir);
    return top || null;
  } catch {
    return null;
  }
}

export async function isDirInsideWorkTree(dir: string): Promise<boolean> {
  try {
    const result = await runGit(["rev-parse", "--is-inside-work-tree"], dir);
    return result === "true";
  } catch {
    return false;
  }
}

export async function isGitRepoRoot(dir: string): Promise<boolean> {
  const top = await getGitTopLevel(dir);
  return top !== null;
}

/**
 * Checks whether the specific file is tracked by git, as opposed to merely sitting
 * somewhere underneath an unrelated ancestor repo. `rev-parse --show-toplevel` walks
 * up parent directories and will report "tracked" for a spec nested under an unrelated
 * outer repo (e.g. a home directory that happens to be a git repo) even though the file
 * itself has nothing to do with that repo's history.
 */
export async function isFileTracked(filePath: string): Promise<boolean> {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  try {
    await execFileAsync("git", ["ls-files", "--error-unmatch", "--", base], { cwd: dir });
    return true;
  } catch (err: any) {
    // A string `code` (ENOENT/EACCES/ENOTDIR/...) means the process itself never ran —
    // git isn't installed, cwd is missing, or permissions are wrong. That's an environment
    // failure, not "this file isn't tracked" — don't let it masquerade as gitTracked:false.
    if (typeof err?.code === "string") {
      throw new Error(`無法在 ${dir} 執行 git 指令（${err.code}）：${err.message}`);
    }
    // git ran and exited non-zero because the pathspec didn't match a tracked file —
    // this is the genuine "not tracked" case (numeric exit code).
    return false;
  }
}

const FIELD_SEP = "\x1f";

export async function getRecentCommits(gitDir: string, limit: number): Promise<CommitInfo[]> {
  const format = "%H" + FIELD_SEP + "%an" + FIELD_SEP + "%ad" + FIELD_SEP + "%s";
  const log = await runGit(
    ["log", "-n" + String(limit), "--date=iso-strict", "--pretty=format:" + format, "--name-only"],
    gitDir
  );

  if (!log) return [];

  const commits: CommitInfo[] = [];
  // 40 hex chars = SHA-1, 64 = SHA-256 (`git init --object-format=sha256`); accept either.
  const blockPattern = new RegExp("\\n(?=[0-9a-f]{40,64}" + FIELD_SEP + ")", "g");
  const blocks = log.split(blockPattern);

  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.length > 0);
    if (lines.length === 0) continue;
    const [hash, author, date, message] = lines[0].split(FIELD_SEP);
    // Guards against a mis-split fragment (e.g. a commit message body line that happens to
    // start with hex-looking text) being mistaken for a real commit header.
    if (hash.length !== 40 && hash.length !== 64) continue;
    const changedFiles = lines.slice(1);
    commits.push({ hash, author, date, message, changedFiles });
  }

  return commits;
}

export function toPosixPath(p: string): string {
  return path.resolve(p).replace(/\\/g, "/");
}
