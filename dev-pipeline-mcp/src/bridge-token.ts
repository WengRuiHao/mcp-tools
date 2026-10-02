import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getBridgeTokenFile } from "./config-store.js";

const TOKEN_BYTES = 32;

/**
 * HTTP bridge 的 SVN 寫入端點用的共用密鑰：第一次用到時產生並存在資料目錄，之後固定沿用。
 * 只會被寫進產生出來的 PENDING_HUMAN_ACTIONS.html（網頁按鈕送請求時帶在 header），不會經由任何 MCP 工具回傳。
 * 目的是擋「瀏覽器裡開著的別的網站」對 127.0.0.1 發請求——別的網站讀不到這個本機 HTML 檔，就拿不到 token。
 * 它擋不了「本機上有檔案讀取權限的程式」（那種程式本來就能直接跑 svn），所以 AI 不能 commit 這件事的
 * 主要保證是：svn-mcp 沒有任何寫入類 MCP 工具，而不是這個 token。
 */
export async function getBridgeToken(): Promise<string> {
  const file = getBridgeTokenFile();
  try {
    const existing = (await readFile(file, "utf-8")).trim();
    if (existing) return existing;
  } catch (err: any) {
    if (err.code !== "ENOENT") throw err;
  }
  const token = randomBytes(TOKEN_BYTES).toString("hex");
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFile(file, token, { encoding: "utf-8", flag: "wx" });
    return token;
  } catch (err: any) {
    // 另一個行程剛好搶先建立了：以它寫的為準。
    if (err.code === "EEXIST") return (await readFile(file, "utf-8")).trim();
    throw err;
  }
}

/** 常數時間比對，避免從回應時間猜出 token。 */
export function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
