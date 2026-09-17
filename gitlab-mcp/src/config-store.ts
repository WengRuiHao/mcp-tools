import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to this MCP's own GitLab connections file (id/name/token/baseUrl per connection).
 * Lives inside this MCP's own `info/` directory — a personal, independent copy, not shared with
 * or read from claudeweb at runtime. Mirrors svn-mcp's multi-connection config pattern.
 */
export function getConnectionsFilePath(): string {
  const configured = process.env.GITLAB_CONNECTIONS_FILE;
  if (configured) return path.resolve(configured);
  return path.resolve(__dirname, "..", "info", "gitlab-connections.json");
}

/** Default connection id/name to use when a tool call doesn't specify one. */
export function getDefaultConnectionId(): string | null {
  return process.env.GITLAB_CONNECTION_ID?.trim() || null;
}
