import { execFile } from "node:child_process";
import { promisify } from "node:util";

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

export interface GitCaptureResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Like runGit, but never throws on a non-zero exit — used for git operations (rebase/merge) where a
 * conflict is an expected, meaningful outcome the caller needs to inspect (stdout/stderr/code), not an
 * exceptional condition to unwind past. Plain runGit stays throwing for every other read-only call site.
 */
function runGitCapture(args: string[], cwd: string): Promise<GitCaptureResult> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd }, (err, stdout, stderr) => {
      const code = err && typeof (err as any).code === "number" ? (err as any).code : err ? 1 : 0;
      resolve({ code, stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

export interface PorcelainEntry {
  /** Raw 2-char XY status code from `git status --porcelain` (e.g. "M ", "??", "AM"). */
  status: string;
  file: string;
}

/** Real, ground-truth touched-file list for a worktree — the whole point of worktree isolation is that this is authoritative and doesn't depend on any AI self-declaration. */
export async function getPorcelainStatus(dir: string): Promise<PorcelainEntry[]> {
  const out = await runGit(["status", "--porcelain"], dir);
  if (!out) return [];
  return out.split("\n").map((line) => ({ status: line.slice(0, 2), file: line.slice(3) }));
}

export async function getCurrentBranch(dir: string): Promise<string> {
  const branch = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], dir);
  if (!branch || branch === "HEAD") {
    throw new Error(`${dir} 目前處於 detached HEAD 或無法判斷目前分支，無法當作 worktree 的來源分支。`);
  }
  return branch;
}

export async function revParse(dir: string, ref: string): Promise<string> {
  return runGit(["rev-parse", ref], dir);
}

/** Null when the two refs share no common history (shouldn't happen for a branch cut from another, but guarded rather than assumed). */
export async function mergeBase(dir: string, a: string, b: string): Promise<string | null> {
  try {
    return await runGit(["merge-base", a, b], dir);
  } catch {
    return null;
  }
}

export async function worktreeAdd(gitRoot: string, worktreePath: string, branch: string, sourceBranch: string): Promise<void> {
  await runGit(["worktree", "add", "-b", branch, worktreePath, sourceBranch], gitRoot);
}

export interface GitWorktreeListEntry {
  path: string;
  branch: string | null;
  locked: boolean;
}

/** Ground-truth cross-check against git's own bookkeeping — used to detect drift between our JSON store and reality (e.g. a worktree folder deleted by hand outside this tool). */
export async function listGitWorktrees(gitRoot: string): Promise<GitWorktreeListEntry[]> {
  const out = await runGit(["worktree", "list", "--porcelain"], gitRoot);
  if (!out) return [];
  const entries: GitWorktreeListEntry[] = [];
  let current: Partial<GitWorktreeListEntry> | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current && current.path) entries.push({ path: current.path, branch: current.branch ?? null, locked: !!current.locked });
      current = { path: line.slice("worktree ".length), branch: null, locked: false };
    } else if (line.startsWith("branch ") && current) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "locked" && current) {
      current.locked = true;
    }
  }
  if (current && current.path) entries.push({ path: current.path, branch: current.branch ?? null, locked: !!current.locked });
  return entries;
}

/** force:true bypasses git's own "has unmerged/locked" guard — only pass true when the caller already confirmed it's safe (e.g. dryRun-verified finalize). */
export async function worktreeRemove(gitRoot: string, worktreePath: string, force: boolean): Promise<GitCaptureResult> {
  const args = ["worktree", "remove"];
  if (force) args.push("--force");
  args.push(worktreePath);
  return runGitCapture(args, gitRoot);
}

export async function deleteBranch(gitRoot: string, branch: string, force: boolean): Promise<GitCaptureResult> {
  return runGitCapture(["branch", force ? "-D" : "-d", branch], gitRoot);
}

/** Points this repo's git-native hooks at a shared directory (see getGitHooksDir) — applies to every worktree of this repo, not just the one it's run from, since core.hooksPath is a repo-level (not worktree-level) config. */
export async function setCoreHooksPath(gitRoot: string, hooksDir: string): Promise<GitCaptureResult> {
  return runGitCapture(["config", "core.hooksPath", hooksDir], gitRoot);
}

/** Hides local-only modifications (e.g. a worktree's renamed Eclipse `.project`) from `git status`/diff and from being picked up by a commit or merge — used so per-worktree IDE metadata tweaks never block merge_ticket_worktree's dirty-check or leak back into the source branch. */
export async function skipWorktreeFile(dir: string, file: string): Promise<void> {
  await runGit(["update-index", "--skip-worktree", file], dir);
}

export interface GitOpResult {
  ok: boolean;
  conflict: boolean;
  message: string;
}

/** Rebases the worktree's branch onto `ontoBranch` (run inside the worktree dir). Never auto-aborts on conflict — leaves the worktree in the mid-rebase state for manual/AI conflict resolution, per design (git rebase is the authority on real conflicts, this tool never picks a side). */
export async function rebaseOnto(worktreeDir: string, ontoBranch: string): Promise<GitOpResult> {
  const result = await runGitCapture(["rebase", ontoBranch], worktreeDir);
  if (result.code === 0) return { ok: true, conflict: false, message: result.stdout || "rebase 完成，沒有衝突。" };
  const conflict = /CONFLICT/i.test(result.stdout) || /CONFLICT/i.test(result.stderr);
  return { ok: false, conflict, message: (result.stdout + "\n" + result.stderr).trim() };
}

/** Merges `branch` into whatever is currently checked out in `mainDir` (the ticket branch is never checked out there — mainDir keeps sourceBranch checked out throughout). Never auto-resolves on conflict, same rationale as rebaseOnto. */
export async function mergeBranchInto(mainDir: string, branch: string, message: string): Promise<GitOpResult> {
  const result = await runGitCapture(["merge", "--no-ff", branch, "-m", message], mainDir);
  if (result.code === 0) return { ok: true, conflict: false, message: result.stdout || "merge 完成，沒有衝突。" };
  const conflict = /CONFLICT/i.test(result.stdout) || /CONFLICT/i.test(result.stderr);
  return { ok: false, conflict, message: (result.stdout + "\n" + result.stderr).trim() };
}

export async function getGitTopLevel(dir: string): Promise<string | null> {
  try {
    const top = await runGit(["rev-parse", "--show-toplevel"], dir);
    return top || null;
  } catch {
    return null;
  }
}

export async function isGitRepoRoot(dir: string): Promise<boolean> {
  const top = await getGitTopLevel(dir);
  return top !== null;
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
