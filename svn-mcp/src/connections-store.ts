/**
 * svn-edit 設定頁用的連線設定讀寫。讀寫的是跟 svn-mcp 唯讀工具「同一份」`svn-connections.json`
 * （路徑由 config-store 的 getConnectionsFilePath 決定），格式不變：連線 id、name、url、username、password。
 *
 * - 密碼永遠不會回傳給呼叫端（編輯時密碼留空代表不變更）；
 * - 以原子方式寫入（先寫同目錄暫存檔再改名），避免唯讀工具讀到寫到一半的內容；
 * - 檔案存在但不是合法 JSON 時一律拒絕寫入，絕不覆蓋可能是人工維護、一時壞掉的檔案；
 * - 設定頁只允許 http／https／svn 協定的網址（不允許 file://）。
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { getConnectionsFilePath } from "./config-store.js";
import { expandConnections, type StoredConnectionEntry } from "./connection-expand.js";
import os from "node:os";
import { fetchServerRepos, ServerReposError, type ServerAuthMode } from "./server-repos.js";

export interface PublicConnection {
  id: string;
  name: string;
  url: string;
  username: string;
}

export interface ConnectionInput {
  /** 有值代表編輯既有連線；沒有代表新增。 */
  id?: string;
  name: string;
  url: string;
  username: string;
  /** 新增時必填；編輯時留空代表不變更。 */
  password?: string;
}

export interface PublicServer {
  id: string;
  name: string;
  url: string;
  username: string;
  repoCount: number;
  /** 這次讀取 repo 清單用哪種方式驗證成功（只有剛儲存／重新載入時才有）。 */
  auth?: ServerAuthMode;
}

export interface ServerInput {
  /** 有值代表編輯既有伺服器；沒有代表新增。 */
  id?: string;
  name?: string;
  url: string;
  username: string;
  /** 選填：Windows 整合驗證的伺服器用不到；編輯時留空代表沿用原本的密碼。 */
  password?: string;
}

type StoredConnection = StoredConnectionEntry;

const ALLOWED_URL = /^(https?|svn):\/\/\S+$/i;
const MAX_NAME_LENGTH = 60;

export class ConnectionInputError extends Error {}

async function readAll(): Promise<StoredConnection[]> {
  const file = getConnectionsFilePath();
  let raw: string;
  try {
    raw = await readFile(file, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  if (raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^﻿/, ""));
  } catch {
    throw new Error(`連線設定檔不是合法的 JSON，為避免覆蓋已拒絕寫入，請先修正檔案：${file}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`連線設定檔格式不正確（應該是陣列）：${file}`);
  return parsed as StoredConnection[];
}

function toPublic(c: PublicConnection): PublicConnection {
  return { id: c.id, name: c.name, url: c.url, username: c.username };
}

/** 一般連線加上伺服器展開出來的所有 repo（下拉選單、瀏覽、上傳都用這份）。 */
export async function listPublicConnections(): Promise<PublicConnection[]> {
  return expandConnections(await readAll()).map(toPublic);
}

export async function listPublicServers(): Promise<PublicServer[]> {
  return (await readAll())
    .filter((c) => c.kind === "server")
    .map((c) => ({ id: c.id, name: c.name, url: c.url, username: c.username, repoCount: c.repos?.length ?? 0 }));
}

/** 同一時間只允許一個寫入，避免兩個設定請求互相蓋掉。 */
let writeQueue: Promise<unknown> = Promise.resolve();

export function saveConnection(input: ConnectionInput): Promise<PublicConnection> {
  return queued(() => doSave(input));
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function doSave(input: ConnectionInput): Promise<PublicConnection> {
  const name = clean(input.name);
  const url = clean(input.url).replace(/\/+$/, "");
  const username = clean(input.username);
  const password = typeof input.password === "string" ? input.password : "";
  if (!name) throw new ConnectionInputError("連線名稱不能是空的");
  if (name.length > MAX_NAME_LENGTH) throw new ConnectionInputError(`連線名稱太長（上限 ${MAX_NAME_LENGTH} 字）`);
  if (!ALLOWED_URL.test(url)) throw new ConnectionInputError("網址格式不正確，必須以 https://、http:// 或 svn:// 開頭");
  if (!username) throw new ConnectionInputError("帳號不能是空的");

  const all = await readAll();
  const existing = input.id ? all.find((c) => c.id === input.id) : undefined;
  if (input.id && !existing) throw new ConnectionInputError(`找不到要編輯的連線：${input.id}`);
  if (!existing && !password) throw new ConnectionInputError("新增連線必須填寫密碼");
  if (all.some((c) => c.name === name && c.id !== existing?.id)) throw new ConnectionInputError(`已經有名稱為「${name}」的連線`);

  const saved: StoredConnection = existing
    ? { ...existing, name, url, username, password: password || existing.password }
    : { id: randomUUID(), name, url, username, password };
  const updated = existing ? all.map((c) => (c.id === existing.id ? saved : c)) : [...all, saved];
  await writeAll(updated);
  return toPublic(saved);
}

async function writeAll(updated: StoredConnection[]): Promise<void> {
  const file = getConnectionsFilePath();
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(updated, null, 2)}\n`, "utf-8");
  await rename(tmp, file);
}

function hostOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`.replace(/\/+$/, "");
  } catch {
    return url;
  }
}

function queued<T>(task: () => Promise<T>): Promise<T> {
  const next = writeQueue.catch(() => undefined).then(task);
  writeQueue = next;
  return next;
}

async function loadRepos(url: string, username: string, password: string): Promise<{ repos: string[]; auth: ServerAuthMode }> {
  try {
    return await fetchServerRepos({ url, username, password });
  } catch (e) {
    if (e instanceof ServerReposError) throw new ConnectionInputError(e.message);
    throw e;
  }
}

/** 新增或編輯伺服器：只填上層網址＋帳密，立刻讀出底下所有 repo 並存起來。讀不到就不存。 */
export function saveServer(input: ServerInput): Promise<PublicServer> {
  return queued(async () => {
    const url = clean(input.url).replace(/\/+$/, "");
    const name = clean(input.name) || hostOf(url);
    const username = clean(input.username) || os.userInfo().username;
    const typedPassword = typeof input.password === "string" ? input.password : "";
    if (name.length > MAX_NAME_LENGTH) throw new ConnectionInputError(`名稱太長（上限 ${MAX_NAME_LENGTH} 字）`);
    if (!/^https?:\/\/\S+$/i.test(url)) throw new ConnectionInputError("伺服器網址必須以 https:// 或 http:// 開頭");

    const all = await readAll();
    // 沒指定 id 但網址已經登記過，視為更新同一個伺服器（重填帳密），不重複新增
    const existing = all.find((c) => c.kind === "server" && (input.id ? c.id === input.id : c.url.toLowerCase() === url.toLowerCase()));
    if (input.id && !existing) throw new ConnectionInputError(`找不到要編輯的伺服器：${input.id}`);
    const password = typedPassword || existing?.password || "";
    if (all.some((c) => c.kind === "server" && c.name === name && c.id !== existing?.id)) throw new ConnectionInputError(`已經有名稱為「${name}」的伺服器`);

    const { repos, auth } = await loadRepos(url, username, password);
    const saved: StoredConnection = { ...existing, id: existing?.id ?? randomUUID(), name, url, username, password, kind: "server", repos };
    await writeAll(existing ? all.map((c) => (c.id === existing.id ? saved : c)) : [...all, saved]);
    return { id: saved.id, name, url, username, repoCount: repos.length, auth };
  });
}

/** 重新讀取某個伺服器底下的 repo 清單（伺服器上新建了 repo 時用）。 */
export function refreshServer(id: string): Promise<PublicServer> {
  return queued(async () => {
    const all = await readAll();
    const server = all.find((c) => c.id === id && c.kind === "server");
    if (!server) throw new ConnectionInputError(`找不到伺服器：${id}`);
    const { repos, auth } = await loadRepos(server.url, server.username, server.password);
    const saved: StoredConnection = { ...server, repos };
    await writeAll(all.map((c) => (c.id === id ? saved : c)));
    return { id, name: server.name, url: server.url, username: server.username, repoCount: repos.length, auth };
  });
}
