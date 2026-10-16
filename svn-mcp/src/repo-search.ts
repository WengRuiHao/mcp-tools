/**
 * 依關鍵字找專案庫（repo）：給 AI 用的搜尋（svn_find_repo 工具），也是「使用者說的名稱 → 該用哪個 connectionId、
 * 檔案大概在哪個目錄」的唯一入口。
 *
 * 使用者口中的專案可能是：repo 名稱、舊版取的名稱（別名，例如「專案甲」）、自己取的簡稱（例如「丙銀」），
 * 甚至是某個常用目錄的暱稱（例如「後端規格」）。所以一個關鍵字會同時比對這四種；多個關鍵字（空白隔開）要全部符合。
 * 純函式、不碰檔案也不連網路。
 */
import { expandConnections, type ExpandedConnection, type RepoCache, type StoredConnectionEntry } from "./connection-expand.js";
import type { RepoPrefs } from "./prefs-model.js";

export interface RepoFolderInfo {
  /** 相對於 repo 根目錄的路徑，可以直接填給 svn_browse／svn_cat 的 path。 */
  path: string;
  nickname: string | null;
  /** 這次搜尋有比對到這個常用目錄（暱稱或路徑）。 */
  matched: boolean;
}

export interface RepoSearchHit {
  /** 填給 svn_browse、svn_cat 等工具的 connectionId（就是 repo 名稱，保證唯一）。 */
  connectionId: string;
  name: string;
  url: string;
  nickname: string | null;
  /** 舊版取的名稱，也都能當 connectionId 用。 */
  aliases: string[];
  starred: boolean;
  lastOpened: string | null;
  /** 這個專案的常用目錄（含暱稱）；比對到的排在前面。 */
  folders: RepoFolderInfo[];
  /** 這次是比對到哪些東西，例如「名稱」「簡稱」「常用目錄暱稱：後端規格」。 */
  matchedOn: string[];
  score: number;
}

const DEFAULT_LIMIT = 10;

function norm(text: string): string {
  return text.toLowerCase().trim();
}

/** 一個關鍵字對一段文字的比對分數：完全相同 > 開頭相同 > 包含；沒比對到回傳 0。 */
function fieldScore(token: string, field: string, exact: number, prefix: number, contains: number): number {
  const f = norm(field);
  if (!f) return 0;
  if (f === token) return exact;
  if (f.startsWith(token)) return prefix;
  if (f.includes(token)) return contains;
  return 0;
}

interface TokenMatch {
  score: number;
  reasons: string[];
  folderPaths: string[];
}

/** 一個關鍵字對一個 repo 的最佳比對；完全沒有比對到回傳 null。 */
function matchToken(token: string, conn: ExpandedConnection, prefs: RepoPrefs): TokenMatch | null {
  let best = 0;
  const reasons: string[] = [];
  const folderPaths: string[] = [];
  const consider = (score: number, reason: string): void => {
    if (score <= 0) return;
    best = Math.max(best, score);
    if (!reasons.includes(reason)) reasons.push(reason);
  };

  consider(fieldScore(token, conn.name, 100, 70, 40), "名稱");
  for (const alias of conn.aliases) consider(fieldScore(token, alias, 95, 65, 38), `舊名稱：${alias}`);
  const nickname = prefs.nicknames[conn.name];
  if (nickname) consider(fieldScore(token, nickname, 100, 70, 40), `簡稱：${nickname}`);

  const folderNicks = prefs.folderNicknames[conn.name] ?? {};
  for (const folder of prefs.folders[conn.name] ?? []) {
    const nick = folderNicks[folder];
    const nickScore = nick ? fieldScore(token, nick, 60, 45, 25) : 0;
    const pathScore = fieldScore(token, folder, 20, 15, 12);
    if (nickScore > 0) consider(nickScore, `常用目錄暱稱：${nick}`);
    if (pathScore > 0) consider(pathScore, `常用目錄路徑：${folder}`);
    if (nickScore > 0 || pathScore > 0) folderPaths.push(folder);
  }
  return best > 0 ? { score: best, reasons, folderPaths } : null;
}

/**
 * 找專案庫。關鍵字空白＝列出「常用」：星星專案（照畫面順序）在最前面，其次是最近開過的。
 * 排序：分數高的在前；同分時星星專案優先、再來是最近開過的、最後是名稱。
 */
export function searchRepos(
  accounts: readonly StoredConnectionEntry[],
  cache: RepoCache,
  prefs: RepoPrefs,
  query: string,
  limit: number = DEFAULT_LIMIT
): RepoSearchHit[] {
  const tokens = norm(query).split(/\s+/).filter(Boolean);
  const cap = Math.max(1, Math.min(limit, 200));
  const hits: RepoSearchHit[] = [];

  for (const conn of expandConnections(accounts, cache)) {
    const starIndex = prefs.starred.indexOf(conn.name);
    let score = starIndex >= 0 ? 5 : 0;
    const reasons: string[] = [];
    const matchedFolders = new Set<string>();
    let ok = true;
    for (const token of tokens) {
      const m = matchToken(token, conn, prefs);
      if (!m) {
        ok = false;
        break;
      }
      score += m.score;
      m.reasons.forEach((r) => !reasons.includes(r) && reasons.push(r));
      m.folderPaths.forEach((p) => matchedFolders.add(p));
    }
    if (!ok) continue;

    const nicks = prefs.folderNicknames[conn.name] ?? {};
    const folders: RepoFolderInfo[] = (prefs.folders[conn.name] ?? []).map((path) => ({ path, nickname: nicks[path] ?? null, matched: matchedFolders.has(path) }));
    folders.sort((a, b) => Number(b.matched) - Number(a.matched));
    hits.push({
      connectionId: conn.name,
      name: conn.name,
      url: conn.url,
      nickname: prefs.nicknames[conn.name] ?? null,
      aliases: conn.aliases,
      starred: starIndex >= 0,
      lastOpened: prefs.recent[conn.name] ?? null,
      folders,
      matchedOn: tokens.length ? reasons : [starIndex >= 0 ? "星星專案" : prefs.recent[conn.name] ? "最近開過" : "全部專案"],
      score,
    });
  }

  const starRank = (h: RepoSearchHit): number => (h.starred ? prefs.starred.indexOf(h.name) : Number.MAX_SAFE_INTEGER);
  hits.sort((a, b) => {
    if (tokens.length && b.score !== a.score) return b.score - a.score;
    if (a.starred !== b.starred) return a.starred ? -1 : 1;
    if (a.starred && b.starred && starRank(a) !== starRank(b)) return starRank(a) - starRank(b);
    const ra = a.lastOpened ?? "";
    const rb = b.lastOpened ?? "";
    if (ra !== rb) return ra < rb ? 1 : -1;
    return a.name.localeCompare(b.name, "zh-Hant");
  });
  return hits.slice(0, cap);
}
