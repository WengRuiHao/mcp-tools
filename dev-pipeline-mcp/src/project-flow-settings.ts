import path from "node:path";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { withFileLock } from "./atomic-store.js";
import { snapshotIfChanged } from "./rule-history.js";
import type { SasdConfig, SdMode, SpecOrder, TestCapabilityConfig, TestCapabilityMode } from "./project-registry.js";

/**
 * 專案自己的「流程設定」：放在 `<projectDir>/.pipeline/settings.json` 的 `flow.profiles[]`，
 * 每個 Asana 專案（projectGid）一筆。同一個 projectDir 底下可以有多個 Asana 專案、各自不同模式
 * （例如一個專案規格由別人產、另一個由 MCP 產）。
 *
 * 讀取優先序：專案目錄的 profile > MCP 自己 data/*.json（舊資料，當 fallback，不需搬遷）。
 * 欄位刻意沿用既有 SasdConfig／TestCapabilityConfig 的名稱，之後要改版再統一改名。
 * 這個檔案不可 import project-rule-files／pipeline-store（會與 project-registry 形成循環引用）。
 */

export const SETTINGS_REL_PATH = ".pipeline/settings.json";

export interface FlowProfile {
  match: { projectGid: string };
  sasd?: SasdConfig;
  testCapability?: TestCapabilityConfig;
  legacyTestProfile?: boolean;
}

const SD_MODES: readonly SdMode[] = ["external", "self", "self-generated", "unregistered"];
const SPEC_ORDERS: readonly SpecOrder[] = ["spec_first", "code_first"];
const TEST_MODES: readonly TestCapabilityMode[] = ["modern", "legacy_junit4", "none"];

function settingsPath(projectDir: string): string {
  return path.join(projectDir, SETTINGS_REL_PATH);
}

export async function isUsableProjectDir(projectDir: string): Promise<boolean> {
  try {
    return (await stat(projectDir)).isDirectory();
  } catch {
    return false;
  }
}

/** 檔案不存在回傳 null；存在但不是合法 JSON 物件一律丟錯，避免設定壞掉時悄悄退回別的模式。 */
async function readSettingsObject(projectDir: string): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await readFile(settingsPath(projectDir), "utf-8");
  } catch (err: any) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return null;
    throw err;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`${SETTINGS_REL_PATH} 不是合法的 JSON 物件（${projectDir}），請修正後再呼叫；為避免悄悄退回別的規格／測試模式，這次不繼續。`);
  }
}

function fail(projectGid: string, message: string): never {
  throw new Error(`${SETTINGS_REL_PATH} 的 flow.profiles（projectGid ${projectGid}）${message}`);
}

function normalizeSasd(projectGid: string, value: unknown): SasdConfig {
  const v = value as Partial<SasdConfig> | null;
  if (!v || typeof v !== "object") fail(projectGid, "的 sasd 必須是物件");
  if (!SD_MODES.includes(v.sdMode as SdMode)) fail(projectGid, `的 sasd.sdMode 必須是 ${SD_MODES.join("／")}`);
  if (typeof v.saRoot !== "string" || v.saRoot === "") fail(projectGid, "的 sasd.saRoot 必須是非空字串（沒有 SA 請用 N/A 開頭的占位）");
  if (v.specOrder != null && !SPEC_ORDERS.includes(v.specOrder)) fail(projectGid, `的 sasd.specOrder 必須是 ${SPEC_ORDERS.join("／")}`);
  const selfGenerated = v.sdMode === "self-generated";
  if (selfGenerated && (!v.sdOutputPath || !v.specOrder)) fail(projectGid, "：self-generated 必須同時有 sasd.sdOutputPath 與 sasd.specOrder");
  return {
    saRoot: v.saRoot,
    sdMode: v.sdMode as SdMode,
    sdRoot: v.sdRoot ?? null,
    sdOutputPath: v.sdOutputPath ?? null,
    svnConnectionId: v.svnConnectionId ?? null,
    specOrder: selfGenerated ? (v.specOrder ?? null) : null,
  };
}

function normalizeTestCapability(projectGid: string, value: unknown): TestCapabilityConfig {
  const v = value as Partial<TestCapabilityConfig> | null;
  if (!v || typeof v !== "object" || !TEST_MODES.includes(v.mode as TestCapabilityMode)) {
    fail(projectGid, `的 testCapability.mode 必須是 ${TEST_MODES.join("／")}`);
  }
  return { mode: v.mode as TestCapabilityMode, note: v.note ?? null };
}

function normalizeProfile(entry: unknown): FlowProfile {
  const e = entry as { match?: { projectGid?: unknown } } & Partial<FlowProfile>;
  const gid = e?.match?.projectGid;
  if (typeof gid !== "string" || gid === "") throw new Error(`${SETTINGS_REL_PATH} 的 flow.profiles 每一筆都要有 match.projectGid（字串）`);
  const profile: FlowProfile = { match: { projectGid: gid } };
  if (e.sasd !== undefined) profile.sasd = normalizeSasd(gid, e.sasd);
  if (e.testCapability !== undefined) profile.testCapability = normalizeTestCapability(gid, e.testCapability);
  if (e.legacyTestProfile !== undefined) {
    if (typeof e.legacyTestProfile !== "boolean") fail(gid, "的 legacyTestProfile 必須是 true／false");
    profile.legacyTestProfile = e.legacyTestProfile;
  }
  return profile;
}

function profilesOf(settings: Record<string, unknown> | null): unknown[] {
  const flow = settings?.flow as { profiles?: unknown } | undefined;
  if (flow === undefined) return [];
  if (!flow || typeof flow !== "object" || !Array.isArray(flow.profiles)) throw new Error(`${SETTINGS_REL_PATH} 的 flow 必須是 { "profiles": [...] }`);
  for (const entry of flow.profiles) {
    const gid = (entry as FlowProfile | null)?.match?.projectGid;
    if (typeof gid !== "string" || gid === "") throw new Error(`${SETTINGS_REL_PATH} 的 flow.profiles 每一筆都要有 match.projectGid（字串）`);
  }
  return flow.profiles;
}

/** 這個專案目錄裡、屬於這個 Asana 專案的流程設定；沒有就回傳 null（呼叫端退回 data/*.json）。 */
export async function readFlowProfile(projectDir: string, projectGid: string): Promise<FlowProfile | null> {
  const entries = profilesOf(await readSettingsObject(projectDir));
  const hits = entries.filter((e) => (e as FlowProfile)?.match?.projectGid === projectGid);
  if (hits.length > 1) fail(projectGid, "出現不只一筆（同一個 projectGid 只能有一筆 profile）");
  return hits.length === 1 ? normalizeProfile(hits[0]) : null;
}

/** 新增或更新這個 Asana 專案的 profile（只覆寫有帶的欄位），保留 settings.json 其餘內容（如 onlyAssignedToMe）。 */
export async function upsertFlowProfile(
  projectDir: string,
  projectGid: string,
  patch: Partial<Omit<FlowProfile, "match">>
): Promise<void> {
  const file = settingsPath(projectDir);
  await withFileLock(file, async () => {
    const current = await readSettingsObject(projectDir);
    const entries = profilesOf(current).map((e) => e as FlowProfile);
    const existing = entries.find((e) => e?.match?.projectGid === projectGid);
    const merged = normalizeProfile({ ...(existing ?? { match: { projectGid } }), ...patch, match: { projectGid } });
    const profiles = existing ? entries.map((e) => (e === existing ? merged : e)) : [...entries, merged];
    const next = { ...(current ?? {}), flow: { ...((current?.flow as object | undefined) ?? {}), profiles } };

    const previous = await readFile(file, "utf-8").catch(() => null);
    if (previous !== null) await snapshotIfChanged(projectDir, SETTINGS_REL_PATH, previous);
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${randomBytes(6).toString("hex")}`;
    await writeFile(tmp, JSON.stringify(next, null, 2) + "\n", "utf-8");
    await rename(tmp, file);
  });
}
