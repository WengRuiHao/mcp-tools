import { computeSyncFlags, needsHumanReview, type ExternalChangeFlags, type SyncFlags, type TicketStatus } from "./pipeline-store.js";

export interface NextAction {
  summary: string;
  blockedBy: string[];
  suggestedTools: string[];
}

export interface NextActionContext {
  syncFlags?: SyncFlags;
  externalChanges?: ExternalChangeFlags;
  /** 專案的 SA/SD 設定；取不到就不帶，規格相關建議只會寫成「依專案設定」而不猜。 */
  sasd?: { sdMode: string; specOrder: string | null } | null;
}

interface Step {
  text: string;
  tools: string[];
  blockers?: string[];
}

const MAX_SUMMARY_LENGTH = 600;

function collectBlockers(status: TicketStatus, ctx: NextActionContext): string[] {
  const blockers: string[] = [];
  const ext = ctx.externalChanges;
  if (ext) {
    const files = [
      ext.analysis_externally_modified && "01",
      ext.implementation_externally_modified && "02",
      ext.verification_externally_modified && "03",
      ext.test_externally_modified && "04",
    ].filter(Boolean);
    if (files.length > 0) {
      blockers.push(`${files.join("/")} 被外部改過，summaries 與 sync_flags 可能過期：先 read_ticket_artifact 讀全文，確認後 resync_ticket_artifact`);
    }
  }
  const sync = ctx.syncFlags ?? computeSyncFlags(status);
  if (sync.analysis_stale) blockers.push("sync 債：01 在上次寫 02 之後又被改過，02 尚未對照最新 01（對照後重寫 02）");
  if (sync.implementation_stale) blockers.push("sync 債：02 在上次寫 03 之後又被改過，03 尚未對照最新 02（對照後重寫 03）");
  if (sync.verification_stale) blockers.push("sync 債：03 在上次寫 04 之後又被改過，04 尚未對照最新 03（對照後重寫 04）");
  if (status.human_requested_reanalysis) blockers.push("使用者要求優先重新確認：先對這張票呼叫 get_ticket_snapshot");
  return blockers;
}

function analystStep(status: TicketStatus): Step {
  const blockers: string[] = [];
  const tools = ["get_role_prompt({role:\"analyst\"})"];
  if (!status.sasd_checked) {
    blockers.push("尚未 record_sasd_check：write_ticket_artifact 會拒絕寫入 01-analysis.md");
    tools.push("record_sasd_check");
  }
  tools.push("write_ticket_artifact", "advance_ticket_stage");
  return {
    text: "分析師：寫 01-analysis.md（帶 summary；專案 gates.json 的分析關卡未過會被拒）後 advance_ticket_stage analyzed",
    tools,
    blockers,
  };
}

function engineerStep(status: TicketStatus, ctx: NextActionContext): Step {
  const tools = ["get_role_prompt({role:\"engineer\"})", "write_ticket_artifact", "advance_ticket_stage"];
  const base = "寫 02-implementation.md（必填 syncNote 與 manualActions）後 advance_ticket_stage implemented";
  if (status.stage !== "analyzed") return { text: `工程師：${base}`, tools };
  const sasd = ctx.sasd;
  if (!sasd) {
    return {
      text: `工程師：${base}。若專案 sdMode 為 self-generated，要依 specOrder 先走 sd_drafted（用 resolve_sasd_config 查）`,
      tools: [...tools, "resolve_sasd_config"],
    };
  }
  if (sasd.sdMode === "self-generated" && sasd.specOrder === "spec_first") {
    return {
      text: "規格撰寫者：先產 SD 草稿並 advance_ticket_stage sd_drafted，等使用者 record_spec_confirmation 後才能進工程師階段",
      tools: ["get_role_prompt({role:\"spec-writer\"})", "write_project_sd_doc", "advance_ticket_stage"],
    };
  }
  return { text: `工程師：${base}`, tools };
}

function sdDraftedStep(status: TicketStatus, ctx: NextActionContext): Step {
  const confirmation = status.spec_confirmation;
  if (confirmation === null) {
    const blocked = ctx.sasd?.specOrder === "spec_first" ? "implemented" : ctx.sasd?.specOrder === "code_first" ? "verified" : "implemented／verified";
    return {
      text: "規格草稿等使用者確認，不要自行推進",
      tools: [],
      blockers: [`spec_confirmation 為 null：advance_ticket_stage 推進到 ${blocked} 會被擋，要等使用者 record_spec_confirmation`],
    };
  }
  if (!confirmation.confirmed) {
    return {
      text: "規格草稿被打回：依 spec_confirmation.note 修改草稿，重新 advance_ticket_stage sd_drafted 送出（會清空這筆確認）",
      tools: ["get_role_prompt({role:\"spec-writer\"})", "write_project_sd_doc", "advance_ticket_stage"],
    };
  }
  const order = ctx.sasd?.specOrder;
  const implementedStep = "工程師寫 02-implementation.md 後 advance_ticket_stage implemented";
  const verifiedStep = "驗證師寫 03-verification.md 後 advance_ticket_stage verified";
  const text =
    order === "spec_first"
      ? `規格已確認：${implementedStep}`
      : order === "code_first"
        ? `規格已確認：${verifiedStep}`
        : `規格已確認：specOrder 為 spec_first 時${implementedStep}；code_first 時${verifiedStep}`;
  return { text, tools: ["write_ticket_artifact", "advance_ticket_stage"] };
}

/** code_first：工程師寫完後由規格撰寫者依實作反推 SD 草稿，確認前不能推進到 verified。 */
function codeFirstSpecStep(): Step {
  return {
    text: "規格撰寫者：依工程師實際改動反推 SD 草稿並 advance_ticket_stage sd_drafted，等使用者 record_spec_confirmation 後才能推進到 verified",
    tools: ["get_role_prompt({role:\"spec-writer\"})", "write_project_sd_doc", "advance_ticket_stage"],
  };
}

function verifierStep(): Step {
  return {
    text: "驗證師：比對規格與程式碼，寫 03-verification.md（必填 syncNote 與 manualActions）後 advance_ticket_stage verified 並帶 verdict；FAIL 必帶 rootCause（analysis|implementation）",
    tools: ["get_role_prompt({role:\"verifier\"})", "write_ticket_artifact", "advance_ticket_stage"],
  };
}

function testerStep(): Step {
  return {
    text: "測試工程師：寫 04-test.md（必填 syncNote 與 manualActions）後 advance_ticket_stage tested 並帶 verdict（只有 AI 有把握的 verified_fail 才算 FAIL）",
    tools: ["get_role_prompt({role:\"tester\"})", "get_test_engineer_guide", "write_ticket_artifact", "advance_ticket_stage"],
  };
}

function failBranchStep(status: TicketStatus): Step {
  if (status.verifier_root_cause === "analysis") {
    return {
      text: "verdict FAIL、根因在分析：回分析師重寫 01-analysis.md，之後重走 analyzed → implemented → verified → tested",
      tools: ["get_role_prompt({role:\"analyst\"})", "write_ticket_artifact", "advance_ticket_stage"],
    };
  }
  if (status.verifier_root_cause === "implementation") {
    return {
      text: "verdict FAIL、根因在實作：回工程師修正並重寫 02-implementation.md，advance_ticket_stage implemented，之後重走 verified → tested",
      tools: ["get_role_prompt({role:\"engineer\"})", "write_ticket_artifact", "advance_ticket_stage"],
    };
  }
  return { text: "verdict FAIL 但沒有 verifier_root_cause：先向使用者確認根因（分析或實作）再決定回哪個角色", tools: [] };
}

function testedStep(status: TicketStatus): Step {
  if (status.verdict === "FAIL") return failBranchStep(status);
  if (status.verdict === "PASS") {
    const confirmation = status.confirmation;
    if (confirmation === null) {
      return {
        text: "AI 這邊已全部通過，等使用者實測確認；AI 不可代為確認",
        tools: [],
        blockers: ["confirmation 為 null：要等使用者呼叫 record_confirmation({confirmed:true}) 才算結案"],
      };
    }
    if (confirmation.confirmed) return { text: "使用者已確認，這張票已結案，無需動作", tools: [] };
  }
  if (status.confirmation?.confirmed === false) {
    return {
      text: "使用者實測打回（見 confirmation.note）：比照 FAIL 分流，先判斷根因，在分析回分析師重寫 01-analysis.md，在實作回工程師修正並重寫 02-implementation.md，之後重走驗證師 → 測試工程師",
      tools: ["write_ticket_artifact", "advance_ticket_stage"],
    };
  }
  return { text: "尚未有 verdict：advance_ticket_stage tested 並帶 verdict", tools: ["advance_ticket_stage"] };
}

function stageStep(status: TicketStatus, ctx: NextActionContext): Step {
  switch (status.stage) {
    case "new":
      return { text: "呼叫 get_ticket_snapshot 抓票單原文並建立追蹤", tools: ["get_ticket_snapshot"] };
    case "snapshot":
      return status.project_dir
        ? { text: "advance_ticket_stage project_dir_confirmed", tools: ["advance_ticket_stage"] }
        : {
            text: "先確定 project_dir 再 advance_ticket_stage project_dir_confirmed",
            tools: ["resolve_project_dir", "advance_ticket_stage"],
            blockers: ["project_dir 為空：推進到 project_dir_confirmed 會被拒"],
          };
    case "project_dir_confirmed":
      return analystStep(status);
    case "analyzed":
      return engineerStep(status, ctx);
    case "sd_drafted":
      return sdDraftedStep(status, ctx);
    case "implemented":
      return ctx.sasd?.sdMode === "self-generated" && ctx.sasd.specOrder === "code_first" ? codeFirstSpecStep() : verifierStep();
    case "verified":
      if (status.verdict === "FAIL") return failBranchStep(status);
      return status.verdict === "PASS"
        ? testerStep()
        : { text: "03 已寫入但尚未判定：advance_ticket_stage verified 並帶 verdict", tools: ["advance_ticket_stage"] };
    case "tested":
      return testedStep(status);
  }
}

function countManualActions(status: TicketStatus): number {
  return status.implementation_manual_actions.length + status.verification_manual_actions.length + status.test_manual_actions.length;
}

/** 純函式：依票單狀態算出下一步與目前被什麼擋住。每條建議都對應 advance_ticket_stage／write_ticket_artifact／record_* 的實際檢查；不確定的就不說。 */
export function computeNextAction(status: TicketStatus, ctx: NextActionContext = {}): NextAction {
  const blockedBy = collectBlockers(status, ctx);
  let step: Step;

  if (needsHumanReview(status)) {
    blockedBy.push(`連續 FAIL ${status.consecutive_fail_count} 次（needs_human_review）：停下來問使用者，不要自動重跑`);
    step = { text: "停下來向使用者說明連續 FAIL 的狀況並等指示，不要自動重跑", tools: [] };
  } else if (status.needs_reanalysis) {
    blockedBy.push("Asana 內容已變（needs_reanalysis）：要從分析師重來");
    const analyst = analystStep(status);
    blockedBy.push(...(analyst.blockers ?? []));
    step = {
      text: "從分析師重來：重寫 01-analysis.md（會清掉 needs_reanalysis），再依序重走後續階段",
      tools: ["get_ticket_snapshot", ...analyst.tools],
    };
  } else {
    step = stageStep(status, ctx);
    blockedBy.push(...(step.blockers ?? []));
  }

  const parts: string[] = [];
  if (blockedBy.length > 0) parts.push(`有 ${blockedBy.length} 項需先處理（見 blockedBy）。`);
  parts.push(`目前 stage=${status.stage}${status.verdict ? `、verdict=${status.verdict}` : ""}。下一步：${step.text}。`);
  const manualCount = countManualActions(status);
  if (manualCount > 0) parts.push(`另有 ${manualCount} 項手動待辦等使用者處理（resolve_manual_action）。`);

  let summary = parts.join("");
  if (summary.length > MAX_SUMMARY_LENGTH) summary = `${summary.slice(0, MAX_SUMMARY_LENGTH - 1)}…`;
  return { summary, blockedBy, suggestedTools: Array.from(new Set(step.tools)) };
}
