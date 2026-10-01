import path from "node:path";
import { getDataDir } from "./config-store.js";
import { readJsonFile, updateJsonFile } from "./atomic-store.js";

// ---------------------------------------------------------------------------
// SA/SD spec configuration — per Asana project (each project's SVN layout and
// SD ownership situation is independent, keyed by projectGid so they never mix).
// ---------------------------------------------------------------------------

export type SdMode = "external" | "self" | "self-generated" | "unregistered";

/** Only meaningful when sdMode is "self-generated": which comes first, the SD draft or the code. "spec_first" (default/original behavior) drafts+confirms the SD before the engineer touches any code; "code_first" lets the engineer implement directly from the analyst's findings, then the spec-writer reverse-derives the SD from the actual change afterward — still gated by the same spec_confirmation before the ticket can reach "verified". */
export type SpecOrder = "spec_first" | "code_first";

export interface SasdConfig {
  saRoot: string;
  sdMode: SdMode;
  sdRoot: string | null;
  /** Relative-to-projectDir path of the real local file where the AI-maintained SD doc is written (sdMode "self-generated" only) — a real file the user can pick up and check into SVN themselves, not something hidden inside this MCP's own install dir. */
  sdOutputPath: string | null;
  /** svn-mcp connection id/name (from svn_list_connections) this project's saRoot/sdRoot live under — required for "external"/"self" so run_project_shell-style connectivity verification (svn_test_connection) can gate registration before any ticket work proceeds. */
  svnConnectionId: string | null;
  /** Only set (non-null) when sdMode is "self-generated" — decides whether this project drafts the SD before or after the code for every ticket. Null for every other sdMode. */
  specOrder: SpecOrder | null;
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

const LEGACY_TEST_PROFILE_FILE = "legacy-test-profile.json";

function legacyTestProfilePath(): string {
  return path.join(getDataDir(), LEGACY_TEST_PROFILE_FILE);
}

/**
 * 這個 Asana 專案是否屬於「老舊系統測試」情境（測試工程師說明書第三章：JDK6+舊IE 這類自動化測不到的環境）。
 * 預設 false——不用每個專案都主動問這一題，只有使用者明確告知過（例如「這個專案是舊系統」）才登記為 true。
 * 跟 SasdConfig 分開存放，因為這個判斷跟 sdMode 無關（sdMode: "unregistered" 的專案一樣可能是老系統）。
 */
export async function resolveLegacyTestProfile(projectGid: string): Promise<boolean> {
  const map = await readJsonFile<Record<string, boolean>>(legacyTestProfilePath(), {});
  return map[projectGid] ?? false;
}

export async function registerLegacyTestProfile(projectGid: string, legacyTestProfile: boolean): Promise<void> {
  await updateJsonFile<Record<string, boolean>>(legacyTestProfilePath(), {}, (map) => ({ ...map, [projectGid]: legacyTestProfile }));
}

// ---------------------------------------------------------------------------
// Test capability — per Asana project, whether/how the engineer role should
// write automated tests. Separate from LegacyTestProfile: that flag is about
// which *manual* test-engineer chapter applies (JDK6+old IE UI quirks); this
// is about whether the engineer can add JUnit/Jest-style tests at all, and
// with which toolchain version if the project's JDK is too old for modern
// JUnit5/Mockito.
// ---------------------------------------------------------------------------

export type TestCapabilityMode = "modern" | "legacy_junit4" | "none";

export interface TestCapabilityConfig {
  mode: TestCapabilityMode;
  /** Free-text context, e.g. "JDK6, 只能用 JUnit4.12 + Mockito 1.10.19" or "純 JSP，沒有 build test task". Null when mode is "modern" and nothing extra needs saying. */
  note: string | null;
}

const TEST_CAPABILITY_FILE = "test-capability-config.json";

function testCapabilityConfigPath(): string {
  return path.join(getDataDir(), TEST_CAPABILITY_FILE);
}

export async function resolveTestCapability(projectGid: string): Promise<TestCapabilityConfig | null> {
  const map = await readJsonFile<Record<string, TestCapabilityConfig>>(testCapabilityConfigPath(), {});
  return map[projectGid] ?? null;
}

export async function registerTestCapability(projectGid: string, config: TestCapabilityConfig): Promise<void> {
  await updateJsonFile<Record<string, TestCapabilityConfig>>(testCapabilityConfigPath(), {}, (map) => ({ ...map, [projectGid]: config }));
}

function normalizeDirForCompare(dir: string): string {
  const resolved = path.resolve(dir);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * get_role_prompt 只拿得到 projectDir、拿不到 projectGid，所以由 project-dir-config 反查：
 * 只有「對應到這個目錄的每一個 Asana 專案都登記過、且都是同一個 mode」才回傳該 mode，其餘（沒登記、
 * 多個專案設定不一致、目錄對不上）一律回傳 null，呼叫端照完整說明處理，不會誤省略。
 */
export async function resolveUniformTestCapabilityMode(projectDir: string): Promise<TestCapabilityMode | null> {
  const dirMap = await readJsonFile<Record<string, string>>(projectDirConfigPath(), {});
  const target = normalizeDirForCompare(projectDir);
  const gids = Object.entries(dirMap)
    .filter(([, dir]) => normalizeDirForCompare(dir) === target)
    .map(([gid]) => gid);
  if (gids.length === 0) return null;

  const capMap = await readJsonFile<Record<string, TestCapabilityConfig>>(testCapabilityConfigPath(), {});
  const modes = new Set(gids.map((gid) => capMap[gid]?.mode ?? null));
  if (modes.size !== 1) return null;
  return [...modes][0];
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

const DEFAULT_PROJECT_BY_DIR_FILE = "default-project-by-dir.json";

function defaultProjectByDirPath(): string {
  return path.join(getDataDir(), DEFAULT_PROJECT_BY_DIR_FILE);
}

function normalizeDirKey(dir: string): string {
  const abs = path.resolve(dir).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

/**
 * The "today's tickets" default Asana project, so the daily trigger doesn't have to ask which project every time.
 * With `cwd`: looked up per working directory (nearest registered ancestor wins) and never falls back to the global
 * value — a directory nobody registered must be asked about, not silently inherit another project's default.
 * Without `cwd`: the legacy single global value.
 */
export async function resolveDefaultProject(cwd?: string | null): Promise<DefaultProject | null> {
  if (!cwd) return readJsonFile<DefaultProject | null>(defaultProjectPath(), null);
  const map = await readJsonFile<Record<string, DefaultProject>>(defaultProjectByDirPath(), {});
  const target = normalizeDirKey(cwd);
  const matchedKey = Object.keys(map)
    .filter((key) => target === key || target.startsWith(key + path.sep))
    .sort((a, b) => b.length - a.length)[0];
  return matchedKey ? map[matchedKey] : null;
}

export async function registerDefaultProject(project: DefaultProject, cwd?: string | null): Promise<void> {
  if (!cwd) {
    await updateJsonFile<DefaultProject | null>(defaultProjectPath(), null, () => project);
    return;
  }
  await updateJsonFile<Record<string, DefaultProject>>(defaultProjectByDirPath(), {}, (map) => ({
    ...map,
    [normalizeDirKey(cwd)]: project,
  }));
}
