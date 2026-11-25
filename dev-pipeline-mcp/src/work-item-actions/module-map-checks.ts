import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { MODULE_MAP_FILE, blockedByUnfinishedSystemModules, checkCalledContracts, parseContractExamples, checkModulesDeclared, checkCrossModuleCalls, checkScenarioTests, checkSdScenarios, checkTableOwnership, parseCrossModuleCalls, parseGlossary, parseModuleMap, parseScenarios, parseSdScenarioNames } from "../module-map.js";
import { readProjectDoc } from "../project-docs-store.js";
import { isMultiModuleProject, unfinishedDependencies } from "../work-item-modules.js";
import { WorkItemActionError } from "./common.js";

const SD_CONFIRM_GATE = "sd-confirm";

/** 專案開了 multiModule 且已有模組地圖才回傳解析結果；否則 null（不檢查）。 */
async function loadMap(projectDir: string | null | undefined) {
  if (!projectDir || !(await isMultiModuleProject(projectDir))) return null;
  const doc = await readProjectDoc(projectDir, MODULE_MAP_FILE);
  return doc.exists ? Object.assign(parseModuleMap(doc.content), { glossary: parseGlossary(doc.content), scenarios: parseScenarios(doc.content), examples: parseContractExamples(doc.content) }) : null;
}

async function tableNames(dir: string): Promise<string[]> {
  const files = await readdir(path.join(dir, "TableSchema")).catch(() => [] as string[]);
  return files.filter((f) => f.endsWith(".md") && f !== "system-er.md").map((f) => f.slice(0, -3));
}

/** SD 交件：宣告的模組要在模組地圖、動到的資料表要屬於宣告的模組。沒開 multiModule、沒有地圖、沒宣告模組都略過。 */
export async function sdModuleMapProblems(dir: string, projectDir: string | null | undefined, modules: readonly string[] | undefined, highRisk = false): Promise<string[]> {
  if (!modules || modules.length === 0) return [];
  const map = await loadMap(projectDir);
  if (!map) return [];
  const sd = await readFile(path.join(dir, "03-sd.md"), "utf-8").catch(() => "");
  const calls = parseCrossModuleCalls(sd);
  const contracts = highRisk ? checkCalledContracts(calls, map.examples, modules) : [];
  return [...contracts, ...checkModulesDeclared(map, modules),...checkTableOwnership(map, await tableNames(dir), modules, map.glossary), ...checkCrossModuleCalls(map, parseCrossModuleCalls(sd), modules), ...checkSdScenarios(map.scenarios, parseSdScenarioNames(sd))].map((v) => `模組地圖檢查未通過：${v}`);
}

/** 測試交件：SD 宣告所屬的跨模組情境，每個都要有端到端整合測試並掛需求編號。條件同 sdModuleMapProblems，SD 沒寫情境節就不檢查。 */
export async function scenarioTestProblems(dir: string, projectDir: string | null | undefined, modules: readonly string[] | undefined): Promise<string[]> {
  if (!modules || modules.length === 0) return [];
  const map = await loadMap(projectDir);
  if (!map) return [];
  const names = parseSdScenarioNames(await readFile(path.join(dir, "03-sd.md"), "utf-8").catch(() => ""));
  if (names.length === 0) return [];
  const test = await readFile(path.join(dir, "test.md"), "utf-8").catch(() => "");
  return checkScenarioTests(names, test).map((v) => `情境測試檢查未通過：${v}`);
}

/** 進入實作的把關：SD 確認時，依賴的工作項目或所屬模組依賴的系統模組還沒完成，AI 不能代確認；使用者本人確認視為臨時放行（原話記在關卡紀錄）。 */
export async function requireDependenciesReady(status: { project_dir?: string | null; modules?: string[]; depends_on?: string[] }, gateId: string, by: string, decision: string): Promise<void> {
  if (gateId !== SD_CONFIRM_GATE || by !== "agent" || decision !== "confirmed") return;
  const problems: string[] = [];
  if (status.depends_on?.length && status.project_dir && (await isMultiModuleProject(status.project_dir).catch(() => false))) {
    for (const d of await unfinishedDependencies(status)) problems.push(`依賴的工作項目 ${d.workItemId}${d.title ? `（${d.title}）` : ""}未完成（還沒通過最終驗收），不能進入實作`);
  }
  if (status.modules && status.modules.length > 0) {
    const map = await loadMap(status.project_dir);
    if (map) problems.push(...blockedByUnfinishedSystemModules(map, status.modules));
  }
  if (problems.length > 0) throw new WorkItemActionError(`關卡「${gateId}」：${problems.join("；")}。先完成依賴；真的要先做，請使用者本人確認（by="human"，reason 附使用者原話與放行理由）。`);
}
