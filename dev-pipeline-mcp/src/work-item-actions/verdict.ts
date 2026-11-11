import { readFile } from "node:fs/promises";
import path from "node:path";
import { updateStatus } from "../pipeline-store.js";
import { applyGateDecision, applyVerdictFail } from "../workflow/spec-first-engine.js";
import type { WorkflowDefinition } from "../workflow/schema.js";
import { WorkItemActionError, need, okReply, type ToolReply } from "./common.js";
import { doneRoleIds } from "./confirm.js";
import { loadEffectiveDef, loadWorkItem } from "./context.js";
import { parseVerdictFile } from "./deliverables.js";
import { authorizeDecision, requireHumanQuote, withReviewNote } from "./gate-guard.js";
import type { WorkItemArgs } from "./schema.js";
import { nextBlock, viewFor } from "./view.js";

const VERDICT_GATES = ["spec-check-verdict", "verdict"];

/** agent 代判時，結果必須與該角色交出的報告（spec-check.md／verify.md）一致，避免自己推翻報告。 */
async function assertMatchesReport(dir: string, def: WorkflowDefinition, gateId: string, result: "pass" | "fail", rootCause?: string): Promise<void> {
  const gate = def.gates.find((g) => g.id === gateId);
  const roleId = Array.isArray(gate?.after) ? gate?.after[0] : gate?.after;
  const art = def.artifacts.find((x) => x.id === def.roles.find((r) => r.id === roleId)?.outputs[0]);
  if (!art) throw new WorkItemActionError(`關卡「${gateId}」找不到對應的報告檔。`);
  let text: string;
  try {
    text = await readFile(path.join(dir, art.file), "utf-8");
  } catch {
    throw new WorkItemActionError(`找不到報告 ${art.file}，無法核對判定結果。`);
  }
  const rep = parseVerdictFile(text);
  if (rep.verdict !== result.toUpperCase()) throw new WorkItemActionError(`判定結果（${result}）與 ${art.file} 第一行（${rep.verdict ?? "無"}）不一致，agent 不可推翻報告；請由使用者決定。`);
  if (result === "fail" && rep.rootCause !== rootCause) throw new WorkItemActionError(`rootCause（${rootCause}）與 ${art.file} 的 rootCause（${rep.rootCause ?? "無"}）不一致。`);
}

export async function handleVerdict(a: WorkItemArgs): Promise<ToolReply> {
  const { workItemId, gateId, result, by } = need("verdict", a, ["workItemId", "gateId", "result", "by"]);
  if (!VERDICT_GATES.includes(gateId)) throw new WorkItemActionError(`verdict 只接受關卡：${VERDICT_GATES.join("、")}`);
  if (result === "fail" && !a.rootCause?.trim()) throw new WorkItemActionError("result=fail 必須帶 rootCause（該關卡 routeOnFail 的 key）。");
  const ctx = await loadWorkItem(workItemId);
  const { def, overrideApplied } = await loadEffectiveDef(ctx.status);
  if (def.gates.find((g) => g.id === gateId)?.type !== "verdict") throw new WorkItemActionError(`關卡「${gateId}」不是判定關卡。`);
  requireHumanQuote(def, gateId, by, a.reason);
  const reason = withReviewNote(a.reason, by, a.review);
  let failInfo: Record<string, unknown> = {};
  let rewound: string[] = [];
  const updated = await updateStatus(ctx.id, async (s) => {
    await authorizeDecision({ dir: ctx.dir, status: s }, def, gateId, by, a.review, result === "fail");
    if (by === "agent") await assertMatchesReport(ctx.dir, def, gateId, result, a.rootCause?.trim());
    if (result === "pass") {
      const r = applyGateDecision(s, gateId, { decision: "passed", by, ...(reason !== undefined ? { reason } : {}) }, { def });
      if (!r.ok) throw new WorkItemActionError(r.error);
      return r.status;
    }
    const r = applyVerdictFail(s, gateId, (a.rootCause ?? "").trim(), { def, by });
    if (!r.ok) throw new WorkItemActionError(r.error);
    failInfo = { routedTo: r.routedTo, rewound: r.rewound, consecutiveFailCount: r.consecutiveFailCount, requireManual: r.requireManual, ...(r.hardStop ? { hardStop: r.hardStop } : {}) };
    rewound = doneRoleIds(s).filter((id) => !doneRoleIds(r.status).includes(id));
    return r.status;
  });
  const extra = result === "fail" ? { ...failInfo, rewoundRoles: rewound } : {};
  return okReply({ workItemId: ctx.id, gateId, result, by, ...extra, ...nextBlock(viewFor(updated, def, overrideApplied)) });
}
