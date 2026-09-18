import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listWorktreeEntries, type WorktreeEntry } from "./worktree-store.js";
import { getPorcelainStatus, getChangedFilesSince } from "./git-utils.js";

/**
 * 跨 worktree 檔案重疊示警——設計上刻意不寫進被動報告（PENDING_HUMAN_ACTIONS.html），改成每次呼叫
 * 任何 dev-pipeline-mcp 工具的回應都附 activeWarnings 欄位，避免「記錄了但沒人看」。見記憶
 * project_dev_pipeline_worktree_design.md。真正的合併衝突仍然交給 git rebase/merge 判定，這裡只是
 * 提前示警，不做任何鎖定或阻擋。
 */
export interface OverlapWarning {
  gitRoot: string;
  file: string;
  worktreeIds: string[];
}

let cache: { computedAt: number; warnings: OverlapWarning[] } | null = null;
const CACHE_TTL_MS = 10_000;

/** git-native hook（post-commit/post-merge）偵測到有新 commit 時呼叫，讓下一次工具呼叫立刻拿到最新結果，不用等快取過期。 */
export function invalidateActiveWarningsCache(): void {
  cache = null;
}

async function computeOverlaps(): Promise<OverlapWarning[]> {
  const entries = (await listWorktreeEntries()).filter((e) => e.status === "active");
  const byGitRoot = new Map<string, WorktreeEntry[]>();
  for (const e of entries) {
    byGitRoot.set(e.gitRoot, [...(byGitRoot.get(e.gitRoot) ?? []), e]);
  }

  const warnings: OverlapWarning[] = [];
  for (const [gitRoot, group] of byGitRoot) {
    if (group.length < 2) continue; // 同一個 git 根目錄底下要有兩個以上的 active worktree 才可能重疊
    const fileToWorktrees = new Map<string, string[]>();
    for (const entry of group) {
      // 只看 git status 有個盲點：這輪一旦 commit 起來但還沒呼叫 merge_ticket_worktree，工作目錄會變乾淨，
      // status 完全看不到剛剛動過哪些檔案——所以要跟「相對 baseCommit 的 diff」取聯集，兩種狀態都算數。
      const files = new Set<string>();
      try {
        const touched = await getPorcelainStatus(entry.worktreePath);
        for (const t of touched) files.add(t.file);
      } catch {
        continue; // worktree 資料夾可能已經被人手動刪除——list_worktrees 的健檢負責抓這個，這裡靜默略過
      }
      try {
        const committed = await getChangedFilesSince(entry.worktreePath, entry.baseCommit);
        for (const f of committed) files.add(f);
      } catch {
        // baseCommit 理論上不該失效（merge_ticket_worktree 每次成功都會更新它），失效也只降級成只看 status，不中斷整體計算
      }
      for (const file of files) {
        fileToWorktrees.set(file, [...(fileToWorktrees.get(file) ?? []), entry.id]);
      }
    }
    for (const [file, worktreeIds] of fileToWorktrees) {
      if (worktreeIds.length >= 2) warnings.push({ gitRoot, file, worktreeIds });
    }
  }
  return warnings;
}

async function getOverlapWarnings(): Promise<OverlapWarning[]> {
  const now = Date.now();
  if (!cache || now - cache.computedAt > CACHE_TTL_MS) {
    cache = { computedAt: now, warnings: await computeOverlaps() };
  }
  return cache.warnings;
}

/** 給工具回應附加用的人類可讀訊息；沒有重疊時回傳空陣列（呼叫端據此決定要不要附加欄位，避免每個回應都多一個空陣列雜訊）。 */
export async function getActiveWarnings(): Promise<string[]> {
  const warnings = await getOverlapWarnings();
  return warnings.map(
    (w) => `跨 worktree 檔案重疊：${w.worktreeIds.join("、")} 都改到了 ${w.file}（${path.basename(w.gitRoot)}），合併前請注意可能的衝突。`
  );
}

function injectWarnings(result: any, warnings: string[]): any {
  if (warnings.length === 0) return result;
  if (!result || !Array.isArray(result.content)) return result;
  const content = result.content.map((item: any) => {
    if (item?.type !== "text" || typeof item.text !== "string") return item;
    let parsed: any;
    try {
      parsed = JSON.parse(item.text);
    } catch {
      return item; // 純文字回應（非 JSON payload），不動它
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return item;
    return { ...item, text: JSON.stringify({ ...parsed, activeWarnings: warnings }) };
  });
  return { ...result, content };
}

/**
 * 攔截 server.tool 的註冊，讓每一個工具呼叫完成後都自動附加 activeWarnings（只有真的有重疊時才附加）。
 * 必須在任何 registerXxxTools(server) 呼叫之前執行，這樣後續所有工具註冊都會套用到包過的版本。
 * McpServer.tool 是一般的 prototype 方法（非唯讀 getter），這裡用 instance own-property 蓋過去是安全的。
 */
export function installActiveWarnings(server: McpServer): void {
  const original = server.tool.bind(server) as (...args: any[]) => any;
  (server as any).tool = (...args: any[]) => {
    const lastIndex = args.length - 1;
    const handler = args[lastIndex];
    if (typeof handler === "function") {
      args[lastIndex] = async (...handlerArgs: any[]) => {
        const result = await handler(...handlerArgs);
        const warnings = await getActiveWarnings().catch(() => []); // 示警機制本身絕不能讓原本的工具呼叫失敗
        return injectWarnings(result, warnings);
      };
    }
    return original(...args);
  };
}
