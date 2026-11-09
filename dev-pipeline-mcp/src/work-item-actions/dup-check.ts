import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DupPathError, detectDuplicates, formatDupReport, getChangedFiles, type DupBlock } from "../dup-detect/index.js";
import { loadProjectFlowOverride } from "../workflow/load.js";
import { parseDupInput } from "../workflow/dup-input.js";
import type { WorkflowDefinition } from "../workflow/schema.js";
import { errorMessage } from "./common.js";

/** S12a：前後端工程師交件時的自動重複偵測。檔名來自流程定義；專案目錄來自工作項目狀態。 */
export const DUP_REPORT_FILE = "dup-report.md";
const ENGINEER_ARTIFACTS: Readonly<Record<string, string>> = { "frontend-engineer": "impl-fe", "backend-engineer": "impl-be" };
const SECTION_MARK = /^<!-- dup-role:([\w-]+) -->$/;
const MAX_SHOWN_BLOCKS = 3;

/** 各角色最近一次的報告彙整成一份檔案：以標記行分段，同角色覆寫、其他角色保留。 */
async function writeDupReport(dir: string, roleId: string, implFile: string, body: string): Promise<void> {
  const target = path.join(dir, DUP_REPORT_FILE);
  const sections = new Map<string, string>();
  try {
    let current: string | null = null;
    for (const line of (await readFile(target, "utf-8")).split(/\r?\n/)) {
      const m = SECTION_MARK.exec(line);
      if (m) { current = m[1]; sections.set(current, ""); } else if (current) sections.set(current, `${sections.get(current)}${line}\n`);
    }
  } catch { /* 第一次交件沒有舊檔 */ }
  const demoted = body.replace(/^(#+) /gm, "##$1 ");
  sections.set(roleId, `## 角色：${roleId}（${implFile}），${new Date().toISOString()}\n\n${demoted}\n`);
  const parts = [...sections].map(([id, text]) => `<!-- dup-role:${id} -->\n${text}`);
  await writeFile(target, `# 重複偵測報告（交給驗證師審查，被豁免的區塊要逐筆確認理由合理）\n\n${parts.join("\n")}`, "utf-8");
}

const where = (b: DupBlock): string => `${b.file} 第 ${b.startLine}～${b.endLine} 行 ⇄ ${b.otherFile} 第 ${b.otherStartLine}～${b.otherEndLine} 行（連續 ${b.matchedLines} 行）`;

function escapedPaths(projectDir: string, files: string[]): string[] {
  const base = path.resolve(projectDir);
  return files.filter((f) => {
    const rel = path.relative(base, path.resolve(base, f));
    return path.isAbsolute(f) || /^[A-Za-z]:/.test(f) || rel.startsWith("..") || path.isAbsolute(rel);
  });
}

/** 回傳問題清單（空陣列＝通過）。實作說明缺漏等一般問題由 checkDeliverables 先回報，這裡只處理重複偵測。 */
export async function checkDuplicatesOnDone(dir: string, projectDir: string | null, roleId: string, def: WorkflowDefinition): Promise<string[]> {
  const implFile = def.artifacts.find((a) => a.id === ENGINEER_ARTIFACTS[roleId])?.file;
  if (!implFile) return [];
  if (!projectDir) return ["工作項目沒有專案目錄，無法執行自動重複偵測"];
  const input = parseDupInput(await readFile(path.join(dir, implFile), "utf-8"));
  const escaped = escapedPaths(projectDir, input.changedFiles);
  if (escaped.length > 0) return [`${implFile}「## 改動檔案」有路徑超出專案目錄：${escaped.join("、")}（只能列相對於專案目錄的路徑）`];
  try {
    const vcs = (await getChangedFiles(projectDir)) ?? [];
    const changedFiles = [...new Set([...vcs, ...input.changedFiles])];
    if (changedFiles.length === 0) return [`取不到這次改動的檔案（專案不是版本控制工作副本，${implFile} 也沒有列出）：請在 ${implFile} 補上「## 改動檔案」，條列相對於專案目錄的路徑，一行一個（可用「- 」開頭）`];
    const dup = (await loadProjectFlowOverride(projectDir))?.dup;
    const report = await detectDuplicates({ projectDir, changedFiles, waivers: input.waivers, ...(dup ? { options: dup } : {}) });
    await writeDupReport(dir, roleId, implFile, formatDupReport(report));
    const problems: string[] = [];
    if (report.blocking) {
      const shown = report.duplicates.slice(0, MAX_SHOWN_BLOCKS).map(where).join("；");
      problems.push(`自動重複偵測擋下交件：有 ${report.duplicates.length} 處未豁免的大段重複，例如 ${shown}。請改用專案既有或抽出的共用方法，或在 ${implFile} 的「## 重複豁免」表格（檔案｜相似檔案（可空）｜理由）寫明理由；完整清單見 ${DUP_REPORT_FILE}`);
    }
    if (report.invalidWaivers.length > 0) problems.push(`${implFile}「## 重複豁免」有無效的豁免（理由至少 4 個字元、檔案不可空白）：${report.invalidWaivers.map((w) => `「${w.file}」`).join("、")}`);
    return problems;
  } catch (e) {
    return [e instanceof DupPathError ? `自動重複偵測的路徑不合法：${e.message}` : `自動重複偵測失敗：${errorMessage(e)}`];
  }
}
