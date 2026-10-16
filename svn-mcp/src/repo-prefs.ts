/**
 * 使用者在 svn-edit「瀏覽 SVN 目錄」裡的個人偏好：
 * - 星星專案（starred）：順序就是畫面上的順序，可以拖曳調整；
 * - 最近開過的專案（recent）：專案名稱 → 最後開啟時間，「近期 SVN」分頁最近的排最上面；
 * - 專案簡稱（nicknames）：畫面用的暱稱，搜尋時也會比對；
 * - 常用目錄（folders）與它們的暱稱（folderNicknames）：每個專案各自一份。
 *
 * 一律用專案（repo）名稱當 key：展開後的 repo 清單裡名稱本來就是唯一的，而且公司換網址、帳號改名都不會讓星星掉光。
 * 簡稱跟帳號項目裡的「別名」是兩回事——別名是給其他工具（dev-pipeline）用舊名稱查找連線用的，不能被畫面改掉。
 *
 * 資料存在單一設定檔的 `prefs` 區塊（見 profile-store.ts）：讀不到或壞掉就當成沒有偏好；
 * 寫入一律走 updateProfile（跨程式的鎖＋原子寫入），所以不會跟別的程式同時寫的內容互相蓋掉。
 */
import { ConnectionInputError } from "./connections-store.js";
import {
  FORBIDDEN_FOLDER_CHARS,
  isLocalDirPath,
  isName,
  MAX_FOLDER_PATH_LENGTH,
  MAX_LOCAL_PATH_LENGTH,
  MAX_FOLDERS_PER_REPO,
  MAX_NICKNAME_LENGTH,
  MAX_RECENT,
  type RepoPrefs,
} from "./prefs-model.js";
import { readProfile, updateProfile } from "./profile-store.js";

export { MAX_FOLDERS_PER_REPO, MAX_NICKNAME_LENGTH, MAX_RECENT, type RepoPrefs };

/** 讀偏好；檔案不存在、壞掉、格式不對都當成空的。 */
export async function readRepoPrefs(): Promise<RepoPrefs> {
  return (await readProfile()).prefs;
}

/** 讀現況 → 套用變更 → 原子寫回（在跨程式的鎖裡）。 */
async function update(change: (prefs: RepoPrefs) => RepoPrefs): Promise<RepoPrefs> {
  return (await updateProfile((profile) => ({ ...profile, prefs: change(profile.prefs) }))).prefs;
}

function requireName(name: unknown): string {
  if (!isName(name)) throw new ConnectionInputError("專案名稱不正確");
  return name;
}

/** 加上或拿掉星星。新加的排在星星清單最後面；已經有星星再加一次不會移動位置。 */
export async function setStar(name: unknown, starred: boolean): Promise<RepoPrefs> {
  const repo = requireName(name);
  return update((prefs) => ({ ...prefs, starred: starred ? (prefs.starred.includes(repo) ? prefs.starred : [...prefs.starred, repo]) : prefs.starred.filter((n) => n !== repo) }));
}

/** 調整星星順序：只能重排現有的星星（不會藉由排序加入新的），沒被提到的星星維持原本相對順序接在後面。 */
export async function reorderStars(order: unknown): Promise<RepoPrefs> {
  if (!Array.isArray(order) || !order.every(isName)) throw new ConnectionInputError("排序格式不正確");
  const wanted = order as string[];
  return update((prefs) => {
    const known = wanted.filter((n, i) => prefs.starred.includes(n) && wanted.indexOf(n) === i);
    return { ...prefs, starred: [...known, ...prefs.starred.filter((n) => !known.includes(n))] };
  });
}

/** 記下這個專案剛剛被開啟（「近期 SVN」用）；只留最近 MAX_RECENT 個。 */
export async function markOpened(name: unknown): Promise<RepoPrefs> {
  const repo = requireName(name);
  return update((prefs) => {
    const recent = { ...prefs.recent, [repo]: new Date().toISOString() };
    const keep = Object.entries(recent)
      .sort((a, b) => b[1].localeCompare(a[1]))
      .slice(0, MAX_RECENT);
    return { ...prefs, recent: Object.fromEntries(keep) };
  });
}

/** 設定專案簡稱；空白代表清掉。 */
export async function setNickname(name: unknown, nickname: unknown): Promise<RepoPrefs> {
  const repo = requireName(name);
  const text = typeof nickname === "string" ? nickname.trim() : "";
  if (text.length > MAX_NICKNAME_LENGTH) throw new ConnectionInputError(`簡稱太長（上限 ${MAX_NICKNAME_LENGTH} 字）`);
  return update((prefs) => {
    const nicknames = { ...prefs.nicknames };
    if (text) nicknames[repo] = text;
    else delete nicknames[repo];
    return { ...prefs, nicknames };
  });
}

/** 開關「同步本地端」：開啟後，編輯上傳、刪除遠端檔案成功時自動 svn update 本地工作目錄。 */
export async function setSyncLocal(enabled: unknown): Promise<RepoPrefs> {
  if (typeof enabled !== "boolean") throw new ConnectionInputError("開關的值必須是 true 或 false");
  return update((prefs) => ({ ...prefs, syncLocal: enabled }));
}

/** 設定專案在本機的 SVN 工作目錄（絕對路徑）；空白代表清掉。只檢查格式，是不是工作目錄要到真的同步時才檢查。 */
export async function setLocalPath(name: unknown, dir: unknown): Promise<RepoPrefs> {
  const repo = requireName(name);
  const text = typeof dir === "string" ? dir.trim().replace(/[\\/]+$/, "") : "";
  if (text && !isLocalDirPath(text)) {
    throw new ConnectionInputError(`本地目錄必須是完整路徑（例如 D:\\svn\\${repo}），且不能含 < > " | ? * 這些字元，長度不超過 ${MAX_LOCAL_PATH_LENGTH} 字`);
  }
  return update((prefs) => {
    const localPaths = { ...prefs.localPaths };
    if (text) localPaths[repo] = text;
    else delete localPaths[repo];
    return { ...prefs, localPaths };
  });
}

/** 把使用者的目錄路徑整理成 `a/b/c`（去掉前後斜線、反斜線轉正斜線）；跳出專案的寫法、Windows 不允許的字元、根目錄一律拒絕。 */
export function normalizeFolderPath(raw: unknown): string {
  if (typeof raw !== "string") throw new ConnectionInputError("目錄路徑不正確");
  const segments = raw.trim().replace(/\\/g, "/").split("/").filter((seg) => seg !== "" && seg !== ".");
  if (segments.length === 0) throw new ConnectionInputError("專案根目錄不用加入常用目錄");
  if (segments.some((seg) => seg === "..")) throw new ConnectionInputError("目錄路徑不能包含 ..");
  if (segments.some((seg) => FORBIDDEN_FOLDER_CHARS.test(seg))) throw new ConnectionInputError("目錄路徑含有不允許的字元（: * ? \" < > |）");
  const joined = segments.join("/");
  if (joined.length > MAX_FOLDER_PATH_LENGTH) throw new ConnectionInputError("目錄路徑太長");
  return joined;
}

/** 替某個專案加上或拿掉一個常用目錄。新加的排在最後面；已經有再加一次不會移動位置。 */
export async function setFolderStar(repo: unknown, folderPath: unknown, starred: boolean): Promise<RepoPrefs> {
  const name = requireName(repo);
  const folder = normalizeFolderPath(folderPath);
  return update((prefs) => {
    const current = prefs.folders[name] ?? [];
    let next = current;
    if (starred && !current.includes(folder)) {
      if (current.length >= MAX_FOLDERS_PER_REPO) throw new ConnectionInputError(`這個專案的常用目錄太多了（上限 ${MAX_FOLDERS_PER_REPO} 個）`);
      next = [...current, folder];
    } else if (!starred) {
      next = current.filter((p) => p !== folder);
    }
    const folders = { ...prefs.folders };
    if (next.length) folders[name] = next;
    else delete folders[name];
    const folderNicknames = { ...prefs.folderNicknames };
    if (!starred && folderNicknames[name]) {
      const { [folder]: _removed, ...rest } = folderNicknames[name];
      if (Object.keys(rest).length) folderNicknames[name] = rest;
      else delete folderNicknames[name];
    }
    return { ...prefs, folders, folderNicknames };
  });
}

/** 設定常用目錄的暱稱；空白代表清掉。只能替「已經是常用目錄」的路徑取暱稱（避免留下沒人用的資料）。 */
export async function setFolderNickname(repo: unknown, folderPath: unknown, nickname: unknown): Promise<RepoPrefs> {
  const name = requireName(repo);
  const folder = normalizeFolderPath(folderPath);
  const text = typeof nickname === "string" ? nickname.trim() : "";
  if (text.length > MAX_NICKNAME_LENGTH) throw new ConnectionInputError(`暱稱太長（上限 ${MAX_NICKNAME_LENGTH} 字）`);
  return update((prefs) => {
    if (!(prefs.folders[name] ?? []).includes(folder)) throw new ConnectionInputError("這個目錄還不是常用目錄，請先按 ☆ 加入");
    const mine = { ...(prefs.folderNicknames[name] ?? {}) };
    if (text) mine[folder] = text;
    else delete mine[folder];
    const folderNicknames = { ...prefs.folderNicknames };
    if (Object.keys(mine).length) folderNicknames[name] = mine;
    else delete folderNicknames[name];
    return { ...prefs, folderNicknames };
  });
}
