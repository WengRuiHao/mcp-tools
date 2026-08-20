import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// asana-mcp's own copy, independent of claudeweb — not read from claudeweb at runtime.
const DEFAULT_CONFIG_PATH = path.resolve(__dirname, "../info/integrations.json");

interface AsanaConfig {
  token?: string;
  enabled?: boolean;
}

export async function getAsanaToken(): Promise<string | null> {
  const configPath = process.env.ASANA_MCP_CONFIG_PATH
    ? path.resolve(process.env.ASANA_MCP_CONFIG_PATH)
    : DEFAULT_CONFIG_PATH;

  let raw: string;
  try {
    raw = await readFile(configPath, "utf-8");
  } catch {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as { asana?: AsanaConfig };
    const token = parsed.asana?.token;
    return typeof token === "string" && token.trim() !== "" ? token.trim() : null;
  } catch {
    return null;
  }
}
