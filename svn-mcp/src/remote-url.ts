/**
 * 把使用者貼上的 SVN 網址對應成「哪個專案（連線）的哪個位置」，讓瀏覽 SVN 目錄可以直接跳過去。
 * 只讀取：比對連線設定、再問遠端這個位置是檔案還是資料夾，不會改動任何東西。
 *
 * - 網址可以是完整的 http(s)／svn／file 網址，中文與 %E4%... 這類編碼都會還原；`?` 之後與 `#` 之後的部分會忽略；
 * - 比對方式：協定與主機不分大小寫、路徑不分大小寫，挑「網址最長、剛好是這個網址前綴」的那個連線；
 * - 網址不屬於任何已設定的專案、或遠端找不到這個位置，都回傳清楚的錯誤，不會猜。
 */
import { listPublicConnections } from "./connections-store.js";
import { EditError, remoteInfo, resolveConn } from "./remote-edit-client.js";
import { buildFullUrl } from "./svn-client.js";

export interface ResolvedRemoteUrl {
  /** 連線 id（給 /api/browse 的 connection 用）與顯示名稱。 */
  connection: string;
  connectionName: string;
  /** 相對於連線根目錄的路徑（`a/b/c`；連線根目錄是空字串）。 */
  path: string;
  kind: "file" | "dir";
  /** 檔案所在的資料夾（kind 是 dir 時就是 path 本身）；瀏覽要進入的就是這個。 */
  dir: string;
  /** kind 是 file 時的檔名，用來在清單裡標示。 */
  fileName: string | null;
}

interface ParsedUrl {
  origin: string;
  segments: string[];
}

function decodeSegment(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

/** 拆成「協定＋主機」與路徑段落（已解碼）；格式不對回 null。 */
function parseUrl(raw: string): ParsedUrl | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (!["http:", "https:", "svn:", "svn+ssh:", "file:"].includes(u.protocol)) return null;
  const segments = u.pathname.split("/").filter((seg) => seg !== "").map(decodeSegment);
  return { origin: `${u.protocol}//${u.host}`.toLowerCase(), segments };
}

export async function resolveRemoteUrl(rawUrl: unknown): Promise<ResolvedRemoteUrl> {
  const text = typeof rawUrl === "string" ? rawUrl.trim() : "";
  if (!text) throw new EditError("INVALID_INPUT", "請貼上 SVN 網址。");
  const target = parseUrl(text);
  if (!target) throw new EditError("INVALID_INPUT", "這看起來不是 SVN 網址（要是 http://、https://、svn:// 開頭的完整網址）。");
  if (target.segments.some((seg) => seg === "..")) throw new EditError("INVALID_INPUT", "網址不能包含 \"..\"。");

  const connections = await listPublicConnections();
  let best: { id: string; name: string; depth: number } | null = null;
  for (const conn of connections) {
    const base = parseUrl(conn.url);
    if (!base || base.origin !== target.origin || base.segments.length > target.segments.length) continue;
    if (!base.segments.every((seg, i) => seg.toLowerCase() === target.segments[i].toLowerCase())) continue;
    if (!best || base.segments.length > best.depth) best = { id: conn.id, name: conn.name, depth: base.segments.length };
  }
  if (!best) throw new EditError("NOT_FOUND", "這個網址不在任何已設定的 SVN 專案底下。請先到「連線設定」新增這個 SVN 伺服器的帳號，或確認網址有沒有貼錯。");

  const subPath = target.segments.slice(best.depth).join("/");
  const conn = await resolveConn(best.id);
  const info = await remoteInfo(conn, buildFullUrl(conn.url, subPath));
  if (info.kind !== "file" && info.kind !== "dir") throw new EditError("NOT_FOUND", `遠端找不到這個位置：${subPath || "（專案根目錄）"}`);
  if (info.kind === "dir") return { connection: best.id, connectionName: best.name, path: subPath, kind: "dir", dir: subPath, fileName: null };
  const slash = subPath.lastIndexOf("/");
  return { connection: best.id, connectionName: best.name, path: subPath, kind: "file", dir: slash >= 0 ? subPath.slice(0, slash) : "", fileName: slash >= 0 ? subPath.slice(slash + 1) : subPath };
}
