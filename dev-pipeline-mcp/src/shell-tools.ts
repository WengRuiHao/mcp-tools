import { execFile, spawn } from "node:child_process";
import path from "node:path";
import type { GitRootEntry } from "./git-roots-store.js";
import { truncateHeadTail } from "./output-limit.js";

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
function resolveEffectiveDir(cwd: string, command: string): { dir: string; fromLeadingCd: boolean } {
  const match = command.match(LEADING_CD_PATTERN);
  if (!match) return { dir: cwd, fromLeadingCd: false };
  const raw = match[1].replace(/^["']|["']$/g, "");
  return { dir: path.resolve(cwd, raw), fromLeadingCd: true };
}

/** 說明 git 根目錄驗證「實際檢查的目錄」是怎麼決定的，附在拒絕訊息裡讓呼叫端知道為什麼誤判、怎麼改寫。 */
function describeCheckedDir(dir: string, fromLeadingCd: boolean): string {
  const how = fromLeadingCd
    ? "取自指令開頭的 Set-Location/cd/sl/pushd（需緊接 `;`）"
    : "指令開頭沒有 `Set-Location <目錄>;`（或 cd/sl/pushd），所以用的是執行目錄（專案目錄，或唯一登記的 git 根目錄）";
  return (
    `驗證實際檢查的目錄是「${dir}」（${how}）。驗證只看指令「最開頭」的目錄切換，不會解析中途的 Set-Location，` +
    "因此 `某語句; Set-Location x; git ...` 會被當成在執行目錄跑。可行寫法：指令以 `Set-Location <子目錄>;` 開頭再接 git 指令，或把指令拆成多次呼叫（每次呼叫都是獨立的 shell，切換目錄不會保留，所以每次都要以 Set-Location 開頭）。"
  );
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
        "拒絕執行：這個專案還沒有登記過 git 版控根目錄。執行 git 指令前，請先問使用者「前端/後端原始碼各自的 git 版控根目錄在哪裡」（分開的 repo 要分別提供，共用同一個 repo 提供一個即可），再呼叫 project_config(kind='git_roots', action='register') 登記，才能繼續。",
    };
  }

  const { dir: effectiveDir, fromLeadingCd } = resolveEffectiveDir(cwd, command);
  const dirNote = describeCheckedDir(effectiveDir, fromLeadingCd);
  const result = await runGit(effectiveDir, ["rev-parse", "--show-toplevel"], timeoutMs);
  if (!result.ok) {
    return {
      ok: false,
      message: `拒絕執行：在 ${effectiveDir} 底下找不到有效的 git repo（${result.stderr || "git rev-parse 失敗"}），跟已登記的 git 版控根目錄（${gitRoots
        .map((r) => `${r.label}: ${r.path}`)
        .join("；")}）對不起來，請先確認清楚再繼續，不要直接跑 git 指令。${dirNote}`,
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
        "已阻止執行，避免 git add/commit 誤動到不相干的內容，請先跟使用者確認清楚正確的 git 根目錄。" +
        dirNote,
    };
  }

  return { ok: true };
}

const OUTPUT_HEAD_CHARS = 3000;
const OUTPUT_TAIL_CHARS = 9000;
const DEFAULT_TIMEOUT_MS = 60000;
export const MAX_TIMEOUT_MS = 600000;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

export interface ShellResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  blocked?: boolean;
  message?: string;
  /** 只有失敗時才有；被訊號終止/逾時時為 null */
  exitCode?: number | null;
  timedOut?: boolean;
  /** 只有任一串流被截斷時才出現 */
  truncated?: { stdout: boolean; stderr: boolean };
  originalChars?: { stdout: number; stderr: number };
}

/** 編譯/測試的錯誤摘要多半在輸出最後面，所以截斷時結尾保留得比開頭多。 */
function limitOutput(stdout: string, stderr: string): Pick<ShellResult, "stdout" | "stderr" | "truncated" | "originalChars"> {
  const out = truncateHeadTail(stdout, { head: OUTPUT_HEAD_CHARS, tail: OUTPUT_TAIL_CHARS });
  const err = truncateHeadTail(stderr, { head: OUTPUT_HEAD_CHARS, tail: OUTPUT_TAIL_CHARS });
  const base = { stdout: out.text, stderr: err.text };
  if (!out.truncated && !err.truncated) return base;
  return {
    ...base,
    truncated: { stdout: out.truncated, stderr: err.truncated },
    originalChars: { stdout: out.originalChars, stderr: err.originalChars },
  };
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
  const effectiveTimeout = Math.min(Math.max(Math.floor(timeoutMs) || DEFAULT_TIMEOUT_MS, 1), MAX_TIMEOUT_MS);
  return spawnCollect(shell, args, cwd, effectiveTimeout);
}

function killTree(pid: number | undefined, child: ReturnType<typeof spawn>): void {
  if (process.platform === "win32" && pid) {
    // child.kill() 只會殺 powershell，它底下的 node/測試程序會繼續活著並握住 pipe，要連同子孫一起殺。
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], () => undefined);
  }
  child.kill("SIGKILL");
}

/**
 * 自己收集輸出（而不是 execFile）：逾時/maxBuffer 時主動殺整棵程序樹並立刻回傳已收集到的部分，
 * 且一律保留 exitCode，不會只剩 Node 的 "Command failed: ..." 一行。
 */
function spawnCollect(shell: string, args: string[], cwd: string, timeoutMs: number): Promise<ShellResult> {
  return new Promise((resolve) => {
    const child = spawn(shell, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let settled = false;
    let timedOut = false;
    let overflow = false;

    const finish = (exitCode: number | null, spawnError?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8");
      if (timedOut) {
        resolve({
          ok: false,
          timedOut: true,
          exitCode,
          ...limitOutput(stdout, stderr),
          message: `逾時 ${timeoutMs} ms，已中止；可調高 timeoutMs 或改用背景/導到檔案`,
        });
      } else if (overflow || spawnError || exitCode !== 0) {
        const message = spawnError
          ? `無法啟動 shell：${spawnError.message}`
          : overflow
            ? `輸出超過 ${MAX_BUFFER_BYTES} bytes 上限，已中止；請把輸出導到檔案再讀`
            : `指令以結束碼 ${exitCode} 結束`;
        resolve({ ok: false, exitCode, ...limitOutput(stdout, stderr), message });
      } else {
        resolve({ ok: true, ...limitOutput(stdout, stderr) });
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid, child);
      // 不等 close：孫程序可能還握著 pipe，直接回傳已收集到的部分
      setTimeout(() => finish(null), 200);
    }, timeoutMs);

    child.stdout!.on("data", (d: Buffer) => {
      outBytes += d.length;
      if (outBytes > MAX_BUFFER_BYTES) {
        if (!overflow) { overflow = true; killTree(child.pid, child); }
        return;
      }
      out.push(d);
    });
    child.stderr!.on("data", (d: Buffer) => {
      errBytes += d.length;
      if (errBytes > MAX_BUFFER_BYTES) {
        if (!overflow) { overflow = true; killTree(child.pid, child); }
        return;
      }
      err.push(d);
    });
    child.on("error", (e) => finish(null, e));
    child.on("close", (code) => finish(code));
  });
}
