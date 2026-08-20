import path from "node:path";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { randomBytes } from "node:crypto";

const queues = new Map<string, Promise<unknown>>();

/**
 * Serializes async transactions keyed by (resolved) file path within this process, so two nearly-simultaneous
 * tool calls that read-modify-write the same JSON file can't interleave and silently lose one side's update.
 * This is NOT a cross-process lock — it only guards concurrent calls inside this one running MCP server
 * process, which is the actual risk surface (two tool calls landing back-to-back in the same server).
 */
export function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(filePath);
  const prior = queues.get(key) ?? Promise.resolve();
  const run = prior.then(fn, fn);
  queues.set(
    key,
    run.then(
      () => undefined,
      () => undefined
    )
  );
  return run;
}

/** Reads JSON from `filePath`, returning `fallback` if the file doesn't exist. Does NOT lock by itself — a read-modify-write sequence should go through `updateJsonFile` instead. */
export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch (err: any) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

/** Writes `data` to `filePath` atomically (temp file in the same directory + rename), so a process killed mid-write never leaves a truncated/corrupt file at the real path. Does NOT lock by itself. */
export async function writeJsonFileAtomic(filePath: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${randomBytes(6).toString("hex")}`;
  await writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  await rename(tmpPath, filePath);
}

/**
 * Reads, mutates, and atomically writes back a JSON file as one locked transaction (see `withFileLock`) —
 * the standard way to safely do "read current value, compute the new value, persist it" against a JSON
 * store that multiple tool calls might touch concurrently. If `mutator` returns the exact same reference
 * it was given (no change needed), the write is skipped.
 */
export async function updateJsonFile<T>(
  filePath: string,
  fallback: T,
  mutator: (current: T) => T | Promise<T>
): Promise<T> {
  return withFileLock(filePath, async () => {
    const current = await readJsonFile(filePath, fallback);
    const next = await mutator(current);
    if (next !== current) {
      await writeJsonFileAtomic(filePath, next);
    }
    return next;
  });
}
