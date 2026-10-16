/**
 * 連線檔裡的「帳號（伺服器）」項目展開成一個個 repo 連線。
 *
 * 連線檔只存帳號：上層網址（Apache `SVNParentPath`，底下每個子目錄是一個 repo）＋名稱＋帳密。
 * 底下有哪些 repo 不存在連線檔，而是放在獨立的快取檔（見 repo-cache.ts），要更新就向伺服器重新讀。
 * 展開後每個 repo 都是一般的 SvnConnection（名稱＝repo 名稱、網址＝上層網址/repo、共用同一組帳密），
 * 所以唯讀工具、svn-edit、批次上傳都不用知道「帳號」這個概念。
 *
 * 別名（aliases）：舊版一個 repo 一筆連線時取的名稱（例如「專案甲」）。其他工具（dev-pipeline 的設定）
 * 還用這些名稱找連線，所以帳號項目裡留一張「別名 → repo 名稱」的對照表；別名也會顯示在畫面上，
 * 之後要做的「標註星星／快速搜尋」可以直接掛在上面。legacyIds 是舊版連線的 id，只拿來查找，不顯示。
 *
 * 純函式、不碰檔案也不連網路：唯讀的 MCP 工具也會 import 這支。
 */
export interface StoredConnectionEntry {
  id: string;
  name: string;
  url: string;
  username: string;
  password: string;
  /** "server" 代表這筆是帳號（上層網址，底下有很多 repo）；沒有這個欄位的是舊版「單一 repo 連線」，啟動時會被遷移掉。 */
  kind?: "server";
  /** 舊版把 repo 名稱存在連線檔裡；現在改放快取檔，遷移時搬走。 */
  repos?: string[];
  /** 別名 → repo 名稱。 */
  aliases?: Record<string, string>;
  /** 舊版連線 id → repo 名稱（只用來查找）。 */
  legacyIds?: Record<string, string>;
  [extra: string]: unknown;
}

/** 某個帳號最近一次向伺服器讀到的 repo 清單。 */
export interface RepoCacheEntry {
  repos: string[];
  /** ISO 時間。 */
  fetchedAt: string;
  auth?: "credentials" | "windows";
}

/** 帳號 id → 該帳號的 repo 清單快取。 */
export type RepoCache = Record<string, RepoCacheEntry>;

export interface ExpandedConnection {
  id: string;
  name: string;
  url: string;
  username: string;
  password: string;
  /** 這個 repo 連線來自哪個帳號項目（舊版單一連線沒有）。 */
  serverId?: string;
  /** 這個 repo 的別名（所有帳號項目的別名合併，不含舊 id）。 */
  aliases: string[];
}

/** 展開後 repo 連線的 id：帳號 id 加 repo 名稱，帳號 id 不變就不會變，編輯中的項目重啟後仍找得到。 */
export function repoConnectionId(serverId: string, repo: string): string {
  return `${serverId}:${repo}`;
}

function sameUrl(a: string, b: string): boolean {
  return a.replace(/\/+$/, "").toLowerCase() === b.replace(/\/+$/, "").toLowerCase();
}

/** 帳號底下的 repo 名稱：快取（沒有就用舊版存在連線檔裡的）加上別名指到的 repo（別名一定要查得到，就算快取還沒更新）。 */
function reposOf(server: StoredConnectionEntry, cache: RepoCache): string[] {
  const names = [...(cache[server.id]?.repos ?? server.repos ?? [])];
  for (const repo of Object.values(server.aliases ?? {})) if (!names.includes(repo)) names.push(repo);
  for (const repo of Object.values(server.legacyIds ?? {})) if (!names.includes(repo)) names.push(repo);
  return names;
}

function build(server: StoredConnectionEntry, repo: string, aliasesByRepo: Map<string, string[]>): ExpandedConnection {
  const base = server.url.replace(/\/+$/, "");
  return {
    id: repoConnectionId(server.id, repo),
    name: repo,
    url: `${base}/${repo}`,
    username: server.username,
    password: server.password,
    serverId: server.id,
    aliases: aliasesByRepo.get(repo) ?? [],
  };
}

function aliasIndex(servers: readonly StoredConnectionEntry[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const server of servers) {
    for (const [alias, repo] of Object.entries(server.aliases ?? {})) {
      const list = index.get(repo) ?? [];
      if (!list.includes(alias)) list.push(alias);
      index.set(repo, list);
    }
  }
  return index;
}

/** 舊版單一連線排前面且優先；同名或同網址的 repo 只留第一個（同一個 repo 出現在好幾個帳號底下時，以排在前面的帳號為準）。 */
export function expandConnections(entries: readonly StoredConnectionEntry[], cache: RepoCache = {}): ExpandedConnection[] {
  const servers = entries.filter((e) => e.kind === "server");
  const aliasesByRepo = aliasIndex(servers);
  const result: ExpandedConnection[] = entries
    .filter((e) => e.kind !== "server")
    .map((e) => ({ id: e.id, name: e.name, url: e.url, username: e.username, password: e.password, aliases: [] }));

  for (const server of servers) {
    for (const repo of reposOf(server, cache)) {
      const connection = build(server, repo, aliasesByRepo);
      if (result.some((c) => c.name === repo || sameUrl(c.url, connection.url))) continue;
      result.push(connection);
    }
  }
  return result;
}

/**
 * 依「id、名稱、別名、舊 id、簡稱」找連線。別名與舊 id 會用「擁有這個別名的那個帳號」的帳密，
 * 所以舊版「專案甲」這種名稱，仍然是用當初設定的那組帳號去連（就算同一個 repo 也出現在別的帳號底下）。
 */
export function findConnection(entries: readonly StoredConnectionEntry[], cache: RepoCache, target: string, nicknames: Readonly<Record<string, string>> = {}): ExpandedConnection | undefined {
  const expanded = expandConnections(entries, cache);
  const direct = expanded.find((c) => c.id === target || c.name === target);
  if (direct) return direct;
  const servers = entries.filter((e) => e.kind === "server");
  const aliasesByRepo = aliasIndex(servers);
  for (const server of servers) {
    const repo = server.aliases?.[target] ?? server.legacyIds?.[target];
    if (repo) return build(server, repo, aliasesByRepo);
  }
  // 使用者自己替專案取的簡稱也能當 connectionId；同一個簡稱對到好幾個專案就無法判斷，當作找不到（不要猜）
  const byNickname = expanded.filter((c) => nicknames[c.name] === target);
  return byNickname.length === 1 ? byNickname[0] : undefined;
}

/** 目前所有查得到的名稱（repo 名稱、別名、簡稱），給「找不到連線」的錯誤訊息用。 */
export function knownNames(entries: readonly StoredConnectionEntry[], cache: RepoCache, nicknames: Readonly<Record<string, string>> = {}): string[] {
  const names = new Set<string>();
  for (const c of expandConnections(entries, cache)) {
    names.add(c.name);
    for (const alias of c.aliases) names.add(alias);
    if (nicknames[c.name]) names.add(nicknames[c.name]);
  }
  return [...names];
}
