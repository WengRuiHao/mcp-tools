import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = path.resolve(__dirname, "../info/github.json");

interface GithubConfig {
  token?: string;
}

/** Reads the Personal Access Token from this MCP's own info/github.json — a personal, independent copy, not shared with any other tool. */
export async function getGithubToken(): Promise<string | null> {
  const configPath = process.env.GITHUB_MCP_CONFIG_PATH ? path.resolve(process.env.GITHUB_MCP_CONFIG_PATH) : DEFAULT_CONFIG_PATH;

  let raw: string;
  try {
    raw = await readFile(configPath, "utf-8");
  } catch {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as GithubConfig;
    const token = parsed.token;
    return typeof token === "string" && token.trim() !== "" ? token.trim() : null;
  } catch {
    return null;
  }
}
