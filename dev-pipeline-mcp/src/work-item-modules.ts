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

/** 給 create／set_scope／get 用：只有專案開了 multiModule 且本項目宣告了模組才會有結果。 */
export async function overlapFieldsFor(id: string, status: TicketStatus): Promise<{ modules?: string[]; overlapWarnings?: OverlapWarning[] }> {
  if (!status.modules?.length || !status.project_dir) return {};
  if (!(await isMultiModuleProject(status.project_dir).catch(() => false))) return { modules: status.modules };
  const warnings = await findModuleOverlaps(status.project_dir, id, status.modules);
  return { modules: status.modules, ...(warnings.length > 0 ? { overlapWarnings: warnings } : {}) };
}
