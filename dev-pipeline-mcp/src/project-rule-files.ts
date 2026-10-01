import path from "node:path";
import { readFile } from "node:fs/promises";

/**
 * Project-owned rule files live in a tool-neutral directory so any AI client (not just Claude Code) can be pointed at them.
 * The first candidate wins; the second is the original location, kept so projects that already adopted it keep working.
 */
export const ROLE_FILE_CANDIDATES = (role: string): string[] => [`.pipeline/roles/${role}.md`, `.claude/pipeline-roles/${role}.md`];
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
