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
  /** ticketNamePattern 選填：regex 字串（與 gates.json 相同，`new RegExp(p).test(票名)`，區分大小寫）；沒有它的 profile 是該專案的預設。 */
  match: { projectGid: string; ticketNamePattern?: string };
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

/** match.ticketNamePattern：沒寫回傳 undefined；寫了必須是非空字串且是合法 regex，否則報錯（不悄悄忽略）。 */
function patternOf(projectGid: string, entry: unknown): string | undefined {
  const raw = (entry as { match?: { ticketNamePattern?: unknown } } | null)?.match?.ticketNamePattern;
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw === "") fail(projectGid, "的 match.ticketNamePattern 必須是非空字串（regex）；不想依票名分流就整個欄位拿掉");
  try {
    new RegExp(raw);
  } catch (err: any) {
    fail(projectGid, `的 match.ticketNamePattern「${raw}」不是合法的正規表示式：${err?.message ?? String(err)}`);
  }
  return raw;
}

function normalizeProfile(entry: unknown): FlowProfile {
  const e = entry as { match?: { projectGid?: unknown } } & Partial<FlowProfile>;
  const gid = e?.match?.projectGid;
  if (typeof gid !== "string" || gid === "") throw new Error(`${SETTINGS_REL_PATH} 的 flow.profiles 每一筆都要有 match.projectGid（字串）`);
  const pattern = patternOf(gid, e);
  const profile: FlowProfile = { match: pattern === undefined ? { projectGid: gid } : { projectGid: gid, ticketNamePattern: pattern } };
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

/** 同一個 projectGid 的所有 profile 的共同驗證：每筆 pattern 合法、最多一筆預設、pattern 不可重複。 */
function validateGroup(projectGid: string, hits: unknown[]): void {
  if (hits.length <= 1) {
    for (const h of hits) patternOf(projectGid, h);
    return;
  }
  const seen = new Set<string | undefined>();
  for (const h of hits) {
    const pattern = patternOf(projectGid, h);
    if (seen.has(pattern)) {
      fail(projectGid, pattern === undefined ? "出現不只一筆預設 profile（沒有 match.ticketNamePattern 的只能有一筆；同一個 projectGid 要多筆請各自加不同的 ticketNamePattern）" : `的 match.ticketNamePattern「${pattern}」重複`);
    }
    seen.add(pattern);
  }
}

function groupOf(settings: Record<string, unknown> | null, projectGid: string): unknown[] {
  const hits = profilesOf(settings).filter((e) => (e as FlowProfile)?.match?.projectGid === projectGid);
  validateGroup(projectGid, hits);
  return hits;
}

/**
 * 依票名在同一個 projectGid 的 profile 裡選一筆：有 pattern 且符合者優先（兩筆以上同時符合直接報錯，不靠陣列順序），
 * 否則用沒有 pattern 的預設。專案根本沒有 profile 回傳 null；有 profile 卻選不出來（沒帶票名或票名都不符合、又沒有預設）一律報錯，
 * 不退回 data/*.json，避免把「依票名才生效的設定」誤當成沒設定。
 */
function selectProfile(projectGid: string, hits: unknown[], ticketName?: string | null): unknown | null {
  if (hits.length === 0) return null;
  const defaults = hits.filter((h) => patternOf(projectGid, h) === undefined);
  if (ticketName) {
    const matched = hits.filter((h) => {
      const p = patternOf(projectGid, h);
      return p !== undefined && new RegExp(p).test(ticketName);
    });
    if (matched.length > 1) {
      const pats = matched.map((h) => `「${patternOf(projectGid, h)}」`).join("、");
      fail(projectGid, `有多筆 ticketNamePattern 同時符合票名「${ticketName}」：${pats}；請改成互斥的規則（不靠陣列順序決定）`);
    }
    if (matched.length === 1) return matched[0];
  }
  if (defaults.length === 1) return defaults[0];
  const pats = hits.map((h) => `「${patternOf(projectGid, h)}」`).join("、");
  fail(
    projectGid,
    ticketName
      ? `只有依票名生效的 profile（${pats}），票名「${ticketName}」都不符合、也沒有預設 profile（沒有 ticketNamePattern 的那筆）；請補一筆預設 profile`
      : `只有依票名生效的 profile（${pats}），沒有預設 profile（沒有 ticketNamePattern 的那筆），而這次呼叫沒有票名可比對；請補一筆預設 profile，或改帶票名的方式呼叫`
  );
}

/**
 * 這個專案目錄裡、屬於這個 Asana 專案的流程設定；沒有就回傳 null（呼叫端退回 data/*.json）。
 * 帶 ticketName 時依票名選 profile；沒帶時回傳預設 profile（沒有 ticketNamePattern 的那筆）。
 */
export async function readFlowProfile(projectDir: string, projectGid: string, ticketName?: string | null): Promise<FlowProfile | null> {
  const hits = groupOf(await readSettingsObject(projectDir), projectGid);
  const chosen = selectProfile(projectGid, hits, ticketName);
  return chosen === null ? null : normalizeProfile(chosen);
}

export interface FlowVariantSummary {
  ticketNamePattern: string | null;
  sdMode: string | null;
  specOrder: string | null;
  testCapabilityMode: string | null;
}

/** 這個專案有「依票名分流」的 profile 時，列出全部 profile 摘要（含預設）；沒有任何 pattern profile 回傳 null。 */
export async function describeFlowVariants(projectDir: string, projectGid: string): Promise<{ hasDefault: boolean; variants: FlowVariantSummary[] } | null> {
  const hits = groupOf(await readSettingsObject(projectDir), projectGid);
  if (!hits.some((h) => patternOf(projectGid, h) !== undefined)) return null;
  const profiles = hits.map((h) => normalizeProfile(h));
  return {
    hasDefault: profiles.some((p) => p.match.ticketNamePattern === undefined),
    variants: profiles.map((p) => ({
      ticketNamePattern: p.match.ticketNamePattern ?? null,
      sdMode: p.sasd?.sdMode ?? null,
      specOrder: p.sasd?.specOrder ?? null,
      testCapabilityMode: p.testCapability?.mode ?? null,
    })),
  };
}

/** 這個專案目錄裡屬於該 Asana 專案的全部 profile（已驗證、已正規化），不做票名選擇。 */
export async function readAllFlowProfiles(projectDir: string, projectGid: string): Promise<FlowProfile[]> {
  return groupOf(await readSettingsObject(projectDir), projectGid).map((h) => normalizeProfile(h));
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
    const sameGid = groupOf(current, projectGid) as FlowProfile[];
    if (sameGid.length > 1) {
      throw new Error(`${SETTINGS_REL_PATH} 的 projectGid ${projectGid} 有多筆 profile（依票名切換），register 無法判斷要改哪一筆；請直接手動編輯 ${SETTINGS_REL_PATH}。`);
    }
    const existing = sameGid[0];
    const merged = normalizeProfile({ ...(existing ?? { match: { projectGid } }), ...patch, match: existing?.match ?? { projectGid } });
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
