import path from "node:path";
import { getDataDir } from "./config-store.js";
import { readJsonFile, updateJsonFile } from "./atomic-store.js";

/**
 * A worktree covers a GROUP of tickets (not one ticket = one worktree) — matches the user's actual habit
 * of bundling related tickets into the same commit. See memory `project_dev_pipeline_worktree_design.md`
 * for the full design rationale; this store is only the persistence layer.
 */
export interface WorktreeEntry {
  /** Stable id, currently the leaf ticket-number folder name of whichever ticket first created this worktree. */
  id: string;
  gitRoot: string;
  worktreePath: string;
  branch: string;
  sourceBranch: string;
  /** sourceBranch's commit hash as of this worktree's last successful create/rebase/merge — the reference point for divergence detection. */
  baseCommit: string;
  ticketGids: string[];
  status: "active" | "abandoned";
  createdAt: string;
  updatedAt: string;
  lastMergeCommit: string | null;
}

function worktreesConfigFile(): string {
  return path.join(getDataDir(), "worktrees.json");
}

async function readAll(): Promise<Record<string, WorktreeEntry>> {
  return readJsonFile<Record<string, WorktreeEntry>>(worktreesConfigFile(), {});
}

export async function listWorktreeEntries(): Promise<WorktreeEntry[]> {
  const all = await readAll();
  return Object.values(all);
}

export async function findWorktreeById(id: string): Promise<WorktreeEntry | null> {
  const all = await readAll();
  return all[id] ?? null;
}

export async function findWorktreeByTicket(taskGid: string): Promise<WorktreeEntry | null> {
  const all = await readAll();
  return Object.values(all).find((e) => e.ticketGids.includes(taskGid)) ?? null;
}

export async function createWorktreeEntry(entry: WorktreeEntry): Promise<WorktreeEntry> {
  await updateJsonFile<Record<string, WorktreeEntry>>(worktreesConfigFile(), {}, (all) => {
    if (all[entry.id]) {
      throw new Error(`worktree id "${entry.id}" 已經存在，不能重複建立。`);
    }
    return { ...all, [entry.id]: entry };
  });
  return entry;
}

export async function updateWorktreeEntry(id: string, patch: Partial<WorktreeEntry>): Promise<WorktreeEntry> {
  let updated: WorktreeEntry | null = null;
  await updateJsonFile<Record<string, WorktreeEntry>>(worktreesConfigFile(), {}, (all) => {
    const current = all[id];
    if (!current) {
      throw new Error(`找不到 worktree id "${id}"。`);
    }
    updated = { ...current, ...patch, updatedAt: new Date().toISOString() };
    return { ...all, [id]: updated };
  });
  return updated as unknown as WorktreeEntry;
}

export async function addTicketToWorktree(id: string, taskGid: string): Promise<WorktreeEntry> {
  let updated: WorktreeEntry | null = null;
  await updateJsonFile<Record<string, WorktreeEntry>>(worktreesConfigFile(), {}, (all) => {
    const current = all[id];
    if (!current) {
      throw new Error(`找不到 worktree id "${id}"。`);
    }
    if (current.ticketGids.includes(taskGid)) {
      updated = current;
      return all;
    }
    updated = { ...current, ticketGids: [...current.ticketGids, taskGid], updatedAt: new Date().toISOString() };
    return { ...all, [id]: updated };
  });
  return updated as unknown as WorktreeEntry;
}

export async function removeWorktreeEntry(id: string): Promise<void> {
  await updateJsonFile<Record<string, WorktreeEntry>>(worktreesConfigFile(), {}, (all) => {
    if (!all[id]) return all;
    const next = { ...all };
    delete next[id];
    return next;
  });
}
