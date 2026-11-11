import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TicketStatus } from "../pipeline-store.js";
import { buildWhenContext } from "../work-item-store.js";
import { deliverablePaths, internalPaths } from "../workflow/deliverable-files.js";
import { FINAL_SUMMARY_FILE, artifactPaths, buildFinalSummary, buildFinalSummaryBrief, type FileFact, type FinalSummaryInput } from "../workflow/final-summary.js";
import { resolveWorkflow } from "../workflow/resolve.js";
import type { WorkflowDefinition } from "../workflow/schema.js";
import { isGatePassed } from "../workflow/work-item-progress.js";

export const FINAL_ACCEPTANCE_GATE = "final-acceptance";

async function measureDir(dir: string): Promise<{ size: number; fileCount: number }> {
  const entries = await readdir(dir, { withFileTypes: true });
  const parts = await Promise.all(
    entries.map(async (e) => (e.isDirectory() ? measureDir(path.join(dir, e.name)) : { size: (await stat(path.join(dir, e.name))).size, fileCount: 1 }))
  );
  return parts.reduce((a, b) => ({ size: a.size + b.size, fileCount: a.fileCount + b.fileCount }), { size: 0, fileCount: 0 });
}

async function measure(root: string, rel: string): Promise<FileFact> {
  const missing = { path: rel, exists: false, isDir: rel.endsWith("/"), size: 0, fileCount: 0 };
  try {
    const abs = path.join(root, rel);
    const st = await stat(abs);
    if (st.isDirectory()) return { path: rel, exists: true, isDir: true, ...(await measureDir(abs)) };
    return { path: rel, exists: true, isDir: false, size: st.size, fileCount: 1 };
  } catch {
    return missing;
  }
}

const readOptional = (file: string): Promise<string | undefined> => readFile(file, "utf-8").catch(() => undefined);

async function collectInput(dir: string, status: TicketStatus, def: WorkflowDefinition, id: string): Promise<FinalSummaryInput> {
  const resolved = resolveWorkflow(def, buildWhenContext(status));
  const activeOutputs = new Set(resolved.roles.flatMap((r) => r.outputs));
  const artifacts = def.artifacts.filter((a) => activeOutputs.has(a.id));
  const createdAt = await stat(path.join(dir, "item.md")).then((s) => s.mtime.toISOString(), () => undefined);
  const delivered = deliverablePaths(def);
  const internal = internalPaths(def);
  const files = await Promise.all([...new Set([...artifactPaths(artifacts), ...delivered, ...internal])].map((p) => measure(dir, p)));
  return {
    workItemId: id,
    title: status.name,
    requirement: await readOptional(path.join(dir, "item.md")),
    baseline: status.baseline,
    scope: status.scope,
    hasDb: status.has_db,
    styleSource: status.style_source,
    techSource: status.tech_source,
    createdAt,
    gates: resolved.gates,
    artifacts,
    progress: status.work_item_progress,
    consecutiveFailCount: Number.isFinite(status.consecutive_fail_count) ? status.consecutive_fail_count : 0,
    files,
    dupReport: await readOptional(path.join(dir, "dup-report.md")),
    deliverablePaths: delivered,
    internalPaths: internal,
  };
}

/** 彙整報告並寫入工作項目目錄的 final-summary.md；回傳檔案絕對路徑與簡短摘要。寫檔失敗會丟錯，由呼叫端轉成 warning。 */
export async function writeFinalSummary(dir: string, status: TicketStatus, def: WorkflowDefinition, id: string): Promise<{ summaryFile: string; finalSummaryBrief: string }> {
  const input = await collectInput(dir, status, def, id);
  const summaryFile = path.join(dir, FINAL_SUMMARY_FILE);
  await writeFile(summaryFile, buildFinalSummary(input), "utf-8");
  return { summaryFile, finalSummaryBrief: buildFinalSummaryBrief(input) };
}

/** 已通過最終驗收且報告檔存在時回傳路徑，否則 undefined（get 動作用）。 */
export async function existingSummaryFile(dir: string, status: TicketStatus): Promise<string | undefined> {
  if (!isGatePassed(status.work_item_progress, FINAL_ACCEPTANCE_GATE)) return undefined;
  const file = path.join(dir, FINAL_SUMMARY_FILE);
  return stat(file).then(() => file, () => undefined);
}
