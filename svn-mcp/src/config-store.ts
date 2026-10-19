import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * svn-mcp 的安裝根目錄（`info/`、`dist/`、`dist-exe/` 的上一層）。
 * 打包成執行檔（pkg）後，程式碼在內部虛擬檔案系統裡，`import.meta.url` 不是真實位置；
 * 執行檔固定放在 `dist-exe/`，所以改用執行檔所在目錄的上一層，剛好對應原本的預設位置。
 */
function getInstallRoot(): string {
  if ((process as { pkg?: unknown }).pkg) return path.resolve(path.dirname(process.execPath), "..");
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

/**
 * Absolute path to svn-mcp's own SVN connections file (name/url/username/password per connection).
 * Lives inside this MCP's own `info/` directory — a personal, independent copy, not shared with
 * or read from claudeweb at runtime. svn-mcp calls the `svn` CLI itself.
 * svn-edit 執行檔與 MCP 唯讀工具共用這一份。
 */
export function getConnectionsFilePath(): string {
  const configured = process.env.SVN_CONNECTIONS_FILE;
  if (configured) return path.resolve(configured);
  return path.join(getInstallRoot(), "info", "svn-connections.json");
}

/**
 * 各帳號底下 repo 清單的快取檔。連線檔只存帳號，repo 清單另外放這裡，要更新就向伺服器重新讀。
 * 預設跟連線檔放同一個資料夾；`SVN_REPOS_CACHE` 可指定其他位置（測試用）。
 */
export function getRepoCachePath(): string {
  const configured = process.env.SVN_REPOS_CACHE?.trim();
  if (configured) return path.resolve(configured);
  return path.join(path.dirname(getConnectionsFilePath()), "svn-repos-cache.json");
}

/**
 * 使用者在 svn-edit 的個人偏好（星星專案與排序、最近開過的專案、專案簡稱）。
 * 預設跟連線檔放在同一個資料夾（info/ 不進版控）；`SVN_REPO_PREFS` 可指定其他位置（測試用）。
 */
export function getRepoPrefsPath(): string {
  const configured = process.env.SVN_REPO_PREFS?.trim();
  if (configured) return path.resolve(configured);
  return path.join(path.dirname(getConnectionsFilePath()), "svn-repo-prefs.json");
}

/** 執行檔所在的 svn-mcp 安裝根目錄，給自動拉起 svn-edit 時找執行檔用。 */
export function getSvnMcpRoot(): string {
  return getInstallRoot();
}

/**
 * svn-edit 的暫存資料夾（取出的檔案、檢視用的 PDF、批次上傳的暫存）。
 * 直接放在專案自己的 `logs/`（跟稽核紀錄同一個資料夾，只有一處要管）；清理只認 `view-*`、`batch-*` 與沒有 session.json 的空殼，不碰稽核紀錄；有進行中的編輯時會保留，其餘在 svn-edit 啟動與結束時自動清掉。
 * `SVN_EDIT_TEMP_DIR` 可指定其他位置（測試用）。
 */
export function getEditTempDir(): string {
  const configured = process.env.SVN_EDIT_TEMP_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(getInstallRoot(), "logs");
}

/**
 * svn-edit 稽核紀錄（誰在什麼時候開啟／上傳／放棄／檢視了哪個檔案）的位置。
 * 放在專案自己的 `logs/`，不放暫存資料夾：暫存資料夾是「用完就丟」的東西，Windows 隨時可能清掉，稽核軌跡不能跟著消失。
 * `SVN_EDIT_AUDIT_LOG` 可指定其他位置（測試用）。
 */
export function getAuditLogPath(): string {
  const configured = process.env.SVN_EDIT_AUDIT_LOG?.trim();
  if (configured) return path.resolve(configured);
  return path.join(getInstallRoot(), "logs", "svn-edit-audit.log");
}

/** Default connection id/name to use when a tool call doesn't specify one. */
export function getDefaultConnectionId(): string | null {
  return process.env.SVN_CONNECTION_ID?.trim() || null;
}

export function getSvnTimeoutMs(): number {
  const raw = process.env.SVN_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30000;
}

/** 會花比較久的操作（checkout／update／export／commit…）的逾時：一般逾時的 10 倍。 */
export const LONG_TIMEOUT_MULTIPLIER = 10;
export function getLongSvnTimeoutMs(): number {
  return getSvnTimeoutMs() * LONG_TIMEOUT_MULTIPLIER;
}
