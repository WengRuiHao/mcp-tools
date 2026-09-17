import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type BranchRole = "personal" | "staging" | "production";

export interface BranchRoleEntry {
  connectionId: string;
  projectId: string;
  branch: string;
  role: BranchRole;
  owner?: string;
  note?: string;
  updatedAt: string;
}

function getBranchRolesFilePath(): string {
  const configured = process.env.GITLAB_BRANCH_ROLES_FILE;
  if (configured) return path.resolve(configured);
  return path.resolve(__dirname, "..", "info", "branch-roles.json");
}

async function loadBranchRoles(): Promise<BranchRoleEntry[]> {
  try {
    const raw = await readFile(getBranchRolesFilePath(), "utf-8");
    return JSON.parse(raw) as BranchRoleEntry[];
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

async function saveBranchRoles(entries: BranchRoleEntry[]): Promise<void> {
  await writeFile(getBranchRolesFilePath(), JSON.stringify(entries, null, 2), "utf-8");
}

const sameProject = (a: BranchRoleEntry, b: { connectionId: string; projectId: string }) =>
  a.connectionId === b.connectionId && a.projectId === b.projectId;

const sameBranch = (a: BranchRoleEntry, b: { connectionId: string; projectId: string; branch: string }) =>
  sameProject(a, b) && a.branch === b.branch;

export interface SetBranchRoleInput {
  connectionId: string;
  projectId: string;
  branch: string;
  role: BranchRole;
  owner?: string;
  note?: string;
}

export interface SetBranchRoleResult {
  entry: BranchRoleEntry;
  /** The previous record for this exact branch, if this call overwrote it (role/owner/note change on the same branch). */
  replacedSameBranch?: BranchRoleEntry;
  /** The branch that used to hold this same staging/production slot, now demoted — since only one branch can plausibly BE "the" prod/staging target at a time, unlike personal which has no such limit. */
  demotedSingleton?: BranchRoleEntry;
}

export async function setBranchRole(input: SetBranchRoleInput): Promise<SetBranchRoleResult> {
  const entries = await loadBranchRoles();
  const now = new Date().toISOString();

  let demotedSingleton: BranchRoleEntry | undefined;
  let remaining = entries;

  if (input.role === "staging" || input.role === "production") {
    const singletonIndex = entries.findIndex((e) => sameProject(e, input) && e.role === input.role && e.branch !== input.branch);
    if (singletonIndex >= 0) {
      demotedSingleton = entries[singletonIndex];
      remaining = entries.filter((_, i) => i !== singletonIndex);
    }
  }

  const replacedIndex = remaining.findIndex((e) => sameBranch(e, input));
  const replacedSameBranch = replacedIndex >= 0 ? remaining[replacedIndex] : undefined;
  const withoutSameBranch = replacedIndex >= 0 ? remaining.filter((_, i) => i !== replacedIndex) : remaining;

  const entry: BranchRoleEntry = {
    connectionId: input.connectionId,
    projectId: input.projectId,
    branch: input.branch,
    role: input.role,
    owner: input.owner,
    note: input.note,
    updatedAt: now,
  };

  await saveBranchRoles([...withoutSameBranch, entry]);
  return { entry, replacedSameBranch, demotedSingleton };
}

export async function removeBranchRole(connectionId: string, projectId: string, branch: string): Promise<BranchRoleEntry | null> {
  const entries = await loadBranchRoles();
  const index = entries.findIndex((e) => sameBranch(e, { connectionId, projectId, branch }));
  if (index < 0) return null;
  const [removed] = entries.splice(index, 1);
  await saveBranchRoles(entries);
  return removed;
}

export interface ListBranchRolesFilter {
  connectionId?: string;
  projectId?: string;
  role?: BranchRole;
}

export async function listBranchRoles(filter: ListBranchRolesFilter = {}): Promise<BranchRoleEntry[]> {
  const entries = await loadBranchRoles();
  return entries.filter(
    (e) =>
      (!filter.connectionId || e.connectionId === filter.connectionId) &&
      (!filter.projectId || e.projectId === filter.projectId) &&
      (!filter.role || e.role === filter.role)
  );
}

export interface DeploymentBranches {
  production: string | null;
  staging: string | null;
  personal: Array<{ branch: string; owner?: string; note?: string }>;
}

export async function getDeploymentBranches(connectionId: string, projectId: string): Promise<DeploymentBranches> {
  const entries = await listBranchRoles({ connectionId, projectId });
  const production = entries.find((e) => e.role === "production")?.branch ?? null;
  const staging = entries.find((e) => e.role === "staging")?.branch ?? null;
  const personal = entries.filter((e) => e.role === "personal").map((e) => ({ branch: e.branch, owner: e.owner, note: e.note }));
  return { production, staging, personal };
}
