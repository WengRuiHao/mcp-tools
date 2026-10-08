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

/** 執行檔所在的 svn-mcp 安裝根目錄，給自動拉起 svn-edit 時找執行檔用。 */
export function getSvnMcpRoot(): string {
  return getInstallRoot();
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
