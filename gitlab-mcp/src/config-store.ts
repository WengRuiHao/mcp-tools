import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = path.resolve(__dirname, "../info/gitlab.json");
const DEFAULT_BASE_URL = "https://gitlab.universalec.com.tw";

interface GitlabConfig {
  token?: string;
  baseUrl?: string;
}

export interface GitlabSettings {
  token: string;
  apiBase: string;
}

/** Reads the Personal Access Token (and optional custom instance URL) from this MCP's own info/gitlab.json — a personal, independent copy, not shared with any other tool or account. */
export async function getGitlabSettings(): Promise<GitlabSettings | null> {
  const configPath = process.env.GITLAB_MCP_CONFIG_PATH ? path.resolve(process.env.GITLAB_MCP_CONFIG_PATH) : DEFAULT_CONFIG_PATH;

  let raw: string;
  try {
    raw = await readFile(configPath, "utf-8");
  } catch {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as GitlabConfig;
    const token = parsed.token;
    if (typeof token !== "string" || token.trim() === "") return null;
    const base = (parsed.baseUrl && parsed.baseUrl.trim() !== "" ? parsed.baseUrl.trim() : DEFAULT_BASE_URL).replace(/\/+$/, "");
    return { token: token.trim(), apiBase: `${base}/api/v4` };
  } catch {
    return null;
  }
}
