/**
 * 連線檔裡的「伺服器」項目展開成一個個 repo 連線。
 *
 * 伺服器項目 = 上層網址（Apache `SVNParentPath`，底下每個子目錄是一個 repo）＋一組帳密＋載入過的 repo 名稱清單。
 * 展開後每個 repo 都是一般的 SvnConnection（名稱＝repo 名稱、網址＝上層網址/repo、共用同一組帳密），
 * 所以唯讀工具、svn-edit、批次上傳都不用知道「伺服器」這個概念。
 *
 * 純函式、不碰檔案也不連網路：唯讀的 MCP 工具也會 import 這支。
 */
export interface StoredConnectionEntry {
  id: string;
  name: string;
  url: string;
  username: string;
  password: string;
  /** "server" 代表這筆是上層網址（底下有很多 repo），其餘（沒有這個欄位）是單一 repo 的一般連線。 */
  kind?: "server";
  /** 伺服器項目最近一次載入的 repo 名稱。 */
  repos?: string[];
  [extra: string]: unknown;
}

export interface ExpandedConnection {
  id: string;
  name: string;
  url: string;
  username: string;
  password: string;
  /** 這個 repo 連線來自哪個伺服器項目（一般連線沒有）。 */
  serverId?: string;
}

/** 展開後 repo 連線的 id：伺服器 id 加 repo 名稱，伺服器 id 不變就不會變，編輯中的項目重啟後仍找得到。 */
export function repoConnectionId(serverId: string, repo: string): string {
  return `${serverId}:${repo}`;
}

function sameUrl(a: string, b: string): boolean {
  return a.replace(/\/+$/, "").toLowerCase() === b.replace(/\/+$/, "").toLowerCase();
}

/** 一般連線排前面且優先：同名或同網址的 repo 以使用者明確登記的那筆為準，不會重複出現。 */
export function expandConnections(entries: readonly StoredConnectionEntry[]): ExpandedConnection[] {
  const result: ExpandedConnection[] = entries
    .filter((e) => e.kind !== "server")
    .map((e) => ({ id: e.id, name: e.name, url: e.url, username: e.username, password: e.password }));

  for (const server of entries.filter((e) => e.kind === "server")) {
    const base = server.url.replace(/\/+$/, "");
    for (const repo of server.repos ?? []) {
      const url = `${base}/${repo}`;
      if (result.some((c) => c.name === repo || sameUrl(c.url, url))) continue;
      result.push({ id: repoConnectionId(server.id, repo), name: repo, url, username: server.username, password: server.password, serverId: server.id });
    }
  }
  return result;
}
