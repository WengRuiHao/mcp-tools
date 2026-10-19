/**
 * svn-edit／svn-mcp 共用的單一設定檔（info/svn-connections.json，路徑由 config-store 決定）。
 *
 * 以前是三個檔案（連線、repo 清單快取、個人偏好）；現在合成一個，格式 v2：
 *   { "_readme": [...給 AI 看的說明...], "version": 2, "accounts": [...], "repoCache": {...}, "prefs": {...} }
 * - accounts：SVN 帳號（名稱、上層網址、帳密、舊名稱別名）；
 * - repoCache：各帳號最近一次向伺服器讀到的 repo 名稱（只是快取，不見了會自動重讀）；
 * - prefs：使用者的星星、簡稱、最近開過、常用目錄與暱稱（見 prefs-model.ts）。
 * `_readme` 會寫在檔案最前面，讓 AI（例如透過 dev-pipeline-mcp）打開這個檔案就知道每一塊是什麼、怎麼找專案庫。
 *
 * 讀：舊格式（v1，整份是連線陣列，快取與偏好放在旁邊兩個檔案）也讀得進來，並自動併入旁邊那兩個檔案的內容。
 * 寫：一律走 updateProfile——**跨程式的檔案鎖**（svn-edit 與唯讀 MCP 工具是不同程式，都會寫這個檔案）
 *     ＋ 在鎖裡「重讀 → 套用變更 → 原子寫回」，所以誰先誰後都不會互相蓋掉對方剛寫的東西；
 *     第一次寫入舊格式時，會先備份原檔、把旁邊兩個舊檔改名成 .bak，再寫成 v2。
 */
import { copyFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "./atomic-write.js";
import { getConnectionsFilePath, getRepoCachePath, getRepoPrefsPath } from "./config-store.js";
import type { RepoCache, StoredConnectionEntry } from "./connection-expand.js";
import { emptyPrefs, normalizePrefs, type RepoPrefs } from "./prefs-model.js";
import { errorMessage } from "./util.js";

export const PROFILE_VERSION = 2;

export interface Profile {
  version: typeof PROFILE_VERSION;
  accounts: StoredConnectionEntry[];
  repoCache: RepoCache;
  prefs: RepoPrefs;
}

/** 寫在檔案最前面、給 AI 與人看的說明（每次寫入都會重新產生，所以手動改這段沒有意義）。 */
export const PROFILE_README: readonly string[] = [
  "這是 svn-edit（給人用的網頁編輯器）與 svn-mcp／dev-pipeline-mcp（AI 用的唯讀工具）共用的 SVN 設定檔，三份資料合在這一個檔案裡。",
  "accounts：SVN 帳號，每個帳號一筆（name 名稱、url 上層網址、username、password）。帳號底下有哪些專案庫（repo）由伺服器自動帶出，不用一個一個登記；一個 repo 的網址＝「帳號的 url + / + repo 名稱」。aliases 與 legacyIds 是舊版「一個 repo 一筆連線」時取的名稱與 id（例如「專案甲」），仍然可以拿來當 connectionId；prefs.nicknames 裡使用者替專案取的簡稱也可以（同一個簡稱只對到一個專案時）。",
  "repoCache：每個帳號最近一次向伺服器讀到的 repo 名稱清單（帳號 id → repos）。只是快取，不見了或過期會自動重讀。",
  "prefs：使用者的個人偏好。nicknames＝專案簡稱（專案名稱 → 簡稱），starred＝星星專案（依畫面順序），recent＝專案最後開啟時間，folders＝每個專案的常用目錄（專案名稱 → 路徑清單，路徑相對於 repo 根目錄），folderNicknames＝常用目錄的暱稱（專案名稱 → 路徑 → 暱稱）。",
  "AI 怎麼找專案庫：不要自己讀這個檔案，也不要把 password 輸出到對話裡。使用者說的名稱可能是簡稱、舊名稱、repo 名稱，或某個常用目錄的暱稱（例如「後端規格」）——請呼叫 svn_find_repo 工具搜尋，它會回傳 connectionId（填給 svn_browse、svn_cat 等工具）與該專案符合的常用目錄路徑（直接填給這些工具的 path）；不確定有哪些專案時呼叫 svn_list_connections。",
];

export function emptyProfile(): Profile {
  return { version: PROFILE_VERSION, accounts: [], repoCache: {}, prefs: emptyPrefs() };
}

function normalizeRepoCache(value: unknown): RepoCache {
  const cache: RepoCache = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [id, entry] of Object.entries(value as Record<string, { repos?: unknown; fetchedAt?: unknown; auth?: unknown }>)) {
      if (entry && Array.isArray(entry.repos)) {
        cache[id] = {
          repos: entry.repos.filter((r): r is string => typeof r === "string"),
          fetchedAt: String(entry.fetchedAt ?? ""),
          auth: entry.auth === "credentials" || entry.auth === "windows" ? entry.auth : undefined,
        };
      }
    }
  }
  return cache;
}

function isEntryObject(value: unknown): value is StoredConnectionEntry {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** 把解析出來的 JSON 整理成 Profile；v1（整份是陣列）標記為 legacy，呼叫端要自己併入旁邊的舊檔。格式不對丟錯誤。 */
export function normalizeProfile(parsed: unknown): { profile: Profile; legacy: boolean } {
  if (Array.isArray(parsed)) {
    return { profile: { ...emptyProfile(), accounts: parsed.filter(isEntryObject) }, legacy: true };
  }
  if (parsed && typeof parsed === "object") {
    const o = parsed as Record<string, unknown>;
    return {
      profile: { version: PROFILE_VERSION, accounts: Array.isArray(o.accounts) ? o.accounts.filter(isEntryObject) : [], repoCache: normalizeRepoCache(o.repoCache), prefs: normalizePrefs(o.prefs) },
      legacy: false,
    };
  }
  throw new Error("格式不正確（應該是物件或陣列）");
}

/** 寫進檔案的內容：`_readme` 放最前面。 */
export function serializeProfile(profile: Profile): string {
  return `${JSON.stringify({ _readme: PROFILE_README, version: PROFILE_VERSION, accounts: profile.accounts, repoCache: profile.repoCache, prefs: profile.prefs }, null, 2)}\n`;
}

async function readJsonLenient(file: string): Promise<unknown> {
  try {
    return JSON.parse((await readFile(file, "utf-8")).replace(/^﻿/, ""));
  } catch {
    return undefined;
  }
}

/** v1 時代放在旁邊的兩個檔案（repo 快取、個人偏好）；不存在或壞掉就當沒有。 */
async function readSideFiles(): Promise<{ repoCache: RepoCache; prefs: RepoPrefs }> {
  return { repoCache: normalizeRepoCache(await readJsonLenient(getRepoCachePath())), prefs: normalizePrefs(await readJsonLenient(getRepoPrefsPath())) };
}

interface RawRead {
  profile: Profile;
  legacy: boolean;
}

async function readRaw(): Promise<RawRead> {
  const file = getConnectionsFilePath();
  let text: string;
  try {
    text = await readFile(file, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { profile: emptyProfile(), legacy: false };
    throw e;
  }
  if (text.trim() === "") return { profile: emptyProfile(), legacy: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    throw new Error(`連線設定檔不是合法的 JSON，為避免覆蓋已拒絕寫入，請先修正檔案：${file}`);
  }
  let normalized: { profile: Profile; legacy: boolean };
  try {
    normalized = normalizeProfile(parsed);
  } catch (e) {
    throw new Error(`連線設定檔${errorMessage(e)}：${file}`);
  }
  if (normalized.legacy) {
    const side = await readSideFiles();
    normalized.profile = { ...normalized.profile, repoCache: side.repoCache, prefs: side.prefs };
  }
  return normalized;
}

/** 嚴格讀取：檔案壞掉（不是合法 JSON、格式不對）就丟錯誤——給「要依據它做事或寫回」的地方用。 */
export async function readProfileStrict(): Promise<Profile> {
  return (await readRaw()).profile;
}

/** 寬鬆讀取：壞掉或不見都當成空的——給快取、偏好這種「沒有也能活」的讀取用。 */
export async function readProfile(): Promise<Profile> {
  try {
    return (await readRaw()).profile;
  } catch {
    return emptyProfile();
  }
}

// ---- 跨程式的鎖 ----

const LOCK_WAIT_MS = 15_000;
/** 持鎖的程式當掉會留下鎖，超過這麼久就當它是殘留、強制拆掉。 */
const LOCK_STALE_MS = 60_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function acquireLock(lockDir: string): Promise<void> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await mkdir(lockDir);
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    try {
      const info = await stat(lockDir);
      if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        await rm(lockDir, { recursive: true, force: true });
        continue;
      }
    } catch {
      continue; // 剛好被放掉了，馬上再搶
    }
    if (Date.now() > deadline) throw new Error("設定檔正被另一個程式使用中，等了太久，請稍後再試");
    await sleep(25 + Math.floor(Math.random() * 25));
  }
}

/** 同一個行程內的寫入排隊（跨行程靠檔案鎖）。 */
let queue: Promise<unknown> = Promise.resolve();

function timestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
}

/**
 * 讀 → 套用變更 → 寫回，全程在跨程式的鎖裡。change 丟錯誤就不寫（鎖照樣放掉）；
 * 回傳 undefined 代表「沒有要改」，也不寫。第一次碰到舊格式時順便升級成 v2（備份原檔、旁邊兩個舊檔改名 .bak）。
 */
export function updateProfile(change: (profile: Profile) => Profile | undefined | Promise<Profile | undefined>): Promise<Profile> {
  const run = async (): Promise<Profile> => {
    const file = getConnectionsFilePath();
    await mkdir(path.dirname(file), { recursive: true });
    const lockDir = `${file}.lock`;
    await acquireLock(lockDir);
    try {
      const { profile: current, legacy } = await readRaw();
      const changed = await change(current);
      const next = changed ?? current;
      if (!changed && !legacy) return current;
      if (legacy) {
        await copyFile(file, path.join(path.dirname(file), `${path.basename(file, ".json")}.backup-v1-${timestamp()}.json`)).catch(() => undefined);
      }
      await writeFileAtomic(file, serializeProfile(next));
      if (legacy) {
        for (const side of [getRepoCachePath(), getRepoPrefsPath()]) {
          await rename(side, `${side}.merged.bak`).catch(() => undefined);
        }
      }
      return next;
    } finally {
      await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
    }
  };
  const next = queue.catch(() => undefined).then(run);
  queue = next;
  return next;
}
