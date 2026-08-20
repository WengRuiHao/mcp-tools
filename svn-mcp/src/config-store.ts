import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to svn-mcp's own SVN connections file (name/url/username/password per connection).
 * Lives inside this MCP's own `info/` directory — a personal, independent copy, not shared with
 * or read from claudeweb at runtime. svn-mcp calls the `svn` CLI itself.
 */
export function getConnectionsFilePath(): string {
  const configured = process.env.SVN_CONNECTIONS_FILE;
  if (configured) return path.resolve(configured);
  return path.resolve(__dirname, "..", "info", "svn-connections.json");
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
