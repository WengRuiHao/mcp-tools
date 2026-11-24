import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { describeRootCauses } from "../workflow/builtin/spec-first.js";
import type { WorkflowDefinition } from "../workflow/schema.js";
import { checkDeliverablePointers } from "../workflow/deliverable-pointer-check.js";
import { checkFeSelfCheck } from "../workflow/fe-self-check.js";
import { SA_INTERNAL_TERMS, SD_INTERNAL_TERMS } from "../workflow/internal-files.js";
import { checkMermaidFile } from "../workflow/mermaid-check.js";
import { checkMockupDir } from "../workflow/mockup-check.js";
import { checkImpactReuseList, checkReuseRecord } from "../workflow/reuse-record-check.js";
import { checkSaImages, SA_FILE_NAME, validateImageRef } from "../workflow/sa-image-check.js";
import { checkSaNoCode } from "../workflow/sa-no-code-check.js";
import { checkSaStandard } from "../workflow/sa-standard-check.js";
import { checkSdLayers } from "../workflow/sd-layer-check.js";
import { checkSdRollout } from "../workflow/sd-rollout-check.js";
import { checkSaRequirementIds, checkSdTraceability, parseSaRequirementIds } from "../workflow/traceability-check.js";
import { checkSdStructure, hasTableSchemas } from "../workflow/sd-structure-check.js";
import { checkTableSchemas } from "../workflow/table-schema-check.js";
import { checkBaselineTechStack, checkTechStack, TECH_STACK_FILE, BASELINE_FILE } from "../workflow/tech-stack-check.js";
import { checkTestEvidence, EVIDENCE_DIR, TEST_FILE_NAME } from "../workflow/test-evidence-check.js";
import { sdModuleMapProblems } from "./module-map-checks.js";
import { checkDrillEvidenceText } from "../workflow/drill-evidence-check.js";

/** done 的交件檢查：回傳問題清單（空陣列＝合格）。檔名全部來自流程定義，不接受使用者輸入。 */

const afterIds = (after: string | string[]): string[] => (Array.isArray(after) ? after : [after]);

async function sizeOf(file: string): Promise<number | null> {
  try {
    const s = await stat(file);
    return s.isFile() ? s.size : null;
  } catch {
    return null;
  }
}

async function dirHasFile(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir, { withFileTypes: true })).some((e) => e.isFile());
  } catch {
    return false;
  }
}

export interface VerdictFile {
  verdict: "PASS" | "FAIL" | null;
  rootCause: string | null;
}

/** 第一行必須是 PASS 或 FAIL（容許 BOM 與前後空白）；rootCause 取 `rootCause: xx` 行。 */
export function parseVerdictFile(text: string): VerdictFile {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const first = (lines[0] ?? "").trim().toUpperCase();
  const verdict = first === "PASS" || first === "FAIL" ? first : null;
  const m = /^\s*(?:[-*]\s*)?rootCause\s*[:：=]\s*([A-Za-z0-9_-]+)/im.exec(lines.slice(1).join("\n"));
  return { verdict, rootCause: m ? m[1] : null };
}

async function checkVerdictFile(file: string, routeOnFail: Record<string, string>): Promise<string[]> {
  const parsed = parseVerdictFile(await readFile(file, "utf-8"));
  const name = path.basename(file);
  if (!parsed.verdict) return [`${name} 第一行必須是 PASS 或 FAIL`];
  if (parsed.verdict === "PASS") return [];
  const keys = Object.keys(routeOnFail);
  if (!parsed.rootCause) return [`${name} 判定 FAIL，必須帶 rootCause 行（例如「rootCause: ${keys[0]}」），可用值：${describeRootCauses(keys)}`];
  if (!Object.prototype.hasOwnProperty.call(routeOnFail, parsed.rootCause)) return [`${name} 的 rootCause「${parsed.rootCause}」不合法，可用值：${describeRootCauses(keys)}`];
  return [];
}

async function checkSa(dir: string, legacy: boolean, highRisk: boolean): Promise<string[]> {
  if ((await sizeOf(path.join(dir, SA_FILE_NAME))) === null) return [`缺少 ${SA_FILE_NAME}，無法檢查 SA 截圖`];
  const problems: string[] = [];
  try {
    const r = checkSaImages(dir);
    if (!r.ok) problems.push(...r.violations.map((v) => `SA 截圖檢查未通過：${v.heading ? `「${v.heading}」` : ""}${v.line ? `（第 ${v.line} 行）` : ""}${v.reason}`));
  } catch (e) {
    problems.push(`SA 截圖檢查失敗：${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    const n = checkSaNoCode(dir, { legacy });
    if (!n.ok) problems.push(...n.violations.map((v) => `SA 不寫程式檢查未通過：${v.line ? `（第 ${v.line} 行）` : ""}${v.reason}${v.snippet ? `：${v.snippet}` : ""}`));
  } catch (e) {
    problems.push(`SA 不寫程式檢查失敗：${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    const saText = await readFile(path.join(dir, SA_FILE_NAME), "utf-8");
    problems.push(...checkSaStandard(saText).map((v) => `SA 標準檢查未通過：${v}`));
    if (highRisk) problems.push(...checkSaRequirementIds(saText).map((v) => `SA 需求編號檢查未通過：${v}`));
  } catch (e) {
    problems.push(`SA 標準檢查失敗：${e instanceof Error ? e.message : String(e)}`);
  }
  return problems;
}

async function checkTest(dir: string, highRisk: boolean): Promise<string[]> {
  if ((await sizeOf(path.join(dir, TEST_FILE_NAME))) === null) return [`缺少 ${TEST_FILE_NAME}，無法檢查測試證據`];
  try {
    const problems = checkTestEvidence(dir).violations.map((v) => `測試證據檢查未通過：${v}`);
    if (highRisk) {
      const text = await readFile(path.join(dir, TEST_FILE_NAME), "utf-8");
      const root = path.resolve(dir, EVIDENCE_DIR);
      problems.push(...checkDrillEvidenceText(text, { validateImage: (ref) => validateImageRef(ref, root, EVIDENCE_DIR) }).map((v) => `回滾演練證據檢查未通過：${v}`));
    }
    return problems;
  } catch (e) {
    return [`測試證據檢查失敗：${e instanceof Error ? e.message : String(e)}`];
  }
}

/** 角色交件時要檢查內容的產出檔（artifact id）與對應的重用防線檢查（C1、C2）。 */
const REUSE_CHECKS: Readonly<Record<string, { artifact: string; check: (text: string, fileName: string) => string[] }>> = {
  "baseline-survey": { artifact: "impact", check: checkImpactReuseList },
  "frontend-engineer": { artifact: "impl-fe", check: (text, fileName) => [...checkReuseRecord(text, fileName), ...checkFeSelfCheck(text, fileName)] },
  "backend-engineer": { artifact: "impl-be", check: checkReuseRecord },
};

async function checkReuse(dir: string, roleId: string, def: WorkflowDefinition): Promise<string[]> {
  const rule = REUSE_CHECKS[roleId];
  const file = rule && def.artifacts.find((a) => a.id === rule.artifact)?.file;
  if (!rule || !file) return [];
  try {
    return rule.check(await readFile(path.join(dir, file), "utf-8"), file);
  } catch {
    return []; // 檔案缺漏已由一般交件檢查回報
  }
}

/** SD 新標準檢查（含 TableSchema 連結的檔案存在檢查）。 */
async function checkSd(dir: string, def: WorkflowDefinition, projectDir: string | null | undefined, legacy: boolean, highRisk: boolean): Promise<string[]> {
  const file = def.artifacts.find((a) => a.id === "sd")?.file;
  if (!file) return [];
  try {
    const text = await readFile(path.join(dir, file), "utf-8");
    const rollout = highRisk ? checkSdRollout(text, { needsDbRollback: hasTableSchemas(dir) }).map((v) => `SD 上線與回滾檢查未通過：${v}`) : [];
    // 追溯矩陣：SA 沒有需求編號時略過（由 SA 檢查回報）
    const saText = highRisk ? await readOptional(path.join(dir, SA_FILE_NAME)) : undefined;
    const trace = saText === undefined ? [] : checkSdTraceability(text, parseSaRequirementIds(saText).ids).map((v) => `SD 追溯檢查未通過：${v}`);
    return [...checkSdStructure(text, dir, projectDir, { legacy }).map((v) => `SD 標準檢查未通過：${v}`), ...rollout, ...trace];
  } catch {
    return []; // 檔案缺漏已由一般交件檢查回報
  }
}

/** 後端工程師交件：impl-be.md 的 API 落地清單與 SD 三層宣告比對，有專案目錄再檢查實際檔案。 */
async function checkLayers(dir: string, def: WorkflowDefinition, projectDir: string | null | undefined): Promise<string[]> {
  const sdFile = def.artifacts.find((a) => a.id === "sd")?.file;
  const implFile = def.artifacts.find((a) => a.id === "impl-be")?.file;
  if (!sdFile || !implFile) return [];
  try {
    const [sd, impl] = [await readFile(path.join(dir, sdFile), "utf-8"), await readFile(path.join(dir, implFile), "utf-8")];
    return checkSdLayers(sd, impl, projectDir ?? null).map((v) => `SD 分層落地檢查未通過：${v}`);
  } catch {
    return []; // 檔案缺漏已由一般交件檢查回報
  }
}

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf-8");
  } catch {
    return undefined;
  }
}

/** 現況盤點：baseline.md 必須有「## 現有技術棧」；技術選型：tech-stack.md 的結構與內容檢查（缺檔由一般交件檢查回報）。 */
async function checkTech(dir: string, roleId: string, techSource: string | undefined, highRisk: boolean): Promise<string[]> {
  if (roleId === "baseline-survey") {
    const text = await readOptional(path.join(dir, BASELINE_FILE));
    return text === undefined ? [] : checkBaselineTechStack(text, BASELINE_FILE);
  }
  const text = await readOptional(path.join(dir, TECH_STACK_FILE));
  return text === undefined ? [] : checkTechStack(text, { techSource, highRisk, baselineText: await readOptional(path.join(dir, BASELINE_FILE)) });
}

/** 正式交付物引用檢查（內部檔名、圖片來源）。SA／SD 交件時只看自己的文件，並略過標準檢查已回報的內部檔名；測試工程師交件（最終驗收前）檢查全部正式交付物。 */
const POINTER_SCOPE: Readonly<Record<string, { only?: string[]; suppress?: Record<string, readonly string[]> }>> = {
  "sa-analyst": { only: ["sa"], suppress: { "01-sa.md": [...SA_INTERNAL_TERMS, "sa-mockup"] } },
  "db-designer": { only: ["table-schema"] },
  "sd-analyst": { only: ["sd"], suppress: { "03-sd.md": SD_INTERNAL_TERMS } },
  tester: {},
};

function checkPointers(dir: string, roleId: string, def: WorkflowDefinition, legacy: boolean): string[] {
  const scope = POINTER_SCOPE[roleId];
  if (!scope) return [];
  try {
    return checkDeliverablePointers(dir, def, { ...scope, allowMermaid: legacy }).map((v) => `交付物引用檢查未通過：${v}`);
  } catch (e) {
    return [`交付物引用檢查失敗：${e instanceof Error ? e.message : String(e)}`];
  }
}

export interface DeliverableContext {
  techSource?: string | undefined;
  /** 高併發／高風險需求（技術選型不再要求資料庫列）。 */
  highRisk?: boolean | undefined;
  /** 工作項目宣告動到的模組（multiModule 專案）；SD 交件時與模組地圖核對。 */
  modules?: readonly string[] | undefined;
  /** 工作項目的專案目錄；沒有時分層檢查只比對 impl 說明與 SD。 */
  projectDir?: string | null | undefined;
  /** 既有系統才需要既有資料表。 */
  baseline?: string | undefined;
  /** 全新待選風格已確認選定的風格檔名（mockup-confirm 目前是核准狀態才有值）。 */
  selectedStyle?: string | undefined;
  /** 舊版面工作項目（快照含 flow-analyst）：ER 圖 Mermaid 內嵌文件、SD 沒有流程圖章節、SA 可含 mermaid，新舊格式都收。 */
  legacy?: boolean | undefined;
}

export async function checkDeliverables(dir: string, roleId: string, def: WorkflowDefinition, ctx: DeliverableContext = {}): Promise<string[]> {
  const role = def.roles.find((r) => r.id === roleId);
  if (!role) return [`找不到角色：${roleId}`];
  const problems: string[] = [];
  const verdictGate = def.gates.find((g) => g.routeOnFail && afterIds(g.after).includes(roleId));
  for (const out of role.outputs) {
    const art = def.artifacts.find((a) => a.id === out);
    if (!art) continue;
    if (art.file.endsWith("/")) {
      if (!(await dirHasFile(path.join(dir, art.file)))) problems.push(`${art.file} 內沒有任何檔案`);
    } else {
      const size = await sizeOf(path.join(dir, art.file));
      if (size === null) problems.push(`缺少產出檔案 ${art.file}`);
      else if (size === 0) problems.push(`產出檔案 ${art.file} 是空的`);
      else if (verdictGate?.routeOnFail) problems.push(...(await checkVerdictFile(path.join(dir, art.file), verdictGate.routeOnFail)));
    }
    if (art.render && !((await sizeOf(path.join(dir, art.render))) ?? 0)) problems.push(`缺少圖片 ${art.render}（必須存在且非空；用 attach 或 render 產生）`);
  }
  if (roleId === "sa-analyst") problems.push(...(await checkSa(dir, ctx.legacy === true, ctx.highRisk === true)));
  if (roleId === "db-designer") problems.push(...checkTableSchemas(dir, { baseline: ctx.baseline, projectDir: ctx.projectDir, legacy: ctx.legacy }).map((v) => `資料表結構文件檢查未通過：${v}`));
  if (roleId === "mockup-designer") problems.push(...checkMockupDir(dir, { selectedStyle: ctx.selectedStyle }).map((v) => `mockup 檢查未通過：${v}`));
  if (roleId === "sd-analyst") problems.push(...checkMermaidFile(dir).map((v) => `流程圖（flow.mmd）格式檢查未通過：${v}`));
  if (roleId === "tester") problems.push(...(await checkTest(dir, ctx.highRisk === true)));
  if (roleId === "sd-analyst") problems.push(...(await checkSd(dir, def, ctx.projectDir, ctx.legacy === true, ctx.highRisk === true)));
  if (roleId === "sd-analyst") problems.push(...(await sdModuleMapProblems(dir, ctx.projectDir, ctx.modules).catch((e) => [`模組地圖檢查失敗：${e instanceof Error ? e.message : String(e)}`])));
  if (roleId === "backend-engineer") problems.push(...(await checkLayers(dir, def, ctx.projectDir)));
  problems.push(...checkPointers(dir, roleId, def, ctx.legacy === true));
  problems.push(...(await checkReuse(dir, roleId, def)));
  if (roleId === "baseline-survey" || roleId === "tech-selector") problems.push(...(await checkTech(dir, roleId, ctx.techSource, ctx.highRisk === true)));
  return problems;
}
