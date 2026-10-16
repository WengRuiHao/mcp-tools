/**
 * 各帳號底下 repo 清單的快取（info/svn-repos-cache.json）。
 *
 * 連線檔只存帳號；repo 清單是「向伺服器問來的結果」，放在獨立的快取檔，壞了或不見都可以重新讀。
 * svn-edit（使用者按儲存／重新載入）與唯讀的 MCP 工具（快取沒有或找不到 repo 時自動補）都會寫，
 * 所以一律「先寫同目錄暫存檔再改名」，並在同一個行程內排隊，避免寫到一半被讀到或互相蓋掉。
 */
import type { RepoCache, RepoCacheEntry, StoredConnectionEntry } from "./connection-expand.js";
import { readProfile, updateProfile } from "./profile-store.js";
import { fetchServerRepos } from "./server-repos.js";

/** 快取超過這麼久，而且「找不到要的 repo」時才會重新向伺服器讀（平常不連網）。 */
export const REPO_CACHE_STALE_MS = 10 * 60 * 1000;

/** 讀快取（單一設定檔的 repoCache 區塊）；檔案不存在、壞掉一律當成空的（快取不是正本，不能因為它壞掉就整個不能用）。 */
export async function readRepoCache(): Promise<RepoCache> {
  return (await readProfile()).repoCache;
}

/** 更新（或用 null 刪除）某個帳號的快取；在跨程式的鎖裡讀現況再原子寫回。 */
export async function setRepoCacheEntry(serverId: string, entry: RepoCacheEntry | null): Promise<void> {
  await updateProfile((profile) => {
    const repoCache = { ...profile.repoCache };
    if (entry) repoCache[serverId] = entry;
    else delete repoCache[serverId];
    return { ...profile, repoCache };
  });
}

export function newCacheEntry(repos: string[], auth?: RepoCacheEntry["auth"]): RepoCacheEntry {
  return { repos, fetchedAt: new Date().toISOString(), auth };
}

/** 快取是不是已經超過 REPO_CACHE_STALE_MS（沒有 fetchedAt 也算過期）。 */
export function isStale(entry: RepoCacheEntry | undefined, now = Date.now()): boolean {
  const at = entry?.fetchedAt ? Date.parse(entry.fetchedAt) : NaN;
  return !Number.isFinite(at) || now - at > REPO_CACHE_STALE_MS;
}

/**
 * 對指定的帳號向伺服器重新讀 repo 清單並寫進快取；單一帳號失敗不影響其他（回傳每個帳號的結果）。
 * MCP 唯讀工具用它在「快取還沒有」或「找不到 repo」時自動補，所以只做讀取（HTTP GET 索引），不會改動 SVN。
 */
export async function refreshRepoCache(servers: readonly StoredConnectionEntry[]): Promise<RepoCache> {
  for (const server of servers) {
    try {
      const { repos, auth } = await fetchServerRepos({ url: server.url, username: server.username, password: server.password });
      await setRepoCacheEntry(server.id, newCacheEntry(repos, auth));
    } catch {
      // 連不上就維持原本的快取；呼叫端會用既有資料（或別名）繼續找
    }
  }
  return readRepoCache();
}
