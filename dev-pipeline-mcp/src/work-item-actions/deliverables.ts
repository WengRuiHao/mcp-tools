import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { WorkflowDefinition } from "../workflow/schema.js";
import { checkMermaidFile } from "../workflow/mermaid-check.js";
import { checkImpactReuseList, checkReuseRecord, checkSdReuseDesign } from "../workflow/reuse-record-check.js";
import { checkSaImages, SA_FILE_NAME } from "../workflow/sa-image-check.js";
import { checkTestEvidence, TEST_FILE_NAME } from "../workflow/test-evidence-check.js";

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
  if (!parsed.rootCause) return [`${name} 判定 FAIL，必須帶 rootCause 行（例如「rootCause: ${keys[0]}」），可用值：${keys.join("、")}`];
  if (!Object.prototype.hasOwnProperty.call(routeOnFail, parsed.rootCause)) return [`${name} 的 rootCause「${parsed.rootCause}」不合法，可用值：${keys.join("、")}`];
  return [];
}

async function checkSa(dir: string): Promise<string[]> {
  if ((await sizeOf(path.join(dir, SA_FILE_NAME))) === null) return [`缺少 ${SA_FILE_NAME}，無法檢查 SA 截圖`];
  try {
    const r = checkSaImages(dir);
    return r.ok ? [] : r.violations.map((v) => `SA 截圖檢查未通過：${v.heading ? `「${v.heading}」` : ""}${v.line ? `（第 ${v.line} 行）` : ""}${v.reason}`);
  } catch (e) {
    return [`SA 截圖檢查失敗：${e instanceof Error ? e.message : String(e)}`];
  }
}

async function checkTest(dir: string): Promise<string[]> {
  if ((await sizeOf(path.join(dir, TEST_FILE_NAME))) === null) return [`缺少 ${TEST_FILE_NAME}，無法檢查測試證據`];
  try {
    return checkTestEvidence(dir).violations.map((v) => `測試證據檢查未通過：${v}`);
  } catch (e) {
    return [`測試證據檢查失敗：${e instanceof Error ? e.message : String(e)}`];
  }
}

/** 角色交件時要檢查內容的產出檔（artifact id）與對應的重用防線檢查（C1～C3）。 */
const REUSE_CHECKS: Readonly<Record<string, { artifact: string; check: (text: string, fileName: string) => string[] }>> = {
  "baseline-survey": { artifact: "impact", check: checkImpactReuseList },
  "sd-analyst": { artifact: "sd", check: checkSdReuseDesign },
  "frontend-engineer": { artifact: "impl-fe", check: checkReuseRecord },
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

export async function checkDeliverables(dir: string, roleId: string, def: WorkflowDefinition): Promise<string[]> {
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
  if (roleId === "sa-analyst") problems.push(...(await checkSa(dir)));
  if (roleId === "flow-analyst") problems.push(...checkMermaidFile(dir).map((v) => `流程圖（flow.mmd）格式檢查未通過：${v}`));
  if (roleId === "tester") problems.push(...(await checkTest(dir)));
  problems.push(...(await checkReuse(dir, roleId, def)));
  return problems;
}
