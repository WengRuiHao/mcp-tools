/**
 * svn-edit 設定頁用的連線（帳號）讀寫。讀寫的是跟 svn-mcp 唯讀工具「同一份」`svn-connections.json`
 * （路徑由 config-store 的 getConnectionsFilePath 決定；單一檔案的格式見 profile-store.ts）。
 *
 * 這裡管的是檔案裡的 `accounts` 區塊：名稱、上層網址、帳號、密碼，加上給舊名稱用的別名對照（見 connection-expand.ts）。
 * 底下有哪些 repo 放在同一個檔案的 `repoCache` 區塊（repo-cache.ts），要更新就向伺服器重新讀。
 *
 * - 密碼永遠不會回傳給呼叫端（編輯時密碼留空代表不變更）；
 * - 新增、更新帳號都會**先實際連線測試**（讀得到 repo 清單才存），失敗就不存、回傳原因；
 * - 寫入走 profile-store 的 updateProfile（跨程式的鎖＋原子寫入）：網路測試先做完，再進鎖裡一次完成「重讀、套用、寫回」，
 *   所以不會蓋掉別的程式（例如 MCP 補 repo 快取、另一個視窗存星星）剛寫的內容；
 * - 檔案存在但不是合法 JSON 時一律拒絕寫入，絕不覆蓋可能是人工維護、一時壞掉的檔案；
 * - 設定頁只允許 http／https 協定的網址（不允許 file://）。
 */
import { randomUUID } from "node:crypto";
import { copyFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getConnectionsFilePath } from "./config-store.js";
import { expandConnections, type StoredConnectionEntry } from "./connection-expand.js";
import { readProfileStrict, updateProfile, type Profile } from "./profile-store.js";
import { newCacheEntry, setRepoCacheEntry } from "./repo-cache.js";
import { fetchServerRepos, ServerReposError, type ServerAuthMode } from "./server-repos.js";

export interface PublicConnection {
  id: string;
  name: string;
  url: string;
  username: string;
  /** 這個 repo 的別名（舊版連線取的名稱）。 */
  aliases: string[];
}

export interface PublicServer {
  id: string;
  name: string;
  url: string;
  username: string;
  repoCount: number;
  /** 這個帳號有哪些別名（舊名稱 → repo）。 */
  aliases: Record<string, string>;
  /** 這次連線測試用哪種方式驗證成功（只有剛儲存／測試／重新載入時才有）。 */
  auth?: ServerAuthMode;
}

export interface ServerInput {
  /** 有值代表編輯既有帳號；沒有代表新增。 */
  id?: string;
  name?: string;
  url: string;
  username: string;
  /** 選填：Windows 整合驗證的伺服器用不到；編輯時留空代表沿用原本的密碼。 */
  password?: string;
}

export interface ServerTestResult {
  repoCount: number;
  auth: ServerAuthMode;
}

type StoredConnection = StoredConnectionEntry;

const MAX_NAME_LENGTH = 60;

export class ConnectionInputError extends Error {}

/** 嚴格讀取所有帳號：設定檔壞掉（不是合法 JSON）就丟錯誤，不能拿壞掉的檔案當依據去寫。 */
async function readAll(): Promise<StoredConnection[]> {
  return (await readProfileStrict()).accounts;
}

/** 在跨程式的鎖裡改帳號清單；cache 有給就一併更新對應帳號的 repo 清單（同一次寫入完成）。 */
function updateAccounts(change: (accounts: StoredConnection[], profile: Profile) => StoredConnection[]): Promise<Profile> {
  return updateProfile((profile) => ({ ...profile, accounts: change(profile.accounts, profile) }));
}

/** 同一時間只允許一個寫入，避免兩個設定請求互相蓋掉。 */
let writeQueue: Promise<unknown> = Promise.resolve();

function queued<T>(task: () => Promise<T>): Promise<T> {
  const next = writeQueue.catch(() => undefined).then(task);
  writeQueue = next;
  return next;
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toPublicServer(server: StoredConnection, repoCount: number, auth?: ServerAuthMode): PublicServer {
  return { id: server.id, name: server.name, url: server.url, username: server.username, repoCount, aliases: server.aliases ?? {}, ...(auth ? { auth } : {}) };
}

/** 所有 repo 連線（帳號底下的 repo，下拉選單、瀏覽、上傳都用這份）；不含密碼。 */
export async function listPublicConnections(): Promise<PublicConnection[]> {
  const profile = await readProfileStrict();
  return expandConnections(profile.accounts, profile.repoCache).map((c) => ({ id: c.id, name: c.name, url: c.url, username: c.username, aliases: c.aliases }));
}

/** 所有帳號（設定頁列出來給使用者編輯、刪除的就是這份）；不含密碼。 */
export async function listPublicServers(): Promise<PublicServer[]> {
  const profile = await readProfileStrict();
  return profile.accounts.filter((c) => c.kind === "server").map((c) => toPublicServer(c, profile.repoCache[c.id]?.repos.length ?? c.repos?.length ?? 0));
}

function hostOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`.replace(/\/+$/, "");
  } catch {
    return url;
  }
}

async function loadRepos(url: string, username: string, password: string): Promise<{ repos: string[]; auth: ServerAuthMode }> {
  try {
    return await fetchServerRepos({ url, username, password });
  } catch (e) {
    if (e instanceof ServerReposError) throw new ConnectionInputError(e.message);
    throw e;
  }
}

interface NormalizedServerInput {
  name: string;
  url: string;
  username: string;
  password: string;
}

/** 檢查並整理使用者填的內容；編輯既有帳號時，沒填的密碼沿用原本的。 */
function normalizeServerInput(input: ServerInput, existing: StoredConnection | undefined): NormalizedServerInput {
  const url = clean(input.url).replace(/\/+$/, "");
  const name = clean(input.name) || existing?.name || hostOf(url);
  const username = clean(input.username) || os.userInfo().username;
  const typedPassword = typeof input.password === "string" ? input.password : "";
  if (name.length > MAX_NAME_LENGTH) throw new ConnectionInputError(`名稱太長（上限 ${MAX_NAME_LENGTH} 字）`);
  if (!/^https?:\/\/\S+$/i.test(url)) throw new ConnectionInputError("伺服器網址必須以 https:// 或 http:// 開頭");
  return { name, url, username, password: typedPassword || existing?.password || "" };
}

/** 測試連線但不儲存：用填的內容實際向伺服器讀 repo 清單。編輯既有帳號時，密碼留空就用已存的。 */
export async function testServerLogin(input: ServerInput): Promise<ServerTestResult> {
  const all = await readAll();
  const existing = input.id ? all.find((c) => c.kind === "server" && c.id === input.id) : undefined;
  if (input.id && !existing) throw new ConnectionInputError(`找不到要測試的帳號：${input.id}`);
  const { url, username, password } = normalizeServerInput(input, existing);
  const { repos, auth } = await loadRepos(url, username, password);
  return { repoCount: repos.length, auth };
}

/** 新增或編輯帳號：先實際連線測試（讀得到底下的 repo 才存），讀不到就不存、回傳原因。 */
export function saveServer(input: ServerInput): Promise<PublicServer> {
  return queued(async () => {
    const all = await readAll();
    // 沒指定 id 但網址與帳號已經登記過，視為更新同一個帳號（重填密碼），不重複新增
    const existing = all.find((c) => c.kind === "server" && (input.id ? c.id === input.id : c.url.toLowerCase() === clean(input.url).replace(/\/+$/, "").toLowerCase() && c.username.toLowerCase() === (clean(input.username) || os.userInfo().username).toLowerCase()));
    if (input.id && !existing) throw new ConnectionInputError(`找不到要編輯的帳號：${input.id}`);
    const { name, url, username, password } = normalizeServerInput(input, existing);
    if (all.some((c) => c.kind === "server" && c.name === name && c.id !== existing?.id)) throw new ConnectionInputError(`已經有名稱為「${name}」的帳號`);

    const { repos, auth } = await loadRepos(url, username, password); // 網路先做完，再進鎖裡寫
    let saved: StoredConnection | undefined;
    await updateProfile((profile) => {
      const current = existing ? profile.accounts.find((c) => c.id === existing.id) : undefined;
      if (existing && !current) throw new ConnectionInputError(`找不到要編輯的帳號：${existing.id}`);
      if (profile.accounts.some((c) => c.kind === "server" && c.name === name && c.id !== current?.id)) throw new ConnectionInputError(`已經有名稱為「${name}」的帳號`);
      const { repos: _legacyRepos, ...rest } = current ?? ({} as StoredConnection);
      const account: StoredConnection = { ...rest, id: current?.id ?? randomUUID(), name, url, username, password, kind: "server" };
      saved = account;
      return {
        ...profile,
        accounts: current ? profile.accounts.map((c) => (c.id === current.id ? account : c)) : [...profile.accounts, account],
        repoCache: { ...profile.repoCache, [account.id]: newCacheEntry(repos, auth) },
      };
    });
    return toPublicServer(saved as StoredConnection, repos.length, auth);
  });
}

/** 重新向伺服器讀某個帳號底下的 repo 清單（伺服器上新建了 repo 時用）。 */
export function refreshServer(id: string): Promise<PublicServer> {
  return queued(async () => {
    const server = (await readAll()).find((c) => c.id === id && c.kind === "server");
    if (!server) throw new ConnectionInputError(`找不到帳號：${id}`);
    const { repos, auth } = await loadRepos(server.url, server.username, server.password);
    await setRepoCacheEntry(id, newCacheEntry(repos, auth));
    return toPublicServer(server, repos.length, auth);
  });
}

export interface RefreshAllResult {
  /** 重新載入後所有帳號底下的 repo 總數（同名只算一次）。 */
  repoCount: number;
  /** 成功重新載入的帳號數。 */
  refreshed: number;
  /** 失敗的帳號與原因（單一帳號連不上不影響其他）。 */
  failed: Array<{ name: string; error: string }>;
}

/** 重新向所有帳號讀 repo 清單（「瀏覽 SVN 目錄」的重新整理按鈕用）。單一帳號失敗不影響其他。 */
export function refreshAllServers(): Promise<RefreshAllResult> {
  return queued(async () => {
    const servers = (await readAll()).filter((c) => c.kind === "server");
    const names = new Set<string>();
    const failed: RefreshAllResult["failed"] = [];
    let refreshed = 0;
    for (const server of servers) {
      try {
        const { repos, auth } = await loadRepos(server.url, server.username, server.password);
        await setRepoCacheEntry(server.id, newCacheEntry(repos, auth));
        repos.forEach((r) => names.add(r));
        refreshed++;
      } catch (e) {
        failed.push({ name: server.name, error: e instanceof Error ? e.message : String(e) });
      }
    }
    for (const c of await listPublicConnections()) names.add(c.name);
    return { repoCount: names.size, refreshed, failed };
  });
}

/**
 * 補齊「還沒有 repo 清單快取」的帳號（剛從別台電腦複製設定檔過來、快取被清掉）：向伺服器讀一次寫進快取。
 * 單一帳號連不上就略過，不影響其他；已經有快取的帳號不會重讀。回傳補了幾個帳號。
 */
export function fillMissingRepoCaches(): Promise<number> {
  return queued(async () => {
    const profile = await readProfileStrict();
    let filled = 0;
    for (const server of profile.accounts.filter((c) => c.kind === "server" && !profile.repoCache[c.id] && !c.repos)) {
      try {
        const { repos, auth } = await loadRepos(server.url, server.username, server.password);
        await setRepoCacheEntry(server.id, newCacheEntry(repos, auth));
        filled++;
      } catch {
        // 連不上就維持沒有快取；使用者按「重新載入」或下次啟動會再試
      }
    }
    return filled;
  });
}

/** 刪除帳號（連同它的 repo 清單快取，同一次寫入完成）。不會動 SVN 上的任何東西。 */
export function deleteServer(id: string): Promise<{ id: string }> {
  return queued(async () => {
    await updateProfile((profile) => {
      if (!profile.accounts.some((c) => c.id === id && c.kind === "server")) throw new ConnectionInputError(`找不到帳號：${id}`);
      const repoCache = { ...profile.repoCache };
      delete repoCache[id];
      return { ...profile, accounts: profile.accounts.filter((c) => c.id !== id), repoCache };
    });
    return { id };
  });
}

// ---- 舊格式遷移（每個 repo 一筆連線 → 每個帳號一筆）----

export interface MigrationResult {
  /** 轉成別名、併進帳號項目的舊連線數。 */
  migrated: number;
  /** 沒辦法轉換、維持原樣的舊連線數（例如網址不是「上層網址/repo」的結構、或連不上）。 */
  kept: number;
  /** 備份檔路徑（沒有任何變動時是 null）。 */
  backup: string | null;
}

function sameUrl(a: string, b: string): boolean {
  return a.replace(/\/+$/, "").toLowerCase() === b.replace(/\/+$/, "").toLowerCase();
}

/** 單一 repo 網址拆成「上層網址」與「repo 名稱」；網址結構不對（沒有路徑）回 null。 */
export function splitRepoUrl(url: string): { parent: string; repo: string } | null {
  const trimmed = url.trim().replace(/\/+$/, "");
  const m = /^(https?:\/\/[^/]+(?:\/[^/]+)*)\/([^/]+)$/i.exec(trimmed);
  if (!m) return null;
  let repo = m[2];
  try {
    repo = decodeURIComponent(repo);
  } catch {
    // 不是合法的百分比編碼就維持原樣
  }
  return { parent: m[1], repo };
}

function addAlias(server: StoredConnection, legacy: StoredConnection, repo: string): void {
  server.aliases = { ...(server.aliases ?? {}), [legacy.name]: repo };
  if (legacy.id) server.legacyIds = { ...(server.legacyIds ?? {}), [String(legacy.id)]: repo };
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
}

/**
 * 把舊版「每個 repo 一筆」的連線轉成「每個帳號一筆」：
 * - 網址的上層網址＋帳號（不分大小寫）相同的，併進同一個帳號；舊名稱與舊 id 變成別名，其他工具照舊找得到；
 * - 需要新增帳號的，先實際向伺服器讀 repo 清單確認可行，讀不到就維持原樣不轉；
 * - 搬走存在帳號項目裡的舊 repo 清單（改放 repoCache 區塊）；
 * - 有任何變動前，先把原檔備份成 `svn-connections.backup-時間.json`。
 * （v1 → v2 單一檔案格式的升級由 profile-store 在寫入時一併處理：備份原檔、併入旁邊兩個舊檔。）
 */
export function migrateLegacyConnections(): Promise<MigrationResult> {
  return queued(async () => {
    const file = getConnectionsFilePath();
    let result: MigrationResult = { migrated: 0, kept: 0, backup: null };
    await updateProfile(async (profile) => {
      const all = profile.accounts;
      const legacy = all.filter((c) => c.kind !== "server");
      const embedded = all.some((c) => c.kind === "server" && Array.isArray(c.repos));
      if (legacy.length === 0 && !embedded) return undefined;

      const cache = { ...profile.repoCache };
      const servers: StoredConnection[] = all.filter((c) => c.kind === "server").map((c) => ({ ...c }));
      for (const server of servers) {
        if (Array.isArray(server.repos)) {
          if (!cache[server.id]) cache[server.id] = newCacheEntry(server.repos);
          delete server.repos;
        }
      }

      const keptLegacy: StoredConnection[] = [];
      const groups = new Map<string, { parent: string; username: string; password: string; members: Array<{ entry: StoredConnection; repo: string }> }>();
      let migrated = 0;
      for (const entry of legacy) {
        const split = splitRepoUrl(entry.url);
        if (!split) {
          keptLegacy.push(entry);
          continue;
        }
        const match = servers.find((s) => sameUrl(s.url, split.parent) && s.username.toLowerCase() === entry.username.toLowerCase());
        if (match) {
          addAlias(match, entry, split.repo);
          migrated++;
          continue;
        }
        const key = `${split.parent.toLowerCase()}|${entry.username.toLowerCase()}`;
        const group = groups.get(key) ?? { parent: split.parent, username: entry.username, password: entry.password, members: [] };
        group.members.push({ entry, repo: split.repo });
        groups.set(key, group);
      }

      for (const group of groups.values()) {
        let fetched: { repos: string[]; auth: ServerAuthMode };
        try {
          fetched = await fetchServerRepos({ url: group.parent, username: group.username, password: group.password });
        } catch {
          keptLegacy.push(...group.members.map((m) => m.entry));
          continue;
        }
        const taken = new Set(servers.map((s) => s.name));
        const base = group.members.length === 1 ? group.members[0].entry.name : `${hostOf(group.parent)}（${group.username}）`;
        let name = base;
        for (let i = 2; taken.has(name); i++) name = `${base} ${i}`;
        const server: StoredConnection = { id: randomUUID(), name, url: group.parent, username: group.username, password: group.password, kind: "server" };
        for (const member of group.members) addAlias(server, member.entry, member.repo);
        servers.push(server);
        cache[server.id] = newCacheEntry(fetched.repos, fetched.auth);
        migrated += group.members.length;
      }

      // 沒有任何轉換、也沒有要搬走的 repo 清單：不重寫檔案、不產生備份（連不上的舊連線每次啟動都會重試，不能每次都留一份備份）
      if (migrated === 0 && !embedded) {
        result = { migrated: 0, kept: keptLegacy.length, backup: null };
        return undefined;
      }

      const backup = path.join(path.dirname(file), `${path.basename(file, ".json")}.backup-${timestamp()}.json`);
      await copyFile(file, backup);
      result = { migrated, kept: keptLegacy.length, backup };
      return { ...profile, accounts: [...servers, ...keptLegacy], repoCache: cache };
    });
    return result;
  });
}
