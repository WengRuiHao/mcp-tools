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

interface StoredConnection extends PublicConnection {
  password: string;
  [extra: string]: unknown;
}

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

function toPublic(c: StoredConnection): PublicConnection {
  return { id: c.id, name: c.name, url: c.url, username: c.username };
}

export async function listPublicConnections(): Promise<PublicConnection[]> {
  return (await readAll()).map(toPublic);
}

/** 同一時間只允許一個寫入，避免兩個設定請求互相蓋掉。 */
let writeQueue: Promise<unknown> = Promise.resolve();

export function saveConnection(input: ConnectionInput): Promise<PublicConnection> {
  const next = writeQueue.catch(() => undefined).then(() => doSave(input));
  writeQueue = next;
  return next;
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

  const file = getConnectionsFilePath();
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(updated, null, 2)}\n`, "utf-8");
  await rename(tmp, file);
  return toPublic(saved);
}
