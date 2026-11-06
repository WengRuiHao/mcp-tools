import { GATES_FILE_CANDIDATES, readFirstExisting } from "../project-rule-files.js";
import { resolveLegacyTestProfile, resolveProjectDir, resolveSasdConfig, resolveTestCapability } from "../project-registry.js";
import { fromLegacy, type LegacyGatesConfig } from "./legacy-adapter.js";
import { loadProjectFlowOverride } from "./load.js";
import { mergeProjectOverride, resolveWorkflow } from "./resolve.js";
import { validateWorkflow } from "./validate.js";

async function readLegacyGates(projectDir: string): Promise<LegacyGatesConfig | null> {
  const found = await readFirstExisting(projectDir, GATES_FILE_CANDIDATES);
  if (!found) return null;
  try {
    return JSON.parse(found.content) as LegacyGatesConfig;
  } catch {
    throw new Error(`${found.relPath} 不是合法的 JSON，請修正後再呼叫`);
  }
}

/** project_config kind:"flow" 的唯讀解析：現有設定 → 內建 workflow → 套專案 flow.json → 依模式展開。 */
export async function resolveProjectFlow(projectGid: string): Promise<Record<string, unknown>> {
  const projectDir = (await resolveProjectDir(projectGid)) ?? null;
  const gates = projectDir ? await readLegacyGates(projectDir) : null;
  const legacy = fromLegacy(
    (await resolveSasdConfig(projectGid)) ?? null,
    (await resolveTestCapability(projectGid)) ?? null,
    await resolveLegacyTestProfile(projectGid),
    gates
  );
  const override = projectDir ? await loadProjectFlowOverride(projectDir) : null;
  let workflow = legacy.workflow;
  if (override) {
    const merged = mergeProjectOverride(workflow, override);
    if (!merged.ok) return { success: false, message: `flow.json 覆寫被拒絕：${merged.errors.join("；")}` };
    workflow = merged.workflow;
  }
  const errors = validateWorkflow(workflow);
  if (errors.length > 0) return { success: false, message: `workflow 定義不合法：${errors.join("；")}` };
  const resolved = resolveWorkflow(workflow, legacy.context);
  return {
    found: true,
    readOnly: true,
    workflowId: workflow.id,
    projectDir,
    overrideApplied: override !== null,
    context: legacy.context,
    warnings: legacy.warnings,
    hardStops: workflow.hardStops,
    roles: resolved.roles.map((r) => ({ id: r.id, dependsOn: r.dependsOn, ...(r.roleNotes ? { roleNotes: r.roleNotes } : {}) })),
    gates: resolved.gates.map((g) => ({ id: g.id, type: g.type, locked: g.locked ?? false, confirm: g.effectiveConfirm.mode, ...(g.checks ? { checks: g.checks } : {}) })),
  };
}
