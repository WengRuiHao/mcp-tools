import path from "node:path";
import { getDataDir } from "./config-store.js";
import { readJsonFile, updateJsonFile } from "./atomic-store.js";

// ---------------------------------------------------------------------------
// SA/SD spec configuration — per Asana project (each project's SVN layout and
// SD ownership situation is independent, keyed by projectGid so they never mix).
// ---------------------------------------------------------------------------

export type SdMode = "external" | "self" | "self-generated" | "unregistered";

export interface SasdConfig {
  saRoot: string;
  sdMode: SdMode;
  sdRoot: string | null;
  /** Relative-to-projectDir path of the real local file where the AI-maintained SD doc is written (sdMode "self-generated" only) — a real file the user can pick up and check into SVN themselves, not something hidden inside this MCP's own install dir. */
  sdOutputPath: string | null;
  /** svn-mcp connection id/name (from svn_list_connections) this project's saRoot/sdRoot live under — required for "external"/"self" so run_project_shell-style connectivity verification (svn_test_connection) can gate registration before any ticket work proceeds. */
  svnConnectionId: string | null;
}

const SASD_CONFIG_FILE = "sasd-config.json";

function sasdConfigPath(): string {
  return path.join(getDataDir(), SASD_CONFIG_FILE);
}

export async function resolveSasdConfig(projectGid: string): Promise<SasdConfig | null> {
  const map = await readJsonFile<Record<string, SasdConfig>>(sasdConfigPath(), {});
  return map[projectGid] ?? null;
}

export async function registerSasdConfig(projectGid: string, config: SasdConfig): Promise<void> {
  await updateJsonFile<Record<string, SasdConfig>>(sasdConfigPath(), {}, (map) => ({ ...map, [projectGid]: config }));
}

const PROJECT_DIR_FILE = "project-dir-config.json";

function projectDirConfigPath(): string {
  return path.join(getDataDir(), PROJECT_DIR_FILE);
}

/** Which local/server code directory an Asana project's tickets should be tracked and worked against. Keyed by projectGid — independent from git-roots-store.ts, which separately tracks the actual .git root(s) *inside* that directory. */
export async function resolveProjectDir(projectGid: string): Promise<string | null> {
  const map = await readJsonFile<Record<string, string>>(projectDirConfigPath(), {});
  return map[projectGid] ?? null;
}

export async function registerProjectDir(projectGid: string, projectDir: string): Promise<void> {
  await updateJsonFile<Record<string, string>>(projectDirConfigPath(), {}, (map) => ({ ...map, [projectGid]: projectDir }));
}

const DEFAULT_PROJECT_FILE = "default-project.json";

function defaultProjectPath(): string {
  return path.join(getDataDir(), DEFAULT_PROJECT_FILE);
}

export interface DefaultProject {
  workspaceGid: string;
  projectGid: string;
  projectName: string;
}

/** The "today's tickets" default Asana project, so the daily trigger doesn't have to ask which project every time. */
export async function resolveDefaultProject(): Promise<DefaultProject | null> {
  return readJsonFile<DefaultProject | null>(defaultProjectPath(), null);
}

export async function registerDefaultProject(project: DefaultProject): Promise<void> {
  await updateJsonFile<DefaultProject | null>(defaultProjectPath(), null, () => project);
}
