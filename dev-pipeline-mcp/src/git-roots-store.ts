import path from "node:path";
import { getGitRootsConfigFile } from "./config-store.js";
import { readJsonFile, updateJsonFile } from "./atomic-store.js";

export interface GitRootEntry {
  label: string;
  path: string;
}

function normalizeKey(projectDir: string): string {
  return path.resolve(projectDir).toLowerCase();
}

/** Returns this projectDir's registered git version-control roots, or null if never registered. */
export async function resolveGitRoots(projectDir: string): Promise<GitRootEntry[] | null> {
  const config = await readJsonFile<Record<string, GitRootEntry[]>>(getGitRootsConfigFile(), {});
  return config[normalizeKey(projectDir)] ?? null;
}

/** Registers (overwrites) the git version-control roots for a projectDir — e.g. separate frontend/backend repos, or a single shared one. */
export async function registerGitRoots(projectDir: string, gitRoots: GitRootEntry[]): Promise<void> {
  const key = normalizeKey(projectDir);
  const value = gitRoots.map((r) => ({ label: r.label, path: path.resolve(r.path) }));
  await updateJsonFile<Record<string, GitRootEntry[]>>(getGitRootsConfigFile(), {}, (config) => ({ ...config, [key]: value }));
}

/**
 * Reverse lookup: which registered projectDir(s) reference this exact git root path — used by the
 * git-native hook (post-commit/post-merge, see git-hooks-tools.ts/http-server.ts) to figure out which
 * PENDING_HUMAN_ACTIONS.html report(s) to refresh from a bare gitRoot, without already knowing a taskGid.
 * Returns the normalized (resolved, lowercased) projectDir keys as stored — safe to use directly with
 * fs/path calls since Windows paths are case-insensitive.
 */
export async function findProjectDirsForGitRoot(gitRoot: string): Promise<string[]> {
  const config = await readJsonFile<Record<string, GitRootEntry[]>>(getGitRootsConfigFile(), {});
  const target = normalizeKey(gitRoot);
  return Object.entries(config)
    .filter(([, roots]) => roots.some((r) => normalizeKey(r.path) === target))
    .map(([projectDir]) => projectDir);
}
