/**
 * 讀取 SVN 伺服器上層網址底下的 repo 清單。
 *
 * svn 命令列沒辦法對上層網址做 `svn list`（上層不是 repo，回 E175003），但 Apache 的 `SVNParentPath`
 * 在上層網址用 GET 會回一份 XML 索引（`<dir name="…" href="…/"/>`），所以改用 HTTP 直接取。
 * 認證用 curl 的 `--anyauth`（Windows 內建的 curl.exe 會自動協商 Basic／NTLM／Negotiate），
 * 帳密經由 stdin 的設定檔傳給 curl，不會出現在命令列（別的程式看不到）。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const FETCH_TIMEOUT_SECONDS = 30;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

const XML_ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };

function decodeXml(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos);/g, (m) => XML_ENTITIES[m]);
}

/** 從上層網址回傳的 XML 索引取出 repo 名稱；格式不對（不是 SVN 索引）回 null。 */
export function parseRepoIndex(body: string): string[] | null {
  // 上層網址的索引標題固定是 "Collection of Repositories"；單一 repo 內部的目錄索引長得很像，但標題是 repo 路徑，必須排除
  if (!/<svn\b[^>]*>[\s\S]*<index\b[^>]*path="Collection of Repositories"/.test(body)) return null;
  const names: string[] = [];
  for (const m of body.matchAll(/<dir\s+name="([^"]*)"/g)) {
    const name = decodeXml(m[1]).trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names.sort();
}

function curlConfigLine(key: string, value: string): string {
  return `${key} = "${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"\n`;
}

export class ServerReposError extends Error {}

/**
 * 一定要用 Windows 內建的 curl：Git／MSYS 附的 curl 沒有 Windows 整合驗證（NTLM／Negotiate），
 * 同樣的帳密會被伺服器 401 拒絕，而 PATH 裡誰排前面不一定。
 */
function systemCurl(): string {
  const candidate = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "curl.exe");
  return existsSync(candidate) ? candidate : "curl.exe";
}

export interface ServerLogin {
  url: string;
  username: string;
  password: string;
}

/** credentials＝用填的帳密；windows＝用目前登入 Windows 的身分（這類伺服器是整合驗證，帳密其實不會被用到）。 */
export type ServerAuthMode = "credentials" | "windows";

interface CurlResult {
  status: number;
  body: string;
  stderr: string;
}

function runCurl(url: string, userSpec: string): Promise<CurlResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(systemCurl(), ["-sS", "--anyauth", "-K", "-", "-m", String(FETCH_TIMEOUT_SECONDS), "-w", "\n%{http_code}"], { windowsHide: true });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      size += d.length;
      if (size > MAX_RESPONSE_BYTES) child.kill();
      else chunks.push(d);
    });
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf-8")));
    child.on("error", () => reject(new ServerReposError("找不到 curl.exe，無法讀取伺服器的 repo 清單（Windows 10 以上內建）。")));
    child.on("close", () => {
      const text = Buffer.concat(chunks).toString("utf-8");
      const cut = text.lastIndexOf("\n");
      resolve({ status: Number(text.slice(cut + 1).trim()), body: text.slice(0, Math.max(cut, 0)), stderr });
    });
    child.stdin.end(curlConfigLine("url", url.replace(/\/+$/, "") + "/") + curlConfigLine("user", userSpec));
  });
}

const isDenied = (r: CurlResult): boolean => r.status === 401 || r.status === 403;

/**
 * 讀伺服器的 repo 清單。先用填的帳密；被拒絕（401）再改用 Windows 登入身分（`-u :`）。
 * 公司的 SVN 是 Windows 整合驗證時，svn 本身也是這樣運作——帳密只是擺著，真正驗證的是登入的 Windows 帳號。
 */
export async function fetchServerRepos(login: ServerLogin): Promise<{ repos: string[]; auth: ServerAuthMode }> {
  let auth: ServerAuthMode = "credentials";
  let result = login.password ? await runCurl(login.url, `${login.username}:${login.password}`) : { status: 401, body: "", stderr: "" };
  if (isDenied(result)) {
    auth = "windows";
    result = await runCurl(login.url, ":");
  }
  const { status, body, stderr } = result;
  if (isDenied(result)) throw new ServerReposError("帳號或密碼不正確，或這個帳號沒有權限讀取這個伺服器（也試過用你目前登入 Windows 的身分，一樣被拒絕）。");
  if (!status) throw new ServerReposError(`連不上伺服器：${stderr.trim().split("\n")[0] || "沒有回應"}`);
  const repos = status === 200 ? parseRepoIndex(body) : null;
  if (!repos) throw new ServerReposError("這個網址讀不到 repo 清單（HTTP " + status + "）。請填上層網址（底下每個子目錄是一個 repo），例如 https://svn.example.com/svn");
  if (repos.length === 0) throw new ServerReposError("這個帳號在這個伺服器底下看不到任何 repo。");
  return { repos, auth };
}
