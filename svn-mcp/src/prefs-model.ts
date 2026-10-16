/**
 * 使用者個人偏好（星星專案、最近開過、專案簡稱、常用目錄與暱稱、本地同步設定）的資料型別與整理規則。
 * 純函式、不碰檔案：profile-store 讀檔時用它把任何來源的內容整理成合法的偏好，repo-prefs 寫入時沿用同一套規則。
 */
export interface RepoPrefs {
  /** 星星專案名稱，順序＝畫面順序。 */
  starred: string[];
  /** 專案名稱 → 最後開啟時間（ISO）。 */
  recent: Record<string, string>;
  /** 專案名稱 → 簡稱。 */
  nicknames: Record<string, string>;
  /** 專案名稱 → 這個專案的常用目錄（相對於專案根目錄，順序＝畫面順序）。每個專案各自一份。 */
  folders: Record<string, string[]>;
  /** 專案名稱 → 目錄路徑 → 常用目錄的暱稱（路徑很長時用暱稱比較好認）。只會有「已經是常用目錄」的路徑。 */
  folderNicknames: Record<string, Record<string, string>>;
  /** 專案名稱 → 這個專案在本機的 SVN 工作目錄清單（絕對路徑，一個專案可以追蹤多個遠端目錄）。「同步本地端」開啟時，編輯／刪除成功後會 svn update 包含該檔案的那個目錄。 */
  localPaths: Record<string, string[]>;
  /** 「同步本地端」開關：開啟時，遠端編輯上傳或刪除成功後自動 svn update 本地工作目錄。預設關閉（維持原本行為）。 */
  syncLocal: boolean;
}

export const MAX_NAME_LENGTH = 200;
export const MAX_NICKNAME_LENGTH = 30;
/** 「最近開過」最多記幾個專案，超過就丟掉最舊的。 */
export const MAX_RECENT = 500;
/** 每個專案最多幾個常用目錄。 */
export const MAX_FOLDERS_PER_REPO = 100;
export const MAX_FOLDER_PATH_LENGTH = 500;
export const MAX_LOCAL_PATH_LENGTH = 400;
export const MAX_LOCAL_PATHS_PER_REPO = 20;
export const FORBIDDEN_FOLDER_CHARS = /[<>:"|?*\u0000-\u001f]/;

export function emptyPrefs(): RepoPrefs {
  return { starred: [], recent: {}, nicknames: {}, folders: {}, folderNicknames: {}, localPaths: {}, syncLocal: false };
}

export function isName(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= MAX_NAME_LENGTH;
}

function stringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (isName(k) && typeof v === "string") out[k] = v;
  }
  return out;
}

function folderRecord(value: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [repo, list] of Object.entries(value as Record<string, unknown>)) {
      if (!isName(repo) || !Array.isArray(list)) continue;
      const paths = [...new Set(list.filter((p): p is string => typeof p === "string" && p.trim() !== "" && p.length <= MAX_FOLDER_PATH_LENGTH))];
      if (paths.length) out[repo] = paths.slice(0, MAX_FOLDERS_PER_REPO);
    }
  }
  return out;
}

/** 本機目錄的格式：Windows 磁碟機絕對路徑（C:\…）或網路路徑（\\主機\…）；不含 Windows 不允許的字元。 */
export function isLocalDirPath(value: string): boolean {
  if (value.length > MAX_LOCAL_PATH_LENGTH || /[<>"|?*\u0000-\u001f]/.test(value)) return false;
  return /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(value);
}

/** 去掉前後空白與結尾的斜線；不合法回傳空字串。 */
export function cleanLocalDir(value: unknown): string {
  const text = typeof value === "string" ? value.trim().replace(/[\\/]+$/, "") : "";
  return text && isLocalDirPath(text) ? text : "";
}

/** 新格式是清單；舊格式（一個專案一個字串）自動升級成只有一筆的清單。 */
function localPathRecord(value: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [repo, raw] of Object.entries(value as Record<string, unknown>)) {
      if (!isName(repo)) continue;
      const list = (Array.isArray(raw) ? raw : [raw]).map(cleanLocalDir).filter(Boolean);
      const unique = list.filter((dir, index) => list.findIndex((other) => other.toLowerCase() === dir.toLowerCase()) === index);
      if (unique.length) out[repo] = unique.slice(0, MAX_LOCAL_PATHS_PER_REPO);
    }
  }
  return out;
}

/** 只留下「這個專案的常用目錄裡真的有」的暱稱，而且是非空、不超過上限的字串。 */
function folderNicknameRecord(value: unknown, folders: Record<string, string[]>): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [repo, map] of Object.entries(value as Record<string, unknown>)) {
      if (!folders[repo] || !map || typeof map !== "object" || Array.isArray(map)) continue;
      const kept: Record<string, string> = {};
      for (const [folder, nick] of Object.entries(map as Record<string, unknown>)) {
        if (folders[repo].includes(folder) && typeof nick === "string" && nick.trim() !== "" && nick.trim().length <= MAX_NICKNAME_LENGTH) kept[folder] = nick.trim();
      }
      if (Object.keys(kept).length) out[repo] = kept;
    }
  }
  return out;
}

/** 把任何來源的內容整理成合法的偏好：缺的欄位補空、格式不對或亂掉的項目丟掉。 */
export function normalizePrefs(parsed: unknown): RepoPrefs {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyPrefs();
  const o = parsed as Record<string, unknown>;
  const starred = Array.isArray(o.starred) ? [...new Set(o.starred.filter(isName))] : [];
  const folders = folderRecord(o.folders);
  return {
    starred,
    recent: stringRecord(o.recent),
    nicknames: stringRecord(o.nicknames),
    folders,
    folderNicknames: folderNicknameRecord(o.folderNicknames, folders),
    localPaths: localPathRecord(o.localPaths),
    syncLocal: o.syncLocal === true,
  };
}
