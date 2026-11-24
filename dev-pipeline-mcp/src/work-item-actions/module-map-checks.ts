import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { MODULE_MAP_FILE, blockedByUnfinishedSystemModules, checkModulesDeclared, checkCrossModuleCalls, checkTableOwnership, parseCrossModuleCalls, parseGlossary, parseModuleMap } from "../module-map.js";
import { readProjectDoc } from "../project-docs-store.js";
import { isMultiModuleProject } from "../work-item-modules.js";
import { WorkItemActionError } from "./common.js";

const SD_CONFIRM_GATE = "sd-confirm";

/** 專案開了 multiModule 且已有模組地圖才回傳解析結果；否則 null（不檢查）。 */
async function loadMap(projectDir: string | null | undefined) {
  if (!projectDir || !(await isMultiModuleProject(projectDir))) return null;
  const doc = await readProjectDoc(projectDir, MODULE_MAP_FILE);
  return doc.exists ? Object.assign(parseModuleMap(doc.content), { glossary: parseGlossary(doc.content) }) : null;
}

async function tableNames(dir: string): Promise<string[]> {
  const files = await readdir(path.join(dir, "TableSchema")).catch(() => [] as string[]);
  return files.filter((f) => f.endsWith(".md") && f !== "system-er.md").map((f) => f.slice(0, -3));
}

/** SD 交件：宣告的模組要在模組地圖、動到的資料表要屬於宣告的模組。沒開 multiModule、沒有地圖、沒宣告模組都略過。 */
export async function sdModuleMapProblems(dir: string, projectDir: string | null | undefined, modules: readonly string[] | undefined): Promise<string[]> {
  if (!modules || modules.length === 0) return [];
  const map = await loadMap(projectDir);
  if (!map) return [];
  const sd = await readFile(path.join(dir, "03-sd.md"), "utf-8").catch(() => "");
  return [...checkModulesDeclared(map, modules), ...checkTableOwnership(map, await tableNames(dir), modules, map.glossary), ...checkCrossModuleCalls(map, parseCrossModuleCalls(sd), modules)].map((v) => `模組地圖檢查未通過：${v}`);
}

/** 進入實作的把關：SD 確認時，所屬模組依賴的系統模組還沒完成，AI 不能代確認；使用者本人確認視為臨時放行（原話記在關卡紀錄）。 */
export async function requireDependenciesReady(status: { project_dir?: string | null; modules?: string[] }, gateId: string, by: string, decision: string): Promise<void> {
  if (gateId !== SD_CONFIRM_GATE || by !== "agent" || decision !== "confirmed" || !status.modules || status.modules.length === 0) return;
  const map = await loadMap(status.project_dir);
  if (!map) return;
  const blocked = blockedByUnfinishedSystemModules(map, status.modules);
  if (blocked.length > 0) throw new WorkItemActionError(`關卡「${gateId}」：${blocked.join("；")}。先完成依賴的系統模組；真的要先做，請使用者本人確認（by="human"，reason 附使用者原話與放行理由）。`);
}
