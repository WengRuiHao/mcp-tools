import path from "node:path";
import { readFile } from "node:fs/promises";
import { readStatus } from "./pipeline-store.js";

/**
 * Project-owned rule files live in a tool-neutral directory so any AI client (not just Claude Code) can be pointed at them.
 * The first candidate wins; the second is the original location, kept so projects that already adopted it keep working.
 */
export const ROLE_FILE_CANDIDATES = (role: string): string[] => [`.pipeline/roles/${role}.md`, `.claude/pipeline-roles/${role}.md`];
/** Rules that apply to every role (e.g. which standards files to read before coding). */
export const COMMON_RULES_FILE_CANDIDATES: string[] = [".pipeline/roles/all.md", ".claude/pipeline-roles/all.md"];
export const GATES_FILE_CANDIDATES: string[] = [".pipeline/gates.json", ".claude/pipeline-roles/gates.json"];

export interface FoundRuleFile {
  relPath: string;
  content: string;
}

/** Returns the first candidate that exists, or null when none do. Any error other than "not found" is thrown so callers decide whether to surface it. */
export async function readFirstExisting(projectDir: string, relPaths: string[]): Promise<FoundRuleFile | null> {
  for (const relPath of relPaths) {
    try {
      const content = await readFile(path.join(projectDir, relPath), "utf-8");
      return { relPath, content };
    } catch (err: any) {
      if (err?.code !== "ENOENT" && err?.code !== "ENOTDIR") throw err;
    }
  }
  return null;
}

/** Project-owned SD writing rules; when present they replace the built-in generic templates so the AI only ever reads one version. */
export const SD_TEMPLATE_CANDIDATES: string[] = [".pipeline/templates/SD_TEMPLATE.md"];
export const SD_VERSIONING_CANDIDATES: string[] = [".pipeline/templates/SD_VERSIONING_RULES.md"];

/** projectDir given explicitly wins; otherwise fall back to the one recorded on the ticket so a client that forgets projectDir still gets the project's rules. */
export async function resolveProjectDir(projectDir?: string | null, taskGid?: string | null): Promise<string | null> {
  if (projectDir) return projectDir;
  if (!taskGid) return null;
  try {
    return (await readStatus(taskGid)).project_dir ?? null;
  } catch {
    return null;
  }
}

export interface ProjectSettings {
  /** list_pending_tickets only lists tickets assigned to the account this pipeline runs as. */
  onlyAssignedToMe?: boolean;
}

export const SETTINGS_FILE_CANDIDATES: string[] = [".pipeline/settings.json"];

/** No settings file means defaults. A file that exists but cannot be parsed throws, so a typo never silently widens what the AI works on. */
export async function readProjectSettings(projectDir: string): Promise<ProjectSettings> {
  const found = await readFirstExisting(projectDir, SETTINGS_FILE_CANDIDATES);
  if (!found) return {};
  try {
    return JSON.parse(found.content) as ProjectSettings;
  } catch {
    throw new Error(`${found.relPath} 不是合法的 JSON，請修正後再呼叫（為避免設定壞掉時悄悄變成列出所有人的票，這次不繼續）`);
  }
}
