import path from "node:path";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";

export const HISTORY_ROOT = ".pipeline/.history";
const MAX_SNAPSHOTS_PER_FILE = 10;
const SOURCE_MARKER = "_source.txt";
const SNAPSHOT_NAME_PATTERN = /^\d{8}-\d{6}-\d{3}(\.[A-Za-z0-9]+)?$/;

export interface SnapshotInfo {
  name: string;
  bytes: number;
  savedAt: string;
}

/** Files under .pipeline/ (never the history itself) plus the original role-rule location. */
export function isRuleFilePath(relPath: string): boolean {
  const p = relPath.replace(/\\/g, "/");
  if (p.split("/").includes("..")) return false;
  if (p.startsWith(`${HISTORY_ROOT}/`)) return false;
  return p.startsWith(".pipeline/") || p.startsWith(".claude/pipeline-roles/");
}

function historyDir(projectDir: string, relPath: string): string {
  return path.join(projectDir, HISTORY_ROOT, relPath.replace(/\\/g, "/").replace(/\//g, "__"));
}

function snapshotName(relPath: string, now = new Date()): string {
  const iso = now.toISOString();
  const stamp = `${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 19).replace(/:/g, "")}-${iso.slice(20, 23)}`;
  return `${stamp}${path.extname(relPath)}`;
}

function savedAtFromName(name: string): string {
  const m = name.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(\d{3})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z` : name;
}

async function snapshotNames(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((n) => SNAPSHOT_NAME_PATTERN.test(n)).sort();
  } catch {
    return [];
  }
}

/** Saves `content` as a new snapshot unless it equals the latest one. Best effort: a history failure must never break reading the rule file itself. */
export async function snapshotIfChanged(projectDir: string, relPath: string, content: string): Promise<void> {
  if (!isRuleFilePath(relPath)) return;
  try {
    const dir = historyDir(projectDir, relPath);
    await mkdir(dir, { recursive: true });
    const names = await snapshotNames(dir);
    if (names.length > 0) {
      const latest = await readFile(path.join(dir, names[names.length - 1]), "utf-8");
      if (latest === content) return;
    } else {
      await writeFile(path.join(dir, SOURCE_MARKER), relPath.replace(/\\/g, "/"), "utf-8");
    }
    let when = new Date();
    while (names.includes(snapshotName(relPath, when))) when = new Date(when.getTime() + 1);
    await writeFile(path.join(dir, snapshotName(relPath, when)), content, "utf-8");
    for (const old of names.slice(0, Math.max(0, names.length + 1 - MAX_SNAPSHOTS_PER_FILE))) {
      await unlink(path.join(dir, old));
    }
  } catch {
    // ignored on purpose
  }
}

export async function listSnapshots(projectDir: string, relPath: string): Promise<SnapshotInfo[]> {
  const dir = historyDir(projectDir, relPath);
  const names = await snapshotNames(dir);
  const infos: SnapshotInfo[] = [];
  for (const name of names) {
    const content = await readFile(path.join(dir, name), "utf-8");
    infos.push({ name, bytes: Buffer.byteLength(content, "utf-8"), savedAt: savedAtFromName(name) });
  }
  return infos.reverse();
}

export async function listTrackedFiles(projectDir: string): Promise<{ file: string; snapshots: number; latestSavedAt: string | null }[]> {
  const root = path.join(projectDir, HISTORY_ROOT);
  let dirs: string[];
  try {
    dirs = await readdir(root);
  } catch {
    return [];
  }
  const tracked = [];
  for (const d of dirs) {
    try {
      const file = (await readFile(path.join(root, d, SOURCE_MARKER), "utf-8")).trim();
      const names = await snapshotNames(path.join(root, d));
      tracked.push({ file, snapshots: names.length, latestSavedAt: names.length ? savedAtFromName(names[names.length - 1]) : null });
    } catch {
      // not a history directory we created
    }
  }
  return tracked;
}

export function isValidSnapshotName(name: string): boolean {
  return SNAPSHOT_NAME_PATTERN.test(name);
}

export async function readSnapshot(projectDir: string, relPath: string, name: string): Promise<string> {
  return readFile(path.join(historyDir(projectDir, relPath), name), "utf-8");
}
