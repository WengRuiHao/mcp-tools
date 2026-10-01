export const DEFAULT_BOARD_TTL_MS = 60_000;

export interface BoardFetchResult {
  board: any;
  /** true=這次沒有強制重抓，資料來自 asana-mcp 自己的快取 */
  fromCache: boolean;
  /** 使用快取時，距離上次強制重抓成功經過的秒數；強制重抓時為 null */
  ageSeconds: number | null;
}

export interface BoardFetcherDeps {
  call: (name: string, args: Record<string, unknown>) => Promise<any>;
  now: () => number;
  ttlMs?: number;
}

// 整份 board 很大（數十萬字），這裡只記「上次強制重抓成功的時間」，資料本體交給 asana-mcp 的快取（refresh:false 只要毫秒級）。
export function createBoardFetcher({ call, now, ttlMs = DEFAULT_BOARD_TTL_MS }: BoardFetcherDeps) {
  const lastRefreshedAt = new Map<string, number>();

  return async function fetchBoard(
    projectGid: string,
    { forceRefresh = false }: { forceRefresh?: boolean } = {}
  ): Promise<BoardFetchResult> {
    const last = lastRefreshedAt.get(projectGid);
    const age = last === undefined ? null : now() - last;
    const useCache = !forceRefresh && age !== null && age >= 0 && age < ttlMs;

    if (useCache) {
      // asana-mcp 的快取可能已被清空（行程重啟過）：快取路徑失敗就退回強制重抓，不把失敗直接回給呼叫端
      const cached = await call("asana_board", { projectGid, refresh: false }).catch(() => null);
      if (cached?.success === true) {
        return { board: cached, fromCache: true, ageSeconds: Math.floor((age as number) / 1000) };
      }
    }

    const board = await call("asana_board", { projectGid, refresh: true });
    // 失敗不更新時間，下一次仍會強制重抓
    if (board?.success === true) lastRefreshedAt.set(projectGid, now());
    return { board, fromCache: false, ageSeconds: null };
  };
}
