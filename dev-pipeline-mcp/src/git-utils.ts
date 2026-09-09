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
