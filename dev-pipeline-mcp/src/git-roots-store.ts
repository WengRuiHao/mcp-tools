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
