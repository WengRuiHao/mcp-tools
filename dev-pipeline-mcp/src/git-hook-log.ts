import { appendFile, mkdir } from "node:fs/promises";
import { getDataDir, getGitHookEventsLogFile } from "./config-store.js";

/**
 * 純粹的稽核軌跡——記錄哪個 git 根目錄在什麼時候發生了 commit/merge，不做任何自動判斷。
 * 用途：事後比對 worktree-store.ts 各筆紀錄的 lastMergeCommit，人工抓出「不是透過
 * merge_ticket_worktree 產生、疑似繞過流程直接 commit」的異動。
 */
export async function appendGitHookLog(gitRoot: string, event: string): Promise<void> {
  const line = JSON.stringify({ at: new Date().toISOString(), gitRoot, event }) + "\n";
  await mkdir(getDataDir(), { recursive: true });
  await appendFile(getGitHookEventsLogFile(), line, "utf-8");
}
