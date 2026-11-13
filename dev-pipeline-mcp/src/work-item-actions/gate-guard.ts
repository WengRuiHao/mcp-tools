import { readFile } from "node:fs/promises";
import path from "node:path";
import { scanLineForSecrets } from "../sensitive-patterns.js";
import type { TicketStatus } from "../pipeline-store.js";
import { evaluateAgentConfirmation } from "../workflow/agent-confirm.js";
import { decideGate, type GateSignals } from "../workflow/enforce.js";
import type { WorkflowDefinition } from "../workflow/schema.js";
import { SPEC_FIRST_ID } from "./context.js";
import { WorkItemActionError } from "./common.js";

/**
 * 關卡決定的授權把關。by:"human" 直接放行（使用者本人說了算，MCP 無法驗證身分，靠工具說明約束 AI 不得冒用）。
 * by:"agent" 必須同時通過兩層（任何一層拒絕就丟錯、不寫入）：
 * 1) evaluateAgentConfirmation：locked（final-acceptance）永遠拒絕、未知關卡拒絕、非 auto 拒絕；
 * 2) decideGate 帶完整訊號：02-db.sql 全文（destructive-db）、關卡相關產出檔的敏感資訊掃描（sensitive-data）、連續 FAIL 次數、審查員申報。
 * 硬性停止只封鎖 AI 的「核准／通過」；AI 打回（confirm rejected、verdict fail）不受硬性停止與人工關卡限制，只有 locked（最終驗收）例外：核准與打回都只有人可以。
 */

const MAX_SCAN_BYTES = 512 * 1024;
const afterIds = (after: string | string[]): string[] => (Array.isArray(after) ? after : [after]);

async function readText(file: string): Promise<string | undefined> {
  try {
    const text = await readFile(file, "utf-8");
    return text.length > MAX_SCAN_BYTES ? text.slice(0, MAX_SCAN_BYTES) : text;
  } catch {
    return undefined;
  }
}

async function gateSignals(dir: string, def: WorkflowDefinition, gateId: string, status: TicketStatus, review: unknown): Promise<GateSignals> {
  const gate = def.gates.find((g) => g.id === gateId);
  const roleIds = new Set(gate ? afterIds(gate.after) : []);
  const files = def.roles
    .filter((r) => roleIds.has(r.id))
    .flatMap((r) => r.outputs)
    .flatMap((o) => def.artifacts.find((a) => a.id === o)?.file ?? [])
    .filter((f) => !f.endsWith("/") && /\.(md|sql|mmd)$/i.test(f));
  const texts = (await Promise.all(files.map((f) => readText(path.join(dir, f))))).filter((t): t is string => t !== undefined);
  const sensitiveDataHit = texts.some((t) => t.split(/\r?\n/).some((line) => scanLineForSecrets(line).length > 0));
  const sqlArtifactText = await readText(path.join(dir, "02-db.sql"));
  return {
    consecutiveFailCount: status.consecutive_fail_count,
    sensitiveDataHit,
    ...(sqlArtifactText !== undefined ? { sqlArtifactText } : {}),
    reviewerDeclaration: typeof review === "object" && review !== null ? (review as Record<string, unknown>) : undefined,
  };
}

export async function authorizeDecision(
  ctx: { dir: string; status: TicketStatus },
  def: WorkflowDefinition,
  gateId: string,
  by: "human" | "agent",
  review: unknown,
  rejecting = false
): Promise<void> {
  if (by === "human") return;
  if (rejecting) {
    if (def.gates.find((g) => g.id === gateId)?.locked) throw new WorkItemActionError(`關卡「${gateId}」是 locked（最終驗收類），核准與打回都只能由使用者本人決定，AI 不可代為打回。`, { reason: "locked" });
    return;
  }
  const ticket = { workflow_id: SPEC_FIRST_ID, project_dir: ctx.status.project_dir, consecutive_fail_count: ctx.status.consecutive_fail_count };
  const first = await evaluateAgentConfirmation(ticket, gateId, review, def);
  if (!first.ok) {
    const why = reviewReasonText(review);
    throw new WorkItemActionError(`${first.message}${why ? `審查員申報理由：${why}。` : ""}`, { reason: first.reason, hardStop: first.hardStop, ...(why ? { reviewReasons: why } : {}) });
  }
  const d = decideGate(def, gateId, ctx.status, await gateSignals(ctx.dir, def, gateId, ctx.status, review));
  if (d.mode !== "auto") {
    const why = reviewReasonText(review);
    throw new WorkItemActionError(`關卡「${gateId}」此次需人工確認，agent 不可代為決定（reason: ${d.reason}${d.hardStop ? `，hardStop: ${d.hardStop}` : ""}）。請由使用者本人確認。${why ? `審查員申報理由：${why}。` : ""}`, {
      ...(why ? { reviewReasons: why } : {}),
      reason: d.reason,
      ...(d.hardStop ? { hardStop: d.hardStop } : {}),
    });
  }
}

/** 人工確認附的使用者原話：去除空白後至少幾個字元。 */
export const MIN_HUMAN_QUOTE_CHARS = 2;

/** 明確同意的英文單字：雖然只有 1～3 個英數字，仍是確認原話而非選項代號（比對時不分大小寫）。 */
const AFFIRMATIVE_WORDS: ReadonlySet<string> = new Set(["ok", "yes", "y"]);
const OPTION_CODE_RE = /^[A-Za-z0-9]{1,3}$/;

/** reason（去頭尾空白後）只有 1～3 個 ASCII 英數字、且不是明確同意詞：視為使用者只回答了選項（A、AA、1），不算確認原話。中文原話不受影響。 */
export function isOptionCode(reason: string | undefined): boolean {
  const t = (reason ?? "").trim();
  return OPTION_CODE_RE.test(t) && !AFFIRMATIVE_WORDS.has(t.toLowerCase());
}

/** 要求原話的決定種類：confirmed／pass＝核准；rejected／fail＝打回或判定不通過。 */
export type QuoteKind = "confirmed" | "rejected" | "pass" | "fail";
const isApprove = (k: QuoteKind): boolean => k === "confirmed" || k === "pass";

/** 去除空白後的 reason 字數是否達到門檻。 */
const hasEnoughChars = (reason: string | undefined): boolean => (reason ?? "").replace(/\s/g, "").length >= MIN_HUMAN_QUOTE_CHARS;

/**
 * by:"human" 的 confirm（confirmed／rejected）與 verdict（pass／fail）一律要求 reason：必須是使用者原話，
 * 不可只是選項代號（1～3 個英數字）。核准與打回的錯誤訊息措辭不同。by:"agent" 不受此函式影響（見 requireAgentRejectReason）。
 */
export function requireHumanQuote(_def: WorkflowDefinition, gateId: string, by: "human" | "agent", reason: string | undefined, kind: QuoteKind = "confirmed"): void {
  if (by !== "human") return;
  const what = isApprove(kind) ? (kind === "pass" ? "判定通過" : "確認") : kind === "fail" ? "判定不通過" : "打回";
  if (isOptionCode(reason)) {
    throw new WorkItemActionError(`使用者${what}關卡「${gateId}」：reason「${(reason ?? "").trim()}」只是選項代號（1～3 個英數字），那是在回答問題、不是${what}這道關卡。請向使用者再問一次明確的${what === "打回" || what === "判定不通過" ? "打回理由（例如「要打回 " + gateId + " 嗎？原因是什麼？」）" : "確認（例如「是否確認 " + gateId + "？」）"}，並引用使用者完整原話當 reason。`);
  }
  if (hasEnoughChars(reason)) return;
  if (isApprove(kind)) {
    throw new WorkItemActionError(`使用者本人${what}關卡「${gateId}」必須附 reason：使用者這次${what}的原話（去除空白後至少 ${MIN_HUMAN_QUOTE_CHARS} 個字元），不可自行編寫。`);
  }
  throw new WorkItemActionError(`使用者本人${what}關卡「${gateId}」必須附 reason：使用者要求${what}的原話或理由（去除空白後至少 ${MIN_HUMAN_QUOTE_CHARS} 個字元），讓退回原因留下紀錄、供被退回的角色參考。`);
}

/** AI 打回確認關卡或判定不通過：reason 必填（去除空白後至少 MIN_HUMAN_QUOTE_CHARS 字元），記錄在流程紀錄（actor 為 agent）。 */
export function requireAgentRejectReason(gateId: string, by: "human" | "agent", decision: "confirmed" | "rejected", reason: string | undefined, via: "confirm" | "verdict" = "confirm"): void {
  if (by !== "agent" || decision !== "rejected" || hasEnoughChars(reason)) return;
  throw new WorkItemActionError(`AI ${via === "verdict" ? "判定不通過" : "打回"}關卡「${gateId}」必須附 reason（至少 ${MIN_HUMAN_QUOTE_CHARS} 個字元），說明退回的理由。`);
}

/** 審查申報理由：去除空白後至少幾個字元。 */
export const MIN_REVIEW_REASON_CHARS = 4;
export const REVIEW_KEYS = ["breaksExisting", "reviewerUncertain", "scopeSplit"] as const;

const asRecord = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});
const reasonOf = (review: unknown, key: string): string => {
  const v = asRecord(asRecord(review).reasons)[key];
  return typeof v === "string" ? v.trim() : "";
};

/** 審查申報為 true 的項目與其理由（理由沒給為空字串）。 */
export function declaredReasons(review: unknown): { key: string; reason: string }[] {
  const r = asRecord(review);
  return REVIEW_KEYS.filter((k) => r[k] === true).map((key) => ({ key, reason: reasonOf(review, key) }));
}

/** by:"agent" 核准時：申報為 true 的項目都要附理由（去空白後至少 MIN_REVIEW_REASON_CHARS 字元），缺了就拒絕並指出哪一項。 */
export function requireReviewReasons(by: "human" | "agent", review: unknown): void {
  if (by !== "agent") return;
  const missing = declaredReasons(review).filter((d) => d.reason.replace(/\s/g, "").length < MIN_REVIEW_REASON_CHARS).map((d) => d.key);
  if (missing.length === 0) return;
  throw new WorkItemActionError(`審查申報 ${missing.join("、")} 為 true，必須在 review.reasons 對應鍵附一句理由（去除空白後至少 ${MIN_REVIEW_REASON_CHARS} 個字元），讓使用者看得出為何被升級，例如 review.reasons.${missing[0]}="…"。判準見 work_item role_prompt roleId="reviewer"。`, { reason: "review-reason-missing", missingReasons: missing });
}

/** 申報理由的一行文字（只列為 true 或有附理由的項目）；沒有則為 undefined。 */
export function reviewReasonText(review: unknown): string | undefined {
  const parts = REVIEW_KEYS.flatMap((k) => (reasonOf(review, k) !== "" ? [`${k}＝${reasonOf(review, k)}`] : []));
  return parts.length > 0 ? parts.join("；") : undefined;
}

/** 把審查員申報（含理由）寫進理由，留下可稽核的紀錄。 */
export function withReviewNote(reason: string | undefined, by: "human" | "agent", review: unknown): string | undefined {
  if (by !== "agent" || typeof review !== "object" || review === null) return reason;
  const r = review as Record<string, unknown>;
  const why = reviewReasonText(review);
  const note = `審查申報 breaksExisting=${String(r.breaksExisting)}、reviewerUncertain=${String(r.reviewerUncertain)}、scopeSplit=${String(r.scopeSplit)}${why ? `；申報理由：${why}` : ""}`;
  return reason ? `${reason}（${note}）` : note;
}

/** 非關卡動作（例如 update_requirement）要求使用者原話：至少 MIN_HUMAN_QUOTE_CHARS 字元，且不可只是選項代號。 */
export function requireReasonQuote(subject: string, reason: string | undefined): void {
  if (isOptionCode(reason)) throw new WorkItemActionError(`${subject}：reason「${(reason ?? "").trim()}」只是選項代號（1～3 個英數字），不是使用者的原話。請引用使用者完整原話當 reason。`);
  if (hasEnoughChars(reason)) return;
  throw new WorkItemActionError(`${subject}必須附 reason：使用者要求修改的原話（去除空白後至少 ${MIN_HUMAN_QUOTE_CHARS} 個字元），不可自行編寫。`);
}
