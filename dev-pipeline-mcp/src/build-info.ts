// 讓呼叫端看得出目前連到的 MCP 程序跑的是哪一版：build 完沒重連時，builtAt 會比檔案實際 build 時間舊。
import { statSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface ServerInfo {
  /** dist/index.js 的 mtime（ISO 字串）；讀不到為 null。 */
  builtAt: string | null;
  /** 這個程序載入本模組（約等於啟動）的時間。 */
  startedAt: string;
  pid: number;
  /** package.json 的 version；讀不到為 null。 */
  version: string | null;
}

const STARTED_AT = new Date().toISOString();

function readBuiltAt(): string | null {
  try {
    return statSync(fileURLToPath(new URL("./index.js", import.meta.url))).mtime.toISOString();
  } catch {
    return null;
  }
}

function readVersion(): string | null {
  try {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

export function getServerInfo(): ServerInfo {
  return { builtAt: readBuiltAt(), startedAt: STARTED_AT, pid: process.pid, version: readVersion() };
}
