import { readdir } from "node:fs/promises";
import path from "node:path";
import { readStatus, type TicketStatus } from "./pipeline-store.js";
import { readJsonFile } from "./atomic-store.js";
import { getTicketsIndexFile } from "./config-store.js";
import { loadProjectFlowOverride } from "./workflow/load.js";

/** 批次 1M：多模組並行。專案 flow.json 開 multiModule 後，工作項目才能宣告動到哪些模組；進行中的功能若動到同一個模組只警告、不擋。 */

export const MAX_MODULES = 20;
export const MAX_MODULE_NAME_LEN = 60;
export const MULTI_MODULE_OFF_MESSAGE = "專案沒有開啟 multiModule（flow.json 的 multiModule:true），不能宣告 modules";

export interface OverlapWarning {
  workItemId: string;
  title: string;
  modules: string[];
}

/** 去空白、去重、保留順序；空字串、過長、過多一律丟錯。 */
export function normalizeModules(raw: readonly string[]): string[] {
  const out: string[] = [];
  for (const item of raw) {
    const name = typeof item === "string" ? item.trim() : "";
    if (!name) throw new Error("modules 的每個模組名稱都不可空白");
    if (name.length > MAX_MODULE_NAME_LEN) throw new Error(`modules 的模組名稱最長 ${MAX_MODULE_NAME_LEN} 字：${name.slice(0, 10)}…`);
    if (!out.includes(name)) out.push(name);
  }
  if (out.length > MAX_MODULES) throw new Error(`modules 最多 ${MAX_MODULES} 個`);
  return out;
}

/** 專案 flow.json 是否開了 multiModule；沒有檔案、沒有欄位都是關。flow.json 壞掉時丟錯（不悄悄當成關）。 */
export async function isMultiModuleProject(projectDir: string): Promise<boolean> {
  return (await loadProjectFlowOverride(projectDir))?.multiModule === true;
}

function sameDir(a: string | null | undefined, b: string): boolean {
  return !!a && a.toLowerCase() === b.toLowerCase();
}

function isFinished(status: TicketStatus): boolean {
  const d = status.work_item_progress?.gates["final-acceptance"]?.decision;
  return d === "confirmed" || d === "passed";
}

/** 同專案、尚未完成、宣告了模組，且與 modules 有交集的其他工作項目。壞掉讀不到的工作項目略過。 */
export async function findModuleOverlaps(projectDir: string, selfId: string, modules: readonly string[]): Promise<OverlapWarning[]> {
  if (modules.length === 0) return [];
  const index = await readJsonFile<Record<string, string>>(getTicketsIndexFile(), {});
  const mine = new Set(modules);
  const found: OverlapWarning[] = [];
  for (const id of Object.keys(index)) {
    if (id === selfId || !/^wi-\d{8}-\d+$/.test(id)) continue;
    let status: TicketStatus;
    try {
      status = await readStatus(id);
    } catch {
      continue;
    }
    if (!sameDir(status.project_dir, projectDir) || !status.modules?.length || isFinished(status)) continue;
    const shared = status.modules.filter((m) => mine.has(m));
    if (shared.length > 0) found.push({ workItemId: id, title: status.name ?? "", modules: shared });
  }
  return found;
}

export interface TableOverlapWarning {
  workItemId: string;
  title: string;
  tables: string[];
}

async function tablesIn(dir: string): Promise<string[]> {
  const files = await readdir(path.join(dir, "TableSchema")).catch(() => [] as string[]);
  return files.filter((f) => f.endsWith(".md") && f !== "system-er.md").map((f) => f.slice(0, -3));
}

/** 同專案、尚未完成的其他工作項目，TableSchema 裡有同名資料表者（只警告）。壞掉讀不到的略過。 */
export async function findTableOverlaps(projectDir: string, selfId: string, selfDir: string): Promise<TableOverlapWarning[]> {
  const mine = new Set(await tablesIn(selfDir));
  if (mine.size === 0) return [];
  const index = await readJsonFile<Record<string, string>>(getTicketsIndexFile(), {});
  const found: TableOverlapWarning[] = [];
  for (const [id, dir] of Object.entries(index)) {
    if (id === selfId || !/^wi-\d{8}-\d+$/.test(id) || typeof dir !== "string") continue;
    let status: TicketStatus;
    try {
      status = await readStatus(id);
    } catch {
      continue;
    }
    if (!sameDir(status.project_dir, projectDir) || isFinished(status)) continue;
    const shared = (await tablesIn(dir)).filter((t) => mine.has(t));
    if (shared.length > 0) found.push({ workItemId: id, title: status.name ?? "", tables: shared });
  }
  return found;
}

/** get 用：專案開了 multiModule 才檢查；沒有重疊不多欄位。 */
export async function tableOverlapField(id: string, status: TicketStatus, dir: string): Promise<{ tableOverlapWarnings?: TableOverlapWarning[] }> {
  if (!status.project_dir || !(await isMultiModuleProject(status.project_dir).catch(() => false))) return {};
  const w = await findTableOverlaps(status.project_dir, id, dir);
  return w.length > 0 ? { tableOverlapWarnings: w } : {};
}

export const MAX_DEPENDS_ON = 10;
const WORK_ITEM_ID_RE = /^wi-\d{8}-\d+$/;

export interface DependencyWarning {
  workItemId: string;
  title: string;
}

/** 去重、檢查格式與數量；每個依賴都必須存在、是同專案、且不是自己（selfId 為 null＝建立中，還沒有編號）。 */
export async function validateDependsOn(projectDir: string, selfId: string | null, raw: readonly string[]): Promise<string[]> {
  const ids = [...new Set(raw.map((x) => (typeof x === "string" ? x.trim() : "")))];
  if (ids.length > MAX_DEPENDS_ON) throw new Error(`dependsOn 最多 ${MAX_DEPENDS_ON} 個`);
  for (const id of ids) {
    if (!WORK_ITEM_ID_RE.test(id)) throw new Error(`dependsOn 要填工作項目編號（例如 wi-20260101-001）：${id || "（空白）"}`);
    if (id === selfId) throw new Error("dependsOn 不能包含自己");
    let dep: TicketStatus;
    try {
      dep = await readStatus(id);
    } catch {
      throw new Error(`dependsOn 找不到工作項目：${id}`);
    }
    if (!sameDir(dep.project_dir, projectDir)) throw new Error(`dependsOn 的 ${id} 不在同一個專案，不能依賴`);
  }
  return ids;
}

/** 專案沒開 multiModule 時拒絕非空的 dependsOn（與 modules 同一個訊息）；開了才逐項驗證。空陣列＝清除，直接回傳。 */
export async function prepareDependsOn(projectDir: string, selfId: string | null, raw: readonly string[], multiModule: boolean): Promise<string[]> {
  if (raw.length === 0) return [];
  if (!multiModule) throw new Error(MULTI_MODULE_OFF_MESSAGE.replace("modules", "modules／dependsOn"));
  return validateDependsOn(path.resolve(projectDir), selfId, raw);
}

/** 依賴的工作項目中尚未通過最終驗收的；讀不到的依賴略過。 */
export async function unfinishedDependencies(status: Pick<TicketStatus, "depends_on">): Promise<DependencyWarning[]> {
  const out: DependencyWarning[] = [];
  for (const id of status.depends_on ?? []) {
    try {
      const dep = await readStatus(id);
      if (!isFinished(dep)) out.push({ workItemId: id, title: dep.name ?? "" });
    } catch {
      /* 依賴的項目讀不到就略過，不影響本項目 */
    }
  }
  return out;
}

/** 給 confirm 用：SA 確認與最終驗收時提醒依賴還沒完成（只警告）。 */
export async function dependencyWarningFields(status: TicketStatus): Promise<{ dependencyWarnings?: DependencyWarning[] }> {
  if (!status.depends_on?.length) return {};
  const w = await unfinishedDependencies(status);
  return w.length > 0 ? { dependencyWarnings: w } : {};
}

export interface MultiModuleFields {
  modules?: string[];
  overlapWarnings?: OverlapWarning[];
  dependsOn?: string[];
  dependencyWarnings?: DependencyWarning[];
}

/** 給 create／set_scope／get 用：宣告了模組或依賴才有結果；專案關掉 multiModule 後只列宣告、不再警告。 */
export async function multiModuleFieldsFor(id: string, status: TicketStatus): Promise<MultiModuleFields> {
  const hasModules = !!status.modules?.length;
  const hasDeps = !!status.depends_on?.length;
  if ((!hasModules && !hasDeps) || !status.project_dir) return {};
  const declared: MultiModuleFields = { ...(hasModules ? { modules: status.modules } : {}), ...(hasDeps ? { dependsOn: status.depends_on } : {}) };
  if (!(await isMultiModuleProject(status.project_dir).catch(() => false))) return declared;
  const overlaps = hasModules ? await findModuleOverlaps(status.project_dir, id, status.modules ?? []) : [];
  const deps = hasDeps ? await unfinishedDependencies(status) : [];
  return { ...declared, ...(overlaps.length > 0 ? { overlapWarnings: overlaps } : {}), ...(deps.length > 0 ? { dependencyWarnings: deps } : {}) };
}
