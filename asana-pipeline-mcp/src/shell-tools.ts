import { execFile } from "node:child_process";
import path from "node:path";
import type { GitRootEntry } from "./git-roots-store.js";

const GIT_INVOKE = /(^|[\s;&|()"'`]|[\\/])git(\.exe)?(?=[\s"'`]|$)/i;
const GIT_POWERSHELL_CALL = /&\s*['"]?.*\bgit(\.exe)?\b/i;

const DANGER_PATTERNS = [
  /\bpush\b/i,
  /(--force\b|--force-with-lease\b|--force-if-includes\b|(^|\s)-f(\s|$))/i,
  /\breset\b[\s\S]*--hard\b/i,
  /\bclean\b/i,
  /\bcheckout\b[\s\S]*(--\s*$|--\s|\s\.\s*$)/i,
  /\brestore\b/i,
  /\bbranch\b[\s\S]*-D\b/i,
];

/**
 * Loose textual gate: does this command mention "git" anywhere at all? Deliberately NOT the same
 * (stricter, word-boundary-anchored) check as isGitCommand below — a full-path invocation
 * (`...\git.exe push`) or a PowerShell variable-indirected call (`$g='git'; & $g push`) both still
 * contain the bare substring "git" even though isGitCommand's classification can miss them. This gate
 * exists purely to avoid false-positiving on ordinary, extremely common non-git commands that happen to
 * contain one of the DANGER_PATTERNS keywords — `mvn clean install`, `gradle clean build`, `dotnet
 * restore`, `docker push` — none of which mention "git" at all.
 */
const MENTIONS_GIT = /\bgit\b|git\.exe/i;

/**
 * Scans the raw command text for dangerous git-style keywords/flags without relying on isGitCommand's
 * (bypassable) classification — see isGitCommand below for why. Gated by MENTIONS_GIT so this only ever
 * fires on commands that actually reference git in some form; without that gate, ordinary build commands
 * like `gradle clean build` or `dotnet restore` would be wrongly blocked just for containing the words
 * "clean"/"restore". The full-path and PowerShell-indirection bypasses this is meant to catch both still
 * satisfy MENTIONS_GIT (the literal substring "git" is present either way), so this gate doesn't reopen
 * the hole — it only excludes commands that don't mention git in any form. The remaining trade-off is
 * intentionally conservative: a command that mentions "git" AND separately contains e.g. "push" for
 * unrelated reasons also gets blocked — acceptable for a pipeline whose only legitimate use of these
 * tokens together is git.
 */
export function isDangerousGitCommand(command: string): boolean {
  return MENTIONS_GIT.test(command) && DANGER_PATTERNS.some((p) => p.test(command));
}

/**
 * Best-effort git-invocation detection, used only to decide whether verifyGitRoot's repo-root check
 * applies below — NOT relied on for the danger blocklist above, which runs unconditionally regardless of
 * this. Covers the bare `git` word, full/relative path invocations (`...\git.exe`, `./git`), and
 * PowerShell's `&` call operator wrapping a literal (possibly quoted) git path. It does NOT resolve
 * variable indirection (`$g = 'git'; & $g status`) — that would require actually parsing/evaluating the
 * command, not just pattern-matching it. Missing that case here only means the git-root verification
 * safety net doesn't kick in for an indirected *harmless* git command; it does NOT reopen the security
 * hole above, since isDangerousGitCommand's blocklist scan is unconditional and still catches an
 * indirected *dangerous* one (e.g. `$g='git'; & $g push`) regardless of whether this function recognizes it.
 */
export function isGitCommand(command: string): boolean {
  return GIT_INVOKE.test(command) || GIT_POWERSHELL_CALL.test(command);
}

const LEADING_CD_PATTERN = /^\s*(?:cd|Set-Location|sl|pushd)\s+("[^"]+"|'[^']+'|\S+)\s*(?:&&|;)/i;

/** True if the command already opens with an explicit directory-change (`cd .../Set-Location .../sl .../pushd ...` followed by `&&` or `;`) — i.e. the caller has already taken responsibility for cwd, so nothing here should second-guess or override it. */
export function hasLeadingDirectoryChange(command: string): boolean {
  return LEADING_CD_PATTERN.test(command);
}

/** Best-effort extraction of a leading directory-change (bash `cd`, or PowerShell `Set-Location`/`sl`/`pushd`, followed by `&&` or `;`) from a shell command, resolved against cwd. Falls back to cwd itself when the command doesn't start by changing directory — this matters because the actual shell here is PowerShell (see runShell below), not bash. */
function resolveEffectiveDir(cwd: string, command: string): string {
  const match = command.match(LEADING_CD_PATTERN);
  if (!match) return cwd;
  const raw = match[1].replace(/^["']|["']$/g, "");
  return path.resolve(cwd, raw);
}

function runGit(cwd: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: timeoutMs }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

function isSameOrAncestor(root: string, resolved: string): boolean {
  const normRoot = path.resolve(root).toLowerCase();
  const normResolved = path.resolve(resolved).toLowerCase();
  return normResolved === normRoot || normResolved.startsWith(normRoot + path.sep);
}

/**
 * Verifies a git command's actual repo root (via `git rev-parse --show-toplevel`) matches one of
 * this projectDir's registered git roots, BEFORE letting the command run. This is what catches the
 * "projectDir/subdir has no .git, so git silently walks up to some unrelated ancestor repo (even a
 * whole drive root)" failure mode — registering a git root alone doesn't prevent it, only this check does.
 */
async function verifyGitRoot(
  cwd: string,
  command: string,
  gitRoots: GitRootEntry[] | null,
  timeoutMs: number
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!gitRoots || gitRoots.length === 0) {
    return {
      ok: false,
      message:
        "拒絕執行：這個專案還沒有登記過 git 版控根目錄。執行 git 指令前，請先問使用者「前端/後端原始碼各自的 git 版控根目錄在哪裡」（分開的 repo 要分別提供，共用同一個 repo 提供一個即可），再呼叫 register_git_roots 登記，才能繼續。",
    };
  }

  const effectiveDir = resolveEffectiveDir(cwd, command);
  const result = await runGit(effectiveDir, ["rev-parse", "--show-toplevel"], timeoutMs);
  if (!result.ok) {
    return {
      ok: false,
      message: `拒絕執行：在 ${effectiveDir} 底下找不到有效的 git repo（${result.stderr || "git rev-parse 失敗"}），跟已登記的 git 版控根目錄（${gitRoots
        .map((r) => `${r.label}: ${r.path}`)
        .join("；")}）對不起來，請先確認清楚再繼續，不要直接跑 git 指令。`,
    };
  }

  const resolvedRoot = result.stdout;
  const matched = gitRoots.some((r) => isSameOrAncestor(r.path, resolvedRoot) || isSameOrAncestor(resolvedRoot, r.path));
  if (!matched) {
    return {
      ok: false,
      message:
        `拒絕執行：這個指令實際解析到的 git repo root 是「${resolvedRoot}」，跟已登記的 git 版控根目錄（${gitRoots
          .map((r) => `${r.label}: ${r.path}`)
          .join("；")}）都對不起來——很可能是這個子目錄底下根本沒有自己的 .git，git 往上找到了不相干的 repo（例如整個磁碟機根目錄）。` +
        "已阻止執行，避免 git add/commit 誤動到不相干的內容，請先跟使用者確認清楚正確的 git 根目錄。",
    };
  }

  return { ok: true };
}

const MAX_OUTPUT_CHARS = 20000;
const DEFAULT_TIMEOUT_MS = 60000;

export interface ShellResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  blocked?: boolean;
  message?: string;
}

/** Runs a shell command scoped to `cwd`. Refuses git push / force-overwrite style invocations, and refuses any git invocation whose actual repo root doesn't match a registered git root for this project. */
export async function runShell(
  cwd: string,
  command: string,
  gitRoots: GitRootEntry[] | null,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<ShellResult> {
  if (isDangerousGitCommand(command)) {
    return {
      ok: false,
      blocked: true,
      stdout: "",
      stderr: "",
      message:
        "拒絕執行：這個指令看起來是 git push 或強制覆蓋類指令（push/--force/reset --hard/clean/checkout --/restore/branch -D 等）。" +
        "這個 pipeline 禁止這類指令，其餘 git 指令（commit/add/status/diff/log/merge/branch 建立等）可以正常使用。",
    };
  }

  if (isGitCommand(command)) {
    const verification = await verifyGitRoot(cwd, command, gitRoots, timeoutMs);
    if (!verification.ok) {
      return { ok: false, blocked: true, stdout: "", stderr: "", message: verification.message };
    }
  }

  const shell = process.platform === "win32" ? "powershell.exe" : "/bin/bash";
  const args = process.platform === "win32" ? ["-NoProfile", "-Command", command] : ["-c", command];

  return new Promise((resolve) => {
    execFile(shell, args, { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: stdout.slice(0, MAX_OUTPUT_CHARS),
        stderr: (stderr + (error && !stdout && !stderr ? String(error.message) : "")).slice(0, MAX_OUTPUT_CHARS),
      });
    });
  });
}
