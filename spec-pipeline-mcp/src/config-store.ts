import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(moduleDir, "..", "data");
const mapFile = path.join(dataDir, "git-dir-map.json");

interface GitDirMap {
  [specDir: string]: string;
}

/** Atomically overwrites filePath: write a temp file, then rename over the target. A process killed mid-write leaves the old (or the new) full content, never a truncated half-written file. */
async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmpFile = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmpFile, JSON.stringify(data, null, 2), "utf-8");
  await rename(tmpFile, filePath);
}

/** Per-file write queues: serializes an entire read-modify-write cycle against the same path, so two near-simultaneous callers (e.g. two processes each registering a different spec dir) don't both read the same stale snapshot and clobber each other's write. */
const writeQueues = new Map<string, Promise<unknown>>();

function withFileLock<T>(filePath: string, task: () => Promise<T>): Promise<T> {
  const prior = writeQueues.get(filePath) ?? Promise.resolve();
  const settled = prior.then(task, task);
  writeQueues.set(filePath, settled.catch(() => {}));
  return settled;
}

async function readMapFromDisk(): Promise<GitDirMap> {
  try {
    const raw = await readFile(mapFile, "utf-8");
    return JSON.parse(raw) as GitDirMap;
  } catch (err: any) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
}

function normalizeDir(dir: string): string {
  return path.resolve(dir).replace(/\\/g, "/").toLowerCase();
}

export async function lookupGitDir(specDir: string): Promise<string | null> {
  const map = await readMapFromDisk();
  const target = normalizeDir(specDir);
  for (const [key, value] of Object.entries(map)) {
    if (normalizeDir(key) === target) return value;
  }
  return null;
}

export async function registerGitDir(specDir: string, gitDir: string): Promise<void> {
  await withFileLock(mapFile, async () => {
    const map = await readMapFromDisk();
    map[path.resolve(specDir)] = path.resolve(gitDir);
    await atomicWriteJson(mapFile, map);
  });
}

export async function listRegisteredMappings(): Promise<GitDirMap> {
  return readMapFromDisk();
}
